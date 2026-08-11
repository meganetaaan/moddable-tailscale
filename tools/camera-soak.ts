import { createCameraRegistry, type DeviceSummary } from "./camera-server.ts";

const PROTOCOL_VERSION = 1;
const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_DEVICE_COUNT = 2;
const DEFAULT_FPS = 8;
const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;

type SoakOptions = {
  durationMs?: number;
  deviceCount?: number;
  fps?: number;
  progressIntervalMs?: number;
  log?: (message: string) => void;
};

export type CameraSoakResult = {
  durationMs: number;
  deviceCount: number;
  fps: number;
  devices: Array<{
    deviceId: string;
    online: boolean;
    desiredFps: number;
    sentFrames: number;
    receivedFrames: number;
    deliveryRatio: number;
    unexpectedCloses: number;
  }>;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(10);
  }
}

class VirtualCamera {
  readonly deviceId: string;
  readonly socket: WebSocket;
  fps = 0;
  sentFrames = 0;
  unexpectedCloses = 0;
  #closing = false;
  #frameTimer?: ReturnType<typeof setInterval>;

  constructor(baseURL: string, index: number) {
    this.deviceId = `virtual-camera-${String(index + 1).padStart(2, "0")}`;
    this.socket = new WebSocket(baseURL.replace(/^http/, "ws") + "/camera");
    this.socket.binaryType = "arraybuffer";
    this.socket.onmessage = (event) => this.#onMessage(event);
    this.socket.onclose = () => {
      this.#stopFrames();
      if (!this.#closing) this.unexpectedCloses += 1;
    };
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error(`${this.deviceId} failed to connect`)),
        { once: true },
      );
    });
    this.socket.send(JSON.stringify({
      type: "device.hello",
      protocol: PROTOCOL_VERSION,
      deviceId: this.deviceId,
      name: this.deviceId,
      model: "virtual-camera",
      firmware: "soak-test",
      capabilities: ["camera"],
      camera: { format: "jpeg", width: 240, height: 176, fps: 1 },
    }));
  }

  close(): void {
    this.#closing = true;
    this.#stopFrames();
    this.socket.close(1000, "soak complete");
  }

  #onMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== "command" || message.protocol !== PROTOCOL_VERSION) {
      return;
    }
    const payload = message.payload as Record<string, unknown> | undefined;
    if (message.command === "stream.set" && Number.isInteger(payload?.fps)) {
      this.#startFrames(payload!.fps as number);
      this.socket.send(JSON.stringify({
        type: "command.ack",
        protocol: PROTOCOL_VERSION,
        commandId: message.commandId,
        command: message.command,
        ok: true,
        result: { fps: this.fps },
      }));
    }
  }

  #startFrames(fps: number): void {
    this.#stopFrames();
    this.fps = fps;
    this.#frameTimer = setInterval(() => {
      if (
        this.socket.readyState !== WebSocket.OPEN ||
        this.socket.bufferedAmount > 1024 * 1024
      ) return;
      const sequence = this.sentFrames & 0xffff;
      this.socket.send(
        new Uint8Array([
          0xff,
          0xd8,
          sequence >> 8,
          sequence & 0xff,
          0xff,
          0xd9,
        ]),
      );
      this.sentFrames += 1;
    }, Math.round(1000 / fps));
  }

  #stopFrames(): void {
    if (this.#frameTimer !== undefined) {
      clearInterval(this.#frameTimer);
      this.#frameTimer = undefined;
    }
  }
}

type Viewer = { close: () => Promise<void> };

async function openDetailViewer(
  baseURL: string,
  deviceId: string,
): Promise<Viewer> {
  const abort = new AbortController();
  const response = await fetch(
    `${baseURL}/devices/${
      encodeURIComponent(deviceId)
    }/stream.mjpg?mode=detail`,
    { signal: abort.signal },
  );
  if (!response.ok || !response.body) {
    throw new Error(`${deviceId} detail viewer returned ${response.status}`);
  }
  const reader = response.body.getReader();
  const pump = (async () => {
    try {
      while (!(await reader.read()).done) {
        // Consume the MJPEG stream so viewer-side backpressure is realistic.
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }
    }
  })();
  return {
    async close() {
      abort.abort();
      await reader.cancel().catch(() => {});
      await pump.catch(() => {});
    },
  };
}

export async function runCameraSoak(
  options: SoakOptions = {},
): Promise<CameraSoakResult> {
  const durationMs = positiveInteger(
    options.durationMs ?? DEFAULT_DURATION_MS,
    "durationMs",
  );
  const deviceCount = positiveInteger(
    options.deviceCount ?? DEFAULT_DEVICE_COUNT,
    "deviceCount",
  );
  const fps = positiveInteger(options.fps ?? DEFAULT_FPS, "fps");
  if (fps > 8) throw new RangeError("fps must be between 1 and 8");
  const progressIntervalMs = positiveInteger(
    options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
    "progressIntervalMs",
  );
  const log = options.log ?? console.log;
  const registry = createCameraRegistry({ log() {} });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    registry.handler,
  );
  const address = server.addr as Deno.NetAddr;
  const baseURL = `http://127.0.0.1:${address.port}`;
  const cameras = Array.from(
    { length: deviceCount },
    (_, index) => new VirtualCamera(baseURL, index),
  );
  const viewers: Viewer[] = [];

  try {
    await Promise.all(cameras.map((camera) => camera.open()));
    await waitFor(
      () => registry.devices().length === deviceCount,
      "not all virtual cameras registered",
    );
    viewers.push(
      ...await Promise.all(
        cameras.map((camera) => openDetailViewer(baseURL, camera.deviceId)),
      ),
    );
    await waitFor(
      () => cameras.every((camera) => camera.fps === fps),
      `not all virtual cameras switched to ${fps}fps`,
    );

    const initial = new Map(
      registry.devices().map((device) => [device.deviceId, device.frameCount]),
    );
    const initialSent = new Map(
      cameras.map((camera) => [camera.deviceId, camera.sentFrames]),
    );
    const startedAt = Date.now();
    let elapsed = 0;
    while (elapsed < durationMs) {
      await delay(Math.min(progressIntervalMs, durationMs - elapsed));
      elapsed = Date.now() - startedAt;
      const summaries = registry.devices();
      log(JSON.stringify({
        type: "soak.progress",
        elapsedMs: Math.min(elapsed, durationMs),
        devices: summaries.map((device) => ({
          deviceId: device.deviceId,
          online: device.online,
          frameCount: device.frameCount - (initial.get(device.deviceId) ?? 0),
          desiredFps: device.desiredFps,
        })),
      }));
    }

    const summaries = new Map(
      registry.devices().map((device) => [device.deviceId, device]),
    );
    const devices = cameras.map((camera) => {
      const summary = summaries.get(camera.deviceId) as DeviceSummary;
      const sentFrames = camera.sentFrames -
        (initialSent.get(camera.deviceId) ?? 0);
      const receivedFrames = summary.frameCount -
        (initial.get(camera.deviceId) ?? 0);
      return {
        deviceId: camera.deviceId,
        online: summary.online,
        desiredFps: summary.desiredFps,
        sentFrames,
        receivedFrames,
        deliveryRatio: sentFrames ? receivedFrames / sentFrames : 0,
        unexpectedCloses: camera.unexpectedCloses,
      };
    });
    const result = { durationMs, deviceCount, fps, devices };
    assertCameraSoak(result);
    return result;
  } finally {
    await Promise.all(viewers.map((viewer) => viewer.close()));
    cameras.forEach((camera) => camera.close());
    registry.close();
    await server.shutdown();
  }
}

export function assertCameraSoak(result: CameraSoakResult): void {
  const minimumFrames = Math.floor(
    result.durationMs * result.fps / 1000 * 0.85,
  );
  for (const device of result.devices) {
    if (!device.online) throw new Error(`${device.deviceId} went offline`);
    if (device.desiredFps !== result.fps) {
      throw new Error(`${device.deviceId} ended at ${device.desiredFps}fps`);
    }
    if (device.unexpectedCloses) {
      throw new Error(`${device.deviceId} disconnected unexpectedly`);
    }
    if (device.sentFrames < minimumFrames) {
      throw new Error(
        `${device.deviceId} sent ${device.sentFrames}; expected at least ${minimumFrames}`,
      );
    }
    if (device.deliveryRatio < 0.98) {
      throw new Error(
        `${device.deviceId} delivered only ${
          (device.deliveryRatio * 100).toFixed(2)
        }%`,
      );
    }
  }
}

function argument(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const value = Deno.args.find((item) => item.startsWith(prefix));
  return value ? Number(value.slice(prefix.length)) : fallback;
}

if (import.meta.main) {
  const result = await runCameraSoak({
    durationMs: argument("duration-seconds", DEFAULT_DURATION_MS / 1000) * 1000,
    deviceCount: argument("devices", DEFAULT_DEVICE_COUNT),
    fps: argument("fps", DEFAULT_FPS),
  });
  console.log(JSON.stringify({ type: "soak.complete", ...result }, null, 2));
}

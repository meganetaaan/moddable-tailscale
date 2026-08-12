const DEFAULT_PORT = 8080;
const DEFAULT_HOSTNAME = "0.0.0.0";
const CAMERA_PATH = "/camera";
const BOUNDARY = "stackchan-camera-frame";
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_COMMAND_HISTORY = 20;
const PROTOCOL_VERSION = 1;
const PERSISTENCE_VERSION = 1;
const DEFAULT_PERSISTENCE_DELAY_MS = 1_000;
const VIEWER_FPS = Object.freeze({ none: 1, grid: 2, detail: 8 });
const encoder = new TextEncoder();
const QR_CODE_CLIENT_PATH = new URL("./vendor/qrcode.js", import.meta.url);

export type DeviceHello = {
  type: "device.hello";
  protocol: 1;
  deviceId: string;
  name: string;
  model: string;
  firmware: string;
  capabilities: string[];
  camera: {
    format: "jpeg";
    width: number;
    height: number;
    fps: number;
  };
};

export type DeviceCommandName =
  | "stream.set"
  | "device.identify"
  | "tts.speak"
  | "panTilt.move";

type DeviceCommand = {
  type: "command";
  protocol: 1;
  commandId: string;
  command: DeviceCommandName;
  payload: Record<string, unknown>;
};

type CommandAck = {
  type: "command.ack";
  protocol: 1;
  commandId: string;
  command: DeviceCommandName;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message: string };
};

type CommandHistory = {
  commandId: string;
  command: DeviceCommandName;
  source: "viewer" | "api";
  status: "pending" | "ok" | "error";
  sentAt: string;
  acknowledgedAt: string | null;
  result?: unknown;
  error?: CommandAck["error"];
};

type ViewerMode = "grid" | "detail";

type Viewer = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  mode: ViewerMode;
};

type DeviceRecord = {
  deviceId: string;
  hello: DeviceHello;
  socket?: WebSocket;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastSeenAt: string;
  latestFrame?: Uint8Array;
  frameCount: number;
  lastFrameAt: string | null;
  lastFrameBytes: number;
  viewers: Set<Viewer>;
  desiredFps: number;
  requestedFps?: number;
  commands: CommandHistory[];
};

export type DeviceSummary = {
  deviceId: string;
  name: string;
  model: string;
  firmware: string;
  capabilities: string[];
  camera: DeviceHello["camera"];
  online: boolean;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastSeenAt: string;
  frameCount: number;
  lastFrameAt: string | null;
  lastFrameBytes: number;
  hasFrame: boolean;
  viewers: { grid: number; detail: number; total: number };
  desiredFps: number;
  commands: CommandHistory[];
};

export type CameraRegistry = {
  handler: (request: Request) => Response | Promise<Response>;
  devices: () => DeviceSummary[];
  flush: () => void;
  close: () => void;
};

export type CameraRegistryOptions = {
  log?: (message: string) => void;
  stateDirectory?: string;
  persistenceDelayMs?: number;
};

type PersistedDevice = {
  deviceId: string;
  hello: DeviceHello;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastSeenAt: string;
  frameCount: number;
  lastFrameAt: string | null;
  lastFrameBytes: number;
  commands: CommandHistory[];
};

export function createCameraRegistry(
  options: CameraRegistryOptions = {},
): CameraRegistry {
  const log = options.log ?? console.log;
  const stateDirectory = options.stateDirectory
    ? normalizeDirectory(options.stateDirectory)
    : undefined;
  const persistenceDelayMs = options.persistenceDelayMs ??
    DEFAULT_PERSISTENCE_DELAY_MS;
  if (!Number.isFinite(persistenceDelayMs) || persistenceDelayMs < 0) {
    throw new RangeError("persistenceDelayMs must be zero or greater");
  }
  const registry = new Map<string, DeviceRecord>();
  const dirtyFrames = new Set<string>();
  let stateDirty = false;
  let persistenceTimer: ReturnType<typeof setTimeout> | undefined;

  function schedulePersistence(): void {
    if (!stateDirectory || persistenceTimer !== undefined) return;
    persistenceTimer = setTimeout(() => {
      persistenceTimer = undefined;
      try {
        flush();
      } catch (error) {
        log(`camera state persistence failed: ${errorMessage(error)}`);
        schedulePersistence();
      }
    }, persistenceDelayMs);
  }

  function markDirty(record?: DeviceRecord, frame = false): void {
    if (!stateDirectory) return;
    stateDirty = true;
    if (frame && record) dirtyFrames.add(record.deviceId);
    schedulePersistence();
  }

  function flush(): void {
    if (!stateDirectory || (!stateDirty && dirtyFrames.size === 0)) return;
    if (persistenceTimer !== undefined) {
      clearTimeout(persistenceTimer);
      persistenceTimer = undefined;
    }
    const framesDirectory = statePath(stateDirectory, "frames");
    Deno.mkdirSync(framesDirectory, { recursive: true });
    for (const deviceId of dirtyFrames) {
      const frame = registry.get(deviceId)?.latestFrame;
      if (frame) {
        atomicWriteFile(
          statePath(framesDirectory, `${deviceId}.jpg`),
          frame,
        );
      }
    }
    const persisted = {
      version: PERSISTENCE_VERSION,
      devices: [...registry.values()].map(persistDevice),
    };
    atomicWriteFile(
      statePath(stateDirectory, "registry.json"),
      encoder.encode(`${JSON.stringify(persisted, null, 2)}\n`),
    );
    dirtyFrames.clear();
    stateDirty = false;
  }

  function loadState(): void {
    if (!stateDirectory) return;
    const registryPath = statePath(stateDirectory, "registry.json");
    let raw: string;
    try {
      raw = Deno.readTextFileSync(registryPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      log(`camera state could not be read: ${errorMessage(error)}`);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        devices?: unknown;
      };
      if (
        parsed.version !== PERSISTENCE_VERSION ||
        !Array.isArray(parsed.devices)
      ) throw new Error("unsupported registry format");
      for (const value of parsed.devices) {
        const persisted = parsePersistedDevice(value);
        if (!persisted) {
          log("ignored an invalid persisted camera record");
          continue;
        }
        const record: DeviceRecord = {
          ...persisted,
          viewers: new Set(),
          desiredFps: VIEWER_FPS.none,
        };
        try {
          const frame = Deno.readFileSync(
            statePath(
              statePath(stateDirectory, "frames"),
              `${record.deviceId}.jpg`,
            ),
          );
          if (frame.byteLength <= MAX_FRAME_BYTES && isJpeg(frame)) {
            record.latestFrame = frame;
            record.lastFrameBytes = frame.byteLength;
          } else log(`ignored invalid persisted JPEG for ${record.deviceId}`);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            log(
              `persisted JPEG could not be read for ${record.deviceId}: ${
                errorMessage(error)
              }`,
            );
          }
        }
        registry.set(record.deviceId, record);
      }
      log(`restored ${registry.size} camera device(s) from ${stateDirectory}`);
    } catch (error) {
      log(`camera state is invalid: ${errorMessage(error)}`);
    }
  }

  function summarize(record: DeviceRecord): DeviceSummary {
    let grid = 0;
    let detail = 0;
    for (const viewer of record.viewers) {
      if (viewer.mode === "detail") detail += 1;
      else grid += 1;
    }
    return {
      deviceId: record.deviceId,
      name: record.hello.name,
      model: record.hello.model,
      firmware: record.hello.firmware,
      capabilities: [...record.hello.capabilities],
      camera: { ...record.hello.camera },
      online: record.socket?.readyState === WebSocket.OPEN,
      connectedAt: record.connectedAt,
      disconnectedAt: record.disconnectedAt,
      lastSeenAt: record.lastSeenAt,
      frameCount: record.frameCount,
      lastFrameAt: record.lastFrameAt,
      lastFrameBytes: record.lastFrameBytes,
      hasFrame: !!record.latestFrame,
      viewers: { grid, detail, total: grid + detail },
      desiredFps: record.desiredFps,
      commands: record.commands.map((entry) => ({ ...entry })),
    };
  }

  function devices(): DeviceSummary[] {
    return [...registry.values()].map(summarize).sort((a, b) =>
      a.deviceId.localeCompare(b.deviceId)
    );
  }

  function sendCommand(
    record: DeviceRecord,
    command: DeviceCommandName,
    payload: Record<string, unknown>,
    source: CommandHistory["source"],
  ): CommandHistory {
    if (record.socket?.readyState !== WebSocket.OPEN) {
      throw new Error(`device is offline: ${record.deviceId}`);
    }
    validateCommandPayload(command, payload);
    const message: DeviceCommand = {
      type: "command",
      protocol: PROTOCOL_VERSION,
      commandId: crypto.randomUUID(),
      command,
      payload,
    };
    const history: CommandHistory = {
      commandId: message.commandId,
      command,
      source,
      status: "pending",
      sentAt: new Date().toISOString(),
      acknowledgedAt: null,
    };
    record.commands.unshift(history);
    record.commands.length = Math.min(
      record.commands.length,
      MAX_COMMAND_HISTORY,
    );
    record.socket.send(JSON.stringify(message));
    markDirty();
    log(`command ${message.commandId} ${command} -> ${record.deviceId}`);
    return history;
  }

  function desiredViewerFps(record: DeviceRecord): number {
    for (const viewer of record.viewers) {
      if (viewer.mode === "detail") return VIEWER_FPS.detail;
    }
    return record.viewers.size ? VIEWER_FPS.grid : VIEWER_FPS.none;
  }

  function updateStreamRate(record: DeviceRecord): void {
    const fps = desiredViewerFps(record);
    record.desiredFps = fps;
    if (
      record.socket?.readyState !== WebSocket.OPEN ||
      record.requestedFps === fps
    ) return;
    record.requestedFps = fps;
    try {
      sendCommand(record, "stream.set", { fps }, "viewer");
    } catch (error) {
      record.requestedFps = undefined;
      log(`stream rate update failed for ${record.deviceId}: ${error}`);
    }
  }

  function publishFrame(record: DeviceRecord, frame: Uint8Array): void {
    if (!isJpeg(frame)) {
      log(
        `discarded invalid JPEG from ${record.deviceId} (${frame.byteLength} bytes)`,
      );
      return;
    }
    if (frame.byteLength > MAX_FRAME_BYTES) {
      log(
        `discarded oversized JPEG from ${record.deviceId} (${frame.byteLength} bytes)`,
      );
      return;
    }

    record.latestFrame = frame.slice();
    record.frameCount += 1;
    record.lastFrameAt = record.lastSeenAt = new Date().toISOString();
    record.lastFrameBytes = frame.byteLength;
    markDirty(record, true);
    const part = encodeMultipartFrame(record.latestFrame);
    let viewerRemoved = false;
    for (const viewer of record.viewers) {
      if ((viewer.controller.desiredSize ?? 0) <= 0) continue;
      try {
        viewer.controller.enqueue(part);
      } catch {
        record.viewers.delete(viewer);
        viewerRemoved = true;
      }
    }
    if (viewerRemoved) updateStreamRate(record);
  }

  function streamResponse(record: DeviceRecord, mode: ViewerMode): Response {
    let viewer: Viewer | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        viewer = { controller, mode };
        record.viewers.add(viewer);
        if (record.latestFrame) {
          controller.enqueue(encodeMultipartFrame(record.latestFrame));
        }
        updateStreamRate(record);
      },
      cancel() {
        if (viewer) record.viewers.delete(viewer);
        updateStreamRate(record);
      },
    });
    return new Response(body, {
      headers: {
        "cache-control": "no-store, no-cache, must-revalidate",
        "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "x-content-type-options": "nosniff",
      },
    });
  }

  function latestFrameResponse(record: DeviceRecord): Response {
    if (!record.latestFrame) return jsonError("frame not available", 404);
    return new Response(record.latestFrame.slice(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "image/jpeg",
        "x-content-type-options": "nosniff",
      },
    });
  }

  function acceptHello(socket: WebSocket, hello: DeviceHello): DeviceRecord {
    const now = new Date().toISOString();
    let record = registry.get(hello.deviceId);
    if (!record) {
      record = {
        deviceId: hello.deviceId,
        hello,
        connectedAt: now,
        disconnectedAt: null,
        lastSeenAt: now,
        frameCount: 0,
        lastFrameAt: null,
        lastFrameBytes: 0,
        viewers: new Set(),
        desiredFps: VIEWER_FPS.none,
        commands: [],
      };
      registry.set(hello.deviceId, record);
    } else {
      if (record.socket && record.socket !== socket) {
        record.socket.close(1012, "device reconnected");
      }
      record.hello = hello;
      record.connectedAt = now;
      record.disconnectedAt = null;
      record.lastSeenAt = now;
      record.requestedFps = undefined;
    }
    record.socket = socket;
    socket.send(JSON.stringify({
      type: "device.ready",
      protocol: PROTOCOL_VERSION,
      deviceId: record.deviceId,
    }));
    updateStreamRate(record);
    markDirty();
    log(`device online: ${record.deviceId} (${hello.model})`);
    return record;
  }

  function acceptAck(record: DeviceRecord, ack: CommandAck): void {
    const history = record.commands.find((entry) =>
      entry.commandId === ack.commandId && entry.command === ack.command
    );
    if (!history) {
      log(`unmatched command ack ${ack.commandId} from ${record.deviceId}`);
      return;
    }
    history.status = ack.ok ? "ok" : "error";
    history.acknowledgedAt = new Date().toISOString();
    history.result = ack.result;
    history.error = ack.error;
    record.lastSeenAt = history.acknowledgedAt;
    markDirty();
    log(`command ${ack.commandId} ${history.status} <- ${record.deviceId}`);
  }

  function upgradeCamera(request: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(request, {
      // Deno sends RFC 6455 ping control frames and closes peers that do not
      // return the protocol-level pong. Moddable's WebSocketClient responds
      // automatically, so no application heartbeat messages are required.
      idleTimeout: 30,
    });
    socket.binaryType = "arraybuffer";
    let record: DeviceRecord | undefined;

    socket.onmessage = async (event) => {
      if (typeof event.data === "string") {
        const hello = parseDeviceHello(event.data);
        if (hello) {
          if (record) {
            socket.close(1008, "device.hello already received");
            return;
          }
          record = acceptHello(socket, hello);
          return;
        }
        if (!record) {
          socket.close(1008, "device.hello required");
          return;
        }
        const ack = parseCommandAck(event.data);
        if (ack) acceptAck(record, ack);
        else logDeviceMessage(record.deviceId, event.data, log);
        return;
      }

      if (!record) {
        socket.close(1008, "device.hello required before frames");
        return;
      }
      const data = event.data instanceof Blob
        ? new Uint8Array(await event.data.arrayBuffer())
        : new Uint8Array(event.data);
      publishFrame(record, data);
    };
    socket.onerror = () => {
      if (record) log(`device WebSocket error: ${record.deviceId}`);
    };
    socket.onclose = () => {
      if (record?.socket === socket) {
        record.socket = undefined;
        record.requestedFps = undefined;
        record.disconnectedAt = record.lastSeenAt = new Date().toISOString();
        markDirty();
        log(`device offline: ${record.deviceId}`);
      }
    };
    return response;
  }

  async function commandResponse(
    request: Request,
    record: DeviceRecord,
  ): Promise<Response> {
    let body: { command?: unknown; payload?: unknown };
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid JSON", 400);
    }
    if (!isCommandName(body.command)) {
      return jsonError("unsupported command", 400);
    }
    if (!isObject(body.payload)) {
      return jsonError("payload must be an object", 400);
    }
    try {
      const history = sendCommand(record, body.command, body.payload, "api");
      return Response.json(history, { status: 202 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonError(
        message,
        message.startsWith("device is offline") ? 409 : 400,
      );
    }
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/provision") {
      return new Response(PROVISION_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/assets/qrcode.js") {
      return new Response(Deno.readTextFileSync(QR_CODE_CLIENT_PATH), {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }
    if (url.pathname === "/" || url.pathname.startsWith("/device/")) {
      return new Response(INDEX_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/devices" && request.method === "GET") {
      return Response.json(devices(), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/status" && request.method === "GET") {
      const all = devices();
      return Response.json({
        devices: all.length,
        online: all.filter((device) => device.online).length,
        viewers: all.reduce((total, device) => total + device.viewers.total, 0),
        frameCount: all.reduce((total, device) => total + device.frameCount, 0),
      }, { headers: { "cache-control": "no-store" } });
    }
    if (
      url.pathname === CAMERA_PATH &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) return upgradeCamera(request);

    const apiMatch = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (apiMatch && request.method === "GET") {
      const record = registry.get(decodeURIComponent(apiMatch[1]));
      return record
        ? Response.json(summarize(record), {
          headers: { "cache-control": "no-store" },
        })
        : jsonError("device not found", 404);
    }
    const commandMatch = url.pathname.match(
      /^\/api\/devices\/([^/]+)\/commands$/,
    );
    if (commandMatch && request.method === "POST") {
      const record = registry.get(decodeURIComponent(commandMatch[1]));
      return record
        ? await commandResponse(request, record)
        : jsonError("device not found", 404);
    }
    const streamMatch = url.pathname.match(
      /^\/devices\/([^/]+)\/stream\.mjpg$/,
    );
    if (streamMatch && request.method === "GET") {
      const record = registry.get(decodeURIComponent(streamMatch[1]));
      if (!record) return jsonError("device not found", 404);
      const mode = url.searchParams.get("mode") === "detail"
        ? "detail"
        : "grid";
      return streamResponse(record, mode);
    }
    const latestMatch = url.pathname.match(/^\/devices\/([^/]+)\/latest\.jpg$/);
    if (latestMatch && request.method === "GET") {
      const record = registry.get(decodeURIComponent(latestMatch[1]));
      return record
        ? latestFrameResponse(record)
        : jsonError("device not found", 404);
    }
    return new Response("Not found\n", { status: 404 });
  }

  function close(): void {
    for (const record of registry.values()) {
      if (record.socket?.readyState === WebSocket.OPEN) {
        const socket = record.socket;
        socket.close(1001, "hub shutting down");
        record.socket = undefined;
        record.requestedFps = undefined;
        record.disconnectedAt = record.lastSeenAt = new Date().toISOString();
        markDirty();
      }
    }
    try {
      flush();
    } catch (error) {
      log(`camera state shutdown flush failed: ${errorMessage(error)}`);
    }
  }

  loadState();
  return { handler, devices, flush, close };
}

function persistDevice(record: DeviceRecord): PersistedDevice {
  return {
    deviceId: record.deviceId,
    hello: record.hello,
    connectedAt: record.connectedAt,
    disconnectedAt: record.disconnectedAt,
    lastSeenAt: record.lastSeenAt,
    frameCount: record.frameCount,
    lastFrameAt: record.lastFrameAt,
    lastFrameBytes: record.lastFrameBytes,
    commands: record.commands,
  };
}

function parsePersistedDevice(value: unknown): PersistedDevice | undefined {
  if (!isObject(value)) return undefined;
  const hello = parseDeviceHello(JSON.stringify(value.hello));
  if (
    !hello || value.deviceId !== hello.deviceId ||
    !nullableTimestamp(value.connectedAt) ||
    !nullableTimestamp(value.disconnectedAt) ||
    !validTimestamp(value.lastSeenAt) ||
    !nonNegativeInteger(value.frameCount) ||
    !nullableTimestamp(value.lastFrameAt) ||
    !nonNegativeInteger(value.lastFrameBytes) ||
    !Array.isArray(value.commands)
  ) return undefined;
  const commands: CommandHistory[] = [];
  for (const persistedCommand of value.commands) {
    const command = parseCommandHistory(persistedCommand);
    if (command) commands.push(command);
  }
  return {
    deviceId: hello.deviceId,
    hello,
    connectedAt: value.connectedAt as string | null,
    disconnectedAt: value.disconnectedAt as string | null,
    lastSeenAt: value.lastSeenAt as string,
    frameCount: value.frameCount as number,
    lastFrameAt: value.lastFrameAt as string | null,
    lastFrameBytes: value.lastFrameBytes as number,
    commands,
  };
}

function parseCommandHistory(value: unknown): CommandHistory | undefined {
  if (
    !isObject(value) || typeof value.commandId !== "string" ||
    !isCommandName(value.command) ||
    (value.source !== "viewer" && value.source !== "api") ||
    (value.status !== "pending" && value.status !== "ok" &&
      value.status !== "error") ||
    !validTimestamp(value.sentAt) || !nullableTimestamp(value.acknowledgedAt)
  ) return undefined;
  if (
    value.error !== undefined &&
    (!isObject(value.error) || typeof value.error.message !== "string")
  ) return undefined;
  return value as CommandHistory;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || validTimestamp(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function normalizeDirectory(value: string): string {
  const directory = value.trim();
  if (!directory) throw new RangeError("stateDirectory must not be empty");
  return directory;
}

function statePath(directory: string, name: string): string {
  return /[\\/]$/.test(directory)
    ? `${directory}${name}`
    : `${directory}/${name}`;
}

function atomicWriteFile(path: string, data: Uint8Array): void {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    Deno.writeFileSync(temporaryPath, data);
    try {
      Deno.renameSync(temporaryPath, path);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      // Windows does not replace an existing destination with renameSync.
      Deno.removeSync(path);
      Deno.renameSync(temporaryPath, path);
    }
  } finally {
    try {
      Deno.removeSync(temporaryPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDeviceHello(value: string): DeviceHello | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<DeviceHello>;
    if (
      parsed.type !== "device.hello" || parsed.protocol !== PROTOCOL_VERSION ||
      typeof parsed.deviceId !== "string" ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(parsed.deviceId) ||
      typeof parsed.name !== "string" || parsed.name.length > 64 ||
      typeof parsed.model !== "string" || parsed.model.length > 64 ||
      typeof parsed.firmware !== "string" || parsed.firmware.length > 32 ||
      !Array.isArray(parsed.capabilities) ||
      !parsed.capabilities.every((item) =>
        typeof item === "string" && item.length <= 32
      ) || !isObject(parsed.camera)
    ) return undefined;
    const camera = parsed.camera as Partial<DeviceHello["camera"]>;
    if (
      camera.format !== "jpeg" || !positiveInteger(camera.width) ||
      !positiveInteger(camera.height) || !positiveInteger(camera.fps) ||
      (camera.fps ?? 0) > 30
    ) return undefined;
    return parsed as DeviceHello;
  } catch {
    return undefined;
  }
}

function parseCommandAck(value: string): CommandAck | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<CommandAck>;
    if (
      parsed.type !== "command.ack" || parsed.protocol !== PROTOCOL_VERSION ||
      typeof parsed.commandId !== "string" || parsed.commandId.length > 80 ||
      !isCommandName(parsed.command) || typeof parsed.ok !== "boolean"
    ) return undefined;
    if (
      parsed.error !== undefined &&
      (!isObject(parsed.error) || typeof parsed.error.message !== "string")
    ) return undefined;
    return parsed as CommandAck;
  } catch {
    return undefined;
  }
}

function isCommandName(value: unknown): value is DeviceCommandName {
  return value === "stream.set" || value === "device.identify" ||
    value === "tts.speak" || value === "panTilt.move";
}

function validateCommandPayload(
  command: DeviceCommandName,
  payload: Record<string, unknown>,
): void {
  if (command === "stream.set") {
    if (!positiveInteger(payload.fps) || (payload.fps as number) > 8) {
      throw new RangeError("stream.set fps must be between 1 and 8");
    }
  } else if (command === "device.identify") {
    const duration = payload.durationMs ?? 3000;
    if (!positiveInteger(duration) || (duration as number) > 30_000) {
      throw new RangeError("identify durationMs must be between 1 and 30000");
    }
  } else if (command === "tts.speak") {
    if (
      typeof payload.text !== "string" || !payload.text.length ||
      payload.text.length > 200
    ) throw new RangeError("tts.speak text must be 1 to 200 characters");
  } else {
    for (const axis of ["pan", "tilt"] as const) {
      const value = payload[axis];
      if (
        typeof value !== "number" || !Number.isFinite(value) ||
        Math.abs(value) > 90
      ) {
        throw new RangeError(`panTilt.move ${axis} must be between -90 and 90`);
      }
    }
  }
}

function logDeviceMessage(
  deviceId: string,
  value: string,
  log: (message: string) => void,
): void {
  try {
    const message = JSON.parse(value) as { type?: unknown; message?: unknown };
    if (message.type === "camera.error") {
      log(
        `${deviceId} camera error: ${
          String(message.message ?? "unknown error")
        }`,
      );
    }
  } catch {
    log(`${deviceId} message: ${value}`);
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJpeg(frame: Uint8Array): boolean {
  return frame.byteLength >= 4 && frame[0] === 0xff && frame[1] === 0xd8 &&
    frame[frame.byteLength - 2] === 0xff &&
    frame[frame.byteLength - 1] === 0xd9;
}

function encodeMultipartFrame(frame: Uint8Array): Uint8Array {
  const header = encoder.encode(
    `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n` +
      `Content-Length: ${frame.byteLength}\r\n\r\n`,
  );
  const part = new Uint8Array(header.byteLength + frame.byteLength + 2);
  part.set(header, 0);
  part.set(frame, header.byteLength);
  part[part.byteLength - 2] = 13;
  part[part.byteLength - 1] = 10;
  return part;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

const INDEX_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stack-chan Private Camera Hub</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #071019; color: #eaf3f9; }
    header { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px;
      align-items: center; justify-content: space-between; padding: 16px 24px;
      background: #0d1a27ee; border-bottom: 1px solid #20384b; backdrop-filter: blur(8px); }
    h1 { margin: 0; font-size: clamp(1.1rem, 3vw, 1.5rem); }
    main { width: min(1500px, 96vw); margin: 24px auto; }
    .summary, .meta, .muted { color: #9ab0bf; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 18px; }
    .card { overflow: hidden; border: 1px solid #20384b; border-radius: 14px;
      background: #0d1924; cursor: pointer; transition: transform .15s, border-color .15s; }
    .card:hover { transform: translateY(-2px); border-color: #3f88b9; }
    .frame { position: relative; aspect-ratio: 240 / 176; background: #020508; }
    .frame img { width: 100%; height: 100%; display: block; object-fit: contain; }
    .badge { position: absolute; top: 10px; left: 10px; padding: 4px 8px;
      border-radius: 999px; background: #263646df; font-size: .75rem; font-weight: 700; }
    .badge.online { background: #0b744fdf; }
    .body { padding: 13px 15px 16px; }
    .body h2 { margin: 0 0 6px; font-size: 1.05rem; }
    .detail { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 22px; }
    .detail .viewer { width: 100%; min-height: 320px; max-height: 75vh; object-fit: contain;
      background: #020508; border: 1px solid #20384b; border-radius: 14px; }
    .panel { padding: 18px; border: 1px solid #20384b; border-radius: 14px; background: #0d1924; }
    .panel h2, .panel h3 { margin-top: 0; }
    label { display: block; margin: 12px 0 5px; color: #b8cbd8; font-size: .85rem; }
    input, button { font: inherit; }
    input { width: 100%; padding: 10px; color: #eef8ff; background: #07111b;
      border: 1px solid #31516a; border-radius: 8px; }
    button, .back { display: inline-block; margin: 8px 6px 0 0; padding: 9px 12px;
      border: 1px solid #39729a; border-radius: 8px; background: #153a53; color: #eef8ff;
      text-decoration: none; cursor: pointer; }
    button:hover, .back:hover { background: #205372; }
    .pan-grid { display: grid; grid-template-columns: repeat(3, 1fr); max-width: 220px; }
    .pan-grid .up { grid-column: 2; } .pan-grid .left { grid-column: 1; }
    .commands { margin: 10px 0 0; padding: 0; list-style: none; font-size: .8rem; }
    .commands li { padding: 6px 0; border-top: 1px solid #20384b; }
    .ok { color: #49d79d; } .error { color: #ff7777; } .pending { color: #ffc45f; }
    @media (max-width: 800px) { .detail { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header><h1>Stack-chan Private Camera Hub</h1><div><a class="back" href="/provision">Device setup</a> <span id="summary" class="summary">読込中…</span></div></header>
  <main id="app"></main>
<script>
  const app = document.querySelector('#app');
  const summary = document.querySelector('#summary');
  const detailId = location.pathname.startsWith('/device/')
    ? decodeURIComponent(location.pathname.slice('/device/'.length)) : null;
  const cards = new Map();
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = value => value ? new Date(value).toLocaleString() : 'まだありません';
  async function api(path, options) {
    const response = await fetch(path, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || response.statusText);
    return body;
  }
  function frameURL(device, mode) {
    const id = encodeURIComponent(device.deviceId);
    return device.online
      ? '/devices/' + id + '/stream.mjpg?mode=' + mode
      : device.hasFrame ? '/devices/' + id + '/latest.jpg?t=' + encodeURIComponent(device.lastFrameAt || '') : '';
  }
  function updateSummary(devices) {
    summary.textContent = devices.filter(d => d.online).length + ' / ' + devices.length + ' online';
  }
  function createCard(device) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = '<div class="frame"><img alt="camera"><span class="badge"></span></div>' +
      '<div class="body"><h2></h2><div class="meta"></div></div>';
    card.onclick = () => location.href = '/device/' + encodeURIComponent(device.deviceId);
    app.querySelector('.grid').append(card);
    cards.set(device.deviceId, card);
    return card;
  }
  function updateCard(device) {
    const card = cards.get(device.deviceId) || createCard(device);
    const img = card.querySelector('img');
    const src = frameURL(device, 'grid');
    if (img.dataset.source !== src) { img.dataset.source = src; img.src = src; }
    const badge = card.querySelector('.badge');
    badge.textContent = device.online ? 'ONLINE · ' + device.desiredFps + 'fps' : 'OFFLINE';
    badge.className = 'badge' + (device.online ? ' online' : '');
    card.querySelector('h2').textContent = device.name || device.deviceId;
    card.querySelector('.meta').textContent = device.deviceId + ' · ' + device.frameCount + ' frames · ' + fmt(device.lastFrameAt);
  }
  async function updateGrid() {
    try {
      const devices = await api('/api/devices');
      updateSummary(devices);
      for (const device of devices) updateCard(device);
      for (const [id, card] of cards) if (!devices.some(d => d.deviceId === id)) { card.remove(); cards.delete(id); }
      document.querySelector('#empty').hidden = devices.length > 0;
    } catch (error) { summary.textContent = '取得エラー: ' + error.message; }
  }
  async function command(name, payload) {
    const target = document.querySelector('#command-result');
    try {
      const result = await api('/api/devices/' + encodeURIComponent(detailId) + '/commands', {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({command:name, payload:payload})
      });
      target.textContent = name + ' を送信しました (' + result.commandId.slice(0, 8) + ')';
      target.className = 'pending';
    } catch (error) { target.textContent = error.message; target.className = 'error'; }
  }
  function renderCommands(device) {
    const list = document.querySelector('#commands');
    list.innerHTML = device.commands.slice(0, 8).map(item =>
      '<li><span class="' + esc(item.status) + '">' + esc(item.status.toUpperCase()) + '</span> ' +
      esc(item.command) + ' · ' + esc(new Date(item.sentAt).toLocaleTimeString()) +
      (item.error ? '<br><span class="error">' + esc(item.error.message) + '</span>' : '') + '</li>'
    ).join('');
  }
  async function updateDetail() {
    try {
      const device = await api('/api/devices/' + encodeURIComponent(detailId));
      updateSummary([device]);
      document.querySelector('#title').textContent = device.name || device.deviceId;
      document.querySelector('#detail-status').textContent = (device.online ? 'ONLINE' : 'OFFLINE') +
        ' · ' + device.desiredFps + 'fps · ' + device.frameCount + ' frames · 最終 ' + fmt(device.lastFrameAt);
      const img = document.querySelector('#detail-image');
      const src = frameURL(device, 'detail');
      if (img.dataset.source !== src) { img.dataset.source = src; img.src = src; }
      renderCommands(device);
    } catch (error) { summary.textContent = '取得エラー: ' + error.message; }
  }
  if (detailId) {
    app.innerHTML = '<a class="back" href="/">← グリッドへ</a><div class="detail">' +
      '<section><h2 id="title">' + esc(detailId) + '</h2><img id="detail-image" class="viewer" alt="camera detail">' +
      '<p id="detail-status" class="meta"></p></section>' +
      '<aside class="panel"><h3>Device command</h3>' +
      '<button id="identify">画面で識別</button><label for="tts">TTS text</label>' +
      '<input id="tts" maxlength="200" placeholder="こんにちは"><button id="speak">読み上げ</button>' +
      '<label>Pan / tilt</label><div class="pan-grid"><button class="up" data-pan="0" data-tilt="15">↑</button>' +
      '<button class="left" data-pan="-15" data-tilt="0">←</button><button data-pan="0" data-tilt="0">中央</button>' +
      '<button data-pan="15" data-tilt="0">→</button><button class="up" data-pan="0" data-tilt="-15">↓</button></div>' +
      '<p id="command-result" class="muted"></p><h3>Recent acknowledgements</h3><ul id="commands" class="commands"></ul></aside></div>';
    document.querySelector('#identify').onclick = () => command('device.identify', {durationMs:3000});
    document.querySelector('#speak').onclick = () => command('tts.speak', {text:document.querySelector('#tts').value});
    document.querySelectorAll('[data-pan]').forEach(button => button.onclick = () => command('panTilt.move', {
      pan:Number(button.dataset.pan), tilt:Number(button.dataset.tilt)
    }));
    updateDetail(); setInterval(updateDetail, 1000);
  } else {
    app.innerHTML = '<p id="empty" class="muted">カメラの接続を待っています…</p><section class="grid"></section>';
    updateGrid(); setInterval(updateGrid, 1000);
  }
</script></body></html>`;

const PROVISION_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StackCam device setup</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  body { margin: 0; background: #071019; color: #edf6fb; }
  main { width: min(680px, 92vw); margin: 28px auto; }
  section { padding: 20px; border: 1px solid #29465c; border-radius: 14px; background: #0d1924; }
  label { display: block; margin-top: 14px; color: #afc4d2; }
  input { width: 100%; box-sizing: border-box; margin-top: 5px; padding: 10px; color: inherit;
    background: #071019; border: 1px solid #365d77; border-radius: 8px; }
  button, a { display: inline-block; margin: 14px 6px 0 0; padding: 10px 13px; color: inherit;
    background: #164566; border: 1px solid #4382aa; border-radius: 8px; text-decoration: none; cursor: pointer; }
  button:disabled { cursor: default; opacity: .45; }
  pre { min-height: 110px; padding: 12px; overflow: auto; white-space: pre-wrap; background: #03080c;
    border: 1px solid #20394c; border-radius: 8px; color: #9ed9bd; }
  .hint, .device { color: #9bb1c0; }
  .transport { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .transport strong { margin: 14px 0 0 6px; }
  details { margin-top: 16px; padding: 10px 12px; border: 1px solid #29465c; border-radius: 8px; }
  summary { cursor: pointer; color: #afc4d2; }
  input[type=checkbox] { width: auto; margin-right: 8px; }
  #auth-panel { margin: 18px 0 4px; padding: 14px; border: 1px solid #2a8f63; border-radius: 10px; background: #09251d; }
  #auth-panel[hidden] { display: none; }
  #auth-panel canvas { display: block; width: min(240px, 100%); height: auto; margin: 12px auto; background: white; image-rendering: pixelated; }
  small { display: block; margin-top: 6px; color: #8fa8b8; }
</style></head><body><main>
<a href="/">← Camera hub</a><h1>StackCam device setup</h1>
<p class="hint">M5CameraはUSBシリアル、CoreS3はUSBシリアルまたはBLEで設定できます。Web SerialはWindows版ChromeまたはEdgeで <code>http://localhost:8080/provision</code> を開いて使用してください。</p>
<p class="hint">BLEではWindowsの「Bluetoothとデバイス」で先に <code>StackCam-…</code> を追加し、CoreS3画面の6桁番号でペアリングします。</p>
<section>
  <div class="transport"><button id="serial-connect">USBシリアルで接続</button><button id="ble-connect">BLEで接続</button><button id="disconnect" disabled>切断</button><strong id="state">未接続</strong></div>
  <p id="device" class="device">デバイス情報は接続後に表示されます。</p>
  <div id="auth-panel" hidden><strong id="auth-state">Tailscaleへの登録が必要です</strong><canvas id="auth-qr"></canvas><a id="auth-open" target="_blank" rel="noopener">Tailscaleで認証</a></div>
  <label>Wi-Fi SSID<input id="ssid" autocomplete="off"></label>
  <label>Wi-Fi password<input id="password" type="password" autocomplete="new-password"><small>空欄の場合、現在の設定を変更しません。</small></label>
  <label>Hub URL<input id="hub" value="ws://stackchan-hub:8080/camera"></label>
  <details><summary>詳細設定（auth key）</summary><label>Tailscale auth key<input id="auth" type="password" autocomplete="off"><small>tag付き自動登録を使う場合だけ設定します。</small></label><label><input id="clear-auth" type="checkbox">保存済みauth keyを削除してAuthURL登録へ切り替える</label></details>
  <button id="save" disabled>保存して再起動</button><button id="read" disabled>状態を取得</button>
  <button id="restart" disabled>再起動</button><button id="clear" disabled>NVS設定を消去</button>
  <button id="tailnet-reset" disabled>Tailnet登録をやり直す</button>
  <pre id="log">ブラウザーから機密値を外部へ送信しません。</pre>
</section>
<script src="/assets/qrcode.js"></script><script>
  const SERVICE = '7a910001-6b8a-4d1f-9a3d-535441434b43';
  const RX = '7a910002-6b8a-4d1f-9a3d-535441434b43';
  const TX = '7a910003-6b8a-4d1f-9a3d-535441434b43';
  const PREFIX = '@stackchan ';
  const encoder = new TextEncoder();
  const log = document.querySelector('#log'); const state = document.querySelector('#state');
  const serialConnect = document.querySelector('#serial-connect'); const bleConnect = document.querySelector('#ble-connect');
  const disconnect = document.querySelector('#disconnect'); const deviceInfo = document.querySelector('#device');
  const ssid = document.querySelector('#ssid'); const password = document.querySelector('#password');
  const auth = document.querySelector('#auth'); const clearAuth = document.querySelector('#clear-auth'); const hub = document.querySelector('#hub');
  const authPanel = document.querySelector('#auth-panel'); const authState = document.querySelector('#auth-state');
  const authQR = document.querySelector('#auth-qr'); const authOpen = document.querySelector('#auth-open');
  let transport; let decoder = new TextDecoder(); let buffer = '';
  let bleDevice; let bleRX;
  let serialPort; let serialReader; let serialWriter; let serialReadTask;
  let expectedRestartUntil = 0; let serialReconnectTask;
  const pending = new Map();

  function append(value) { log.textContent += '\\n' + value; log.scrollTop = log.scrollHeight; }
  function errorText(error) { return error && error.message ? error.message : String(error); }
  function enabled(value) { for (const id of ['save','read','restart','clear','tailnet-reset']) document.querySelector('#'+id).disabled = !value; }
  function connecting(value) {
    state.textContent = value; serialConnect.disabled = true; bleConnect.disabled = true; disconnect.disabled = true; enabled(false);
  }
  function connected(value) {
    state.textContent = value; serialConnect.disabled = true; bleConnect.disabled = true; disconnect.disabled = false; enabled(true);
  }
  function disconnected(value = '未接続') {
    transport = undefined; state.textContent = value; serialConnect.disabled = false; bleConnect.disabled = false; disconnect.disabled = true; enabled(false);
  }
  function resetParser() { decoder = new TextDecoder(); buffer = ''; }
  function drawQR(url, packed) {
    let size; let isDark;
    if (packed && Number.isInteger(packed.size) && /^[0-9a-f]+$/i.test(packed.bits || '')) {
      const bytes = new Uint8Array(packed.bits.length >> 1);
      for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(packed.bits.slice(index * 2, index * 2 + 2), 16);
      size = packed.size; isDark = (row, column) => !!(bytes[(row * size + column) >> 3] & (0x80 >> ((row * size + column) & 7)));
    } else {
      if (typeof qrcode !== 'function') return false;
      const generated = qrcode(0, 'M'); generated.addData(url, 'Byte'); generated.make();
      size = generated.getModuleCount(); isDark = (row, column) => generated.isDark(row, column);
    }
    const quiet = 4; authQR.width = authQR.height = size + quiet * 2;
    const context = authQR.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, authQR.width, authQR.height); context.fillStyle = '#000';
    for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
      if (isDark(row, column)) context.fillRect(quiet + column, quiet + row, 1, 1);
    }
    return true;
  }
  function updateRuntime(runtime) {
    const tailnet = runtime && runtime.tailnet;
    if (!tailnet) return;
    if (tailnet.state === 'needs-auth' && tailnet.authURL) {
      authPanel.hidden = false; authState.textContent = 'Tailscaleへの登録が必要です';
      authOpen.hidden = false; authOpen.href = tailnet.authURL; authQR.hidden = !drawQR(tailnet.authURL, tailnet.authQR);
    } else if (tailnet.state === 'needs-approval') {
      authPanel.hidden = false; authState.textContent = 'Tailscale管理画面で端末を承認してください';
      authOpen.hidden = true; authQR.hidden = true;
    } else if (tailnet.state === 'connected') {
      authPanel.hidden = true; authOpen.removeAttribute('href'); authState.textContent = 'Tailnet接続済み';
    } else if (tailnet.state === 'error') {
      authPanel.hidden = false; authState.textContent = tailnet.error || 'Tailnetへの接続に失敗しました';
      authOpen.hidden = true; authQR.hidden = true;
    } else {
      authPanel.hidden = true; authOpen.removeAttribute('href'); authQR.hidden = true;
    }
  }
  function updateConfig(message) {
    const config = message && message.type === 'provision.ack' ? message.config : undefined;
    if (!config) return;
    ssid.value = config.wifi && config.wifi.ssid ? config.wifi.ssid : '';
    hub.value = config.hubURL || 'ws://stackchan-hub:8080/camera';
    password.value = ''; auth.value = ''; clearAuth.checked = false;
    password.placeholder = config.wifi && config.wifi.passwordSet ? '設定済み' : '未設定';
    auth.placeholder = config.tailscale && config.tailscale.authKeySet ? '設定済み' : '未設定';
    deviceInfo.textContent = (config.deviceName || 'StackCam') + ' · ' + (config.deviceId || '') + ' · ' + (config.persisted ? 'NVS設定' : 'ファームウェア初期値');
  }
  function acceptChunk(chunk) {
    buffer += decoder.decode(chunk, {stream:true});
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      let line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      const marker = line.indexOf(PREFIX);
      if (marker >= 0) line = line.slice(marker + PREFIX.length).trim();
      else if (!line.startsWith('{')) continue;
      if (!line) continue;
      append(line);
      try {
        const message = JSON.parse(line); updateConfig(message); updateRuntime(message.runtime);
        if (message.type === 'provision.ack' && message.requestId && pending.has(message.requestId)) {
          const request = pending.get(message.requestId); pending.delete(message.requestId); clearTimeout(request.timer);
          if (message.ok) request.resolve(message); else request.reject(new Error(message.error || 'デバイスが要求を拒否しました'));
        }
      } catch (error) { append('ERROR: 応答解析: ' + errorText(error)); }
    }
  }
  async function send(message) {
    const requestId = crypto.randomUUID(); const line = JSON.stringify({...message, requestId}) + '\\n';
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('デバイス応答がタイムアウトしました')); }, 10000);
      pending.set(requestId, {resolve, reject, timer});
    });
    try {
      if (transport === 'serial') {
        if (!serialWriter) throw new Error('USBシリアル未接続です');
        await serialWriter.write(encoder.encode(PREFIX + line));
      } else if (transport === 'ble') {
        if (!bleRX) throw new Error('BLE未接続です');
        const bytes = encoder.encode(line);
        for (let offset = 0; offset < bytes.length; offset += 180) await bleRX.writeValueWithResponse(bytes.slice(offset, offset + 180));
      } else throw new Error('デバイス未接続です');
    } catch (error) {
      const request = pending.get(requestId);
      if (request) { pending.delete(requestId); clearTimeout(request.timer); request.reject(error); }
    }
    return result;
  }
  async function readSerial(port) {
    const reader = port.readable.getReader(); serialReader = reader;
    try {
      while (serialPort === port) {
        const result = await reader.read();
        if (result.done) break;
        if (result.value) acceptChunk(result.value);
      }
    } catch (error) {
      if (serialPort === port) append('ERROR: USBシリアル受信: ' + errorText(error));
    } finally {
      if (serialReader === reader) serialReader = undefined;
      reader.releaseLock();
      if (serialPort === port) {
        const reconnect = Date.now() < expectedRestartUntil;
        const previousInfo = port.getInfo ? port.getInfo() : {};
        serialPort = undefined;
        try { serialWriter && serialWriter.releaseLock(); } catch {}
        serialWriter = undefined; serialReadTask = undefined;
        try { await port.close(); } catch {}
        if (reconnect) void reconnectSerial(previousInfo); else disconnected('切断');
      }
    }
  }
  async function closeSerial() {
    const port = serialPort;
    if (!port) return;
    serialPort = undefined;
    try { if (serialReader) await serialReader.cancel(); } catch {}
    try { if (serialReadTask) await serialReadTask; } catch {}
    try { serialWriter && serialWriter.releaseLock(); } catch {}
    serialReader = undefined; serialWriter = undefined; serialReadTask = undefined;
    try { await port.close(); } catch {}
  }
  async function closeBLE() {
    const device = bleDevice; bleDevice = undefined; bleRX = undefined;
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
  }
  function samePort(info, wanted) {
    return !wanted || ((wanted.usbVendorId === undefined || info.usbVendorId === wanted.usbVendorId) &&
      (wanted.usbProductId === undefined || info.usbProductId === wanted.usbProductId));
  }
  async function openSerial(port, reconnecting = false) {
    connecting(reconnecting ? 'USBシリアル再接続中…' : 'USBシリアル接続中…'); resetParser();
    await port.open({baudRate:115200, dataBits:8, stopBits:1, parity:'none', flowControl:'none', bufferSize:4096});
    serialPort = port;
    if (!port.readable || !port.writable) throw new Error('シリアル入出力を開けません');
    try { await port.setSignals({dataTerminalReady:false, requestToSend:false}); } catch (error) { append('WARN: 制御信号を設定できません: ' + errorText(error)); }
    serialWriter = port.writable.getWriter(); serialReadTask = readSerial(port); transport = 'serial';
    const info = port.getInfo ? port.getInfo() : {};
    const ids = info.usbVendorId === undefined ? '' : ' (' + info.usbVendorId.toString(16).padStart(4,'0') + ':' + info.usbProductId.toString(16).padStart(4,'0') + ')';
    connected('USBシリアル接続済み' + ids); append(reconnecting ? 'USBシリアルへ再接続しました。' : 'USBシリアルを115200 baudで開きました。');
    await new Promise(resolve => setTimeout(resolve, 2500));
    await send({type:'provision.get'}); expectedRestartUntil = 0;
  }
  async function reconnectSerial(previousInfo) {
    if (serialReconnectTask) return serialReconnectTask;
    serialReconnectTask = (async () => {
      while (!serialPort && Date.now() < expectedRestartUntil) {
        connecting('USBシリアル再接続中…');
        const ports = await navigator.serial.getPorts();
        for (const port of ports) {
          if (!samePort(port.getInfo ? port.getInfo() : {}, previousInfo)) continue;
          try { await openSerial(port, true); return; } catch { await closeSerial(); }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!serialPort) disconnected('自動再接続失敗');
    })().finally(() => { serialReconnectTask = undefined; });
    return serialReconnectTask;
  }
  async function requestRestart(type = 'provision.restart') {
    expectedRestartUntil = Date.now() + 30000;
    const response = await send({type});
    setTimeout(() => {
      if (transport === 'serial' && serialWriter)
        send({type:'provision.get'}).then(() => { expectedRestartUntil = 0; }).catch(() => {});
    }, 3500);
    return response;
  }
  serialConnect.onclick = async () => {
    try {
      if (!isSecureContext) throw new Error('Web SerialにはlocalhostまたはHTTPSが必要です');
      if (!navigator.serial) throw new Error('Web Serial非対応です。Windows版ChromeまたはEdgeを使用してください');
      const port = await navigator.serial.requestPort();
      await openSerial(port);
    } catch (error) {
      await closeSerial();
      if (error && error.name === 'NotFoundError') append('USBデバイスの選択をキャンセルしました。');
      else {
        append('ERROR: ' + errorText(error));
        append('HINT: WSL、シリアルモニター、書き込みツールがCOMポートを使用していないか確認してください。');
      }
      disconnected('接続失敗');
    }
  };
  bleConnect.onclick = async () => {
    try {
      if (!navigator.bluetooth) throw new Error('Web Bluetooth非対応です。Windows版ChromeまたはEdgeでlocalhostを開いてください');
      const device = await navigator.bluetooth.requestDevice({filters:[{services:[SERVICE]}]});
      connecting('BLE接続中…'); resetParser(); bleDevice = device;
      const server = await device.gatt.connect(); const service = await server.getPrimaryService(SERVICE);
      bleRX = await service.getCharacteristic(RX); const tx = await service.getCharacteristic(TX);
      await tx.startNotifications();
      tx.addEventListener('characteristicvaluechanged', event => acceptChunk(new Uint8Array(event.target.value.buffer, event.target.value.byteOffset, event.target.value.byteLength)));
      device.addEventListener('gattserverdisconnected', () => {
        if (bleDevice === device) { bleDevice = undefined; bleRX = undefined; disconnected('切断'); }
      });
      transport = 'ble'; connected((device.name || 'StackCam') + ' BLE接続済み'); await send({type:'provision.get'});
    } catch (error) {
      await closeBLE(); append('ERROR: ' + errorText(error));
      if (/GATT Server is disconnected|retrieve services/i.test(errorText(error)))
        append('HINT: Windowsの「Bluetoothとデバイス」でStackCamを先にペアリングし、CoreS3を再起動してから再接続してください。');
      disconnected('接続失敗');
    }
  };
  disconnect.onclick = async () => {
    expectedRestartUntil = 0; const active = transport; transport = undefined; enabled(false);
    if (active === 'serial') await closeSerial();
    else if (active === 'ble') await closeBLE();
    disconnected();
  };
  document.querySelector('#save').onclick = async () => {
    try {
      const wifi = {ssid:ssid.value}; const tailscale = {}; const config = {wifi, hubURL:hub.value};
      if (password.value) wifi.password = password.value;
      if (clearAuth.checked) { tailscale.authKey = null; config.tailscale = tailscale; }
      else if (auth.value) { tailscale.authKey = auth.value; config.tailscale = tailscale; }
      await send({type:'provision.set', config});
      append('設定を保存しました。再起動します。');
      await requestRestart();
    } catch (error) { append('ERROR: ' + errorText(error)); }
  };
  document.querySelector('#read').onclick = () => send({type:'provision.get'}).catch(error => append('ERROR: ' + errorText(error)));
  document.querySelector('#restart').onclick = () => requestRestart().catch(error => append('ERROR: ' + errorText(error)));
  document.querySelector('#clear').onclick = () => {
    if (confirm('保存済みNVS設定を消去し、ファームウェア初期値へ戻しますか？'))
      send({type:'provision.clear'}).catch(error => append('ERROR: ' + errorText(error)));
  };
  document.querySelector('#tailnet-reset').onclick = () => {
    if (confirm('Tailnet identityと保存済みauth keyを消去して再登録します。管理画面の旧端末はofflineのまま残る場合があります。続行しますか？'))
      requestRestart('provision.tailnet.reset').catch(error => append('ERROR: ' + errorText(error)));
  };
  if (!isSecureContext || !navigator.serial) serialConnect.title = 'Web SerialにはWindows版Chrome/EdgeのlocalhostまたはHTTPSが必要です';
</script></main></body></html>`;

function parsePort(value: string | undefined): number {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("port must be between 1 and 65535");
  }
  return port;
}

function parseCommandLine(args: string[]): {
  port: number;
  hostname: string;
  stateDirectory?: string;
} {
  const positional: string[] = [];
  let stateDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--state-dir") {
      stateDirectory = args[++index];
      if (!stateDirectory) throw new Error("--state-dir requires a path");
    } else if (argument.startsWith("--state-dir=")) {
      stateDirectory = argument.slice("--state-dir=".length);
      if (!stateDirectory) throw new Error("--state-dir requires a path");
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else positional.push(argument);
  }
  if (positional.length > 2) throw new Error("too many positional arguments");
  return {
    port: parsePort(positional[0]),
    hostname: positional[1] ?? DEFAULT_HOSTNAME,
    stateDirectory,
  };
}

if (import.meta.main) {
  const { port, hostname, stateDirectory } = parseCommandLine(Deno.args);
  const registry = createCameraRegistry({ stateDirectory });
  const hostnames = [hostname];
  if (
    hostname !== "0.0.0.0" && hostname !== "::" &&
    hostname !== "127.0.0.1" && hostname !== "::1" &&
    hostname.toLowerCase() !== "localhost"
  ) hostnames.push("127.0.0.1");

  const servers: ReturnType<typeof Deno.serve>[] = [];
  for (const bindAddress of hostnames) {
    console.log(
      `Device WebSocket: ws://${bindAddress}:${port}${CAMERA_PATH}`,
    );
    console.log(`Camera dashboard: http://${bindAddress}:${port}/`);
    servers.push(Deno.serve({ hostname: bindAddress, port }, registry.handler));
  }
  if (stateDirectory) console.log(`Camera state: ${stateDirectory}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    registry.close();
    await Promise.all(servers.map((server) => server.shutdown()));
  };
  Deno.addSignalListener("SIGINT", () => void shutdown());
  if (Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGTERM", () => void shutdown());
  }
}

import {
  type CameraRegistry,
  type CameraRegistryOptions,
  createCameraRegistry,
} from "./camera-server.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type JsonMessage = Record<string, unknown>;

class WebSocketInbox {
  socket: WebSocket;
  #messages: JsonMessage[] = [];
  #waiters: Array<{
    predicate: (message: JsonMessage) => boolean;
    resolve: (message: JsonMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as JsonMessage;
      const index = this.#waiters.findIndex((waiter) =>
        waiter.predicate(message)
      );
      if (index >= 0) {
        const [waiter] = this.#waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else this.#messages.push(message);
    };
  }

  opened(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error("WebSocket failed to open"));
    });
  }

  next(
    predicate: (message: JsonMessage) => boolean,
    timeout = 2000,
  ): Promise<JsonMessage> {
    const index = this.#messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) =>
          waiter.timer === timer
        );
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("timed out waiting for WebSocket message"));
      }, timeout);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }
}

function hello(deviceId: string): JsonMessage {
  return {
    type: "device.hello",
    protocol: 1,
    deviceId,
    name: deviceId,
    model: "m5stack-cores3",
    firmware: "1.0.0",
    capabilities: ["camera", "display"],
    camera: { format: "jpeg", width: 240, height: 176, fps: 1 },
  };
}

async function connectDevice(baseURL: string, deviceId: string) {
  const inbox = new WebSocketInbox(baseURL.replace("http", "ws") + "/camera");
  await inbox.opened();
  inbox.socket.send(JSON.stringify(hello(deviceId)));
  await inbox.next((message) => message.type === "device.ready");
  const initialRate = await inbox.next((message) =>
    message.type === "command" && message.command === "stream.set"
  );
  assert(
    (initialRate.payload as JsonMessage).fps === 1,
    "newly connected device was not set to 1fps",
  );
  return inbox;
}

async function withServer(
  run: (baseURL: string, registry: CameraRegistry) => Promise<void>,
  options: CameraRegistryOptions = {},
): Promise<void> {
  const registry = createCameraRegistry({ log() {}, ...options });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    registry.handler,
  );
  const address = server.addr as Deno.NetAddr;
  try {
    await run(`http://127.0.0.1:${address.port}`, registry);
  } finally {
    registry.close();
    await server.shutdown();
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
const SECOND_JPEG = new Uint8Array([0xff, 0xd8, 0x03, 0x04, 0xff, 0xd9]);

Deno.test("serves syntactically valid BLE provisioning JavaScript", async () => {
  await withServer(async (baseURL) => {
    const response = await fetch(`${baseURL}/provision`);
    assert(response.ok, "BLE provisioning page did not return 200");
    const html = await response.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert(script, "BLE provisioning script is missing");
    new Function(script);
    assert(
      script.includes("JSON.stringify") && script.includes("requestDevice") &&
        script.includes("navigator.bluetooth") &&
        html.includes("Bluetoothとデバイス"),
      "BLE provisioning logic is incomplete",
    );
  });
});

Deno.test("registers multiple devices and isolates their MJPEG streams", async () => {
  await withServer(async (baseURL) => {
    const first = await connectDevice(baseURL, "cores3-aabbcc000001");
    const second = await connectDevice(baseURL, "cores3-aabbcc000002");
    let response: Response | undefined;
    try {
      response = await fetch(
        `${baseURL}/devices/cores3-aabbcc000001/stream.mjpg?mode=grid`,
      );
      assert(response.ok, "MJPEG endpoint did not return 200");
      await first.next((message) =>
        message.command === "stream.set" &&
        (message.payload as JsonMessage).fps === 2
      );

      second.socket.send(new Uint8Array([0xff, 0xd8, 0x03, 0xff, 0xd9]));
      first.socket.send(JPEG);
      const reader = response.body?.getReader();
      assert(reader, "MJPEG response body is missing");
      const { value, done } = await reader.read();
      assert(!done && value, "MJPEG stream ended before a frame arrived");
      const text = new TextDecoder().decode(value);
      assert(
        text.includes("Content-Type: image/jpeg"),
        "MJPEG header is missing",
      );
      assert(
        text.includes("Content-Length: 6"),
        "wrong camera frame was relayed",
      );
      await reader.cancel();

      const devices = await fetch(`${baseURL}/api/devices`).then((result) =>
        result.json()
      );
      assert(devices.length === 2, "registry did not retain both devices");
      assert(
        devices[0].deviceId !== devices[1].deviceId,
        "device IDs collided",
      );
    } finally {
      first.socket.close();
      second.socket.close();
      await response?.body?.cancel().catch(() => {});
    }
  });
});

Deno.test("rejects a second device identity on the same socket", async () => {
  await withServer(async (baseURL) => {
    const device = await connectDevice(baseURL, "cores3-aabbcc000006");
    try {
      const closed = new Promise<CloseEvent>((resolve) => {
        device.socket.onclose = resolve;
      });
      device.socket.send(JSON.stringify(hello("cores3-aabbcc000007")));
      const event = await closed;
      assert(event.code === 1008, "identity change did not violate policy");

      const devices = await fetch(`${baseURL}/api/devices`).then((result) =>
        result.json()
      );
      assert(devices.length === 1, "second identity polluted the registry");
      assert(
        devices[0].deviceId === "cores3-aabbcc000006",
        "original identity was replaced",
      );
    } finally {
      device.socket.close();
    }
  });
});

Deno.test("switches 1fps -> 2fps -> 8fps from viewer demand", async () => {
  await withServer(async (baseURL) => {
    const device = await connectDevice(baseURL, "cores3-aabbcc000003");
    const grid = await fetch(
      `${baseURL}/devices/cores3-aabbcc000003/stream.mjpg?mode=grid`,
    );
    try {
      await device.next((message) =>
        message.command === "stream.set" &&
        (message.payload as JsonMessage).fps === 2
      );
      const detail = await fetch(
        `${baseURL}/devices/cores3-aabbcc000003/stream.mjpg?mode=detail`,
      );
      await device.next((message) =>
        message.command === "stream.set" &&
        (message.payload as JsonMessage).fps === 8
      );
      await detail.body?.cancel();
      await device.next((message) =>
        message.command === "stream.set" &&
        (message.payload as JsonMessage).fps === 2
      );
      await grid.body?.cancel();
      await device.next((message) =>
        message.command === "stream.set" &&
        (message.payload as JsonMessage).fps === 1
      );
    } finally {
      device.socket.close();
      await grid.body?.cancel().catch(() => {});
    }
  });
});

Deno.test("relays commands and records command acknowledgements", async () => {
  await withServer(async (baseURL) => {
    const deviceId = "cores3-aabbcc000004";
    const device = await connectDevice(baseURL, deviceId);
    try {
      const response = await fetch(
        `${baseURL}/api/devices/${deviceId}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            command: "device.identify",
            payload: { durationMs: 3000 },
          }),
        },
      );
      assert(response.status === 202, "command API did not accept the command");
      const command = await device.next((message) =>
        message.command === "device.identify"
      );
      device.socket.send(JSON.stringify({
        type: "command.ack",
        protocol: 1,
        commandId: command.commandId,
        command: command.command,
        ok: true,
        result: { displayed: true },
      }));

      let detail;
      for (let attempt = 0; attempt < 20; attempt++) {
        detail = await fetch(`${baseURL}/api/devices/${deviceId}`).then((
          result,
        ) => result.json());
        if (
          detail.commands.some((entry: JsonMessage) => entry.status === "ok")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(
        detail.commands.some((entry: JsonMessage) =>
          entry.commandId === command.commandId && entry.status === "ok"
        ),
        "command acknowledgement was not recorded",
      );

      const invalid = await fetch(
        `${baseURL}/api/devices/${deviceId}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "tts.speak", payload: { text: "" } }),
        },
      );
      assert(invalid.status === 400, "invalid command payload was accepted");
    } finally {
      device.socket.close();
    }
  });
});

Deno.test("keeps the final image and marks disconnected devices offline", async () => {
  await withServer(async (baseURL) => {
    const deviceId = "cores3-aabbcc000005";
    const device = await connectDevice(baseURL, deviceId);
    device.socket.send(JPEG);
    for (let attempt = 0; attempt < 20; attempt++) {
      const detail = await fetch(`${baseURL}/api/devices/${deviceId}`).then((
        result,
      ) => result.json());
      if (detail.hasFrame) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    device.socket.close();
    for (let attempt = 0; attempt < 20; attempt++) {
      const detail = await fetch(`${baseURL}/api/devices/${deviceId}`).then((
        result,
      ) => result.json());
      if (!detail.online) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const detail = await fetch(`${baseURL}/api/devices/${deviceId}`).then((
      result,
    ) => result.json());
    assert(!detail.online, "disconnected device is still online");
    assert(detail.hasFrame, "last-frame flag was lost");
    const latest = await fetch(`${baseURL}/devices/${deviceId}/latest.jpg`);
    assert(latest.ok, "last image is unavailable");
    assert(
      new Uint8Array(await latest.arrayBuffer()).byteLength === JPEG.byteLength,
      "last image contents changed",
    );
  });
});

Deno.test("restores device metadata and the final JPEG after a hub restart", async () => {
  const stateDirectory = await Deno.makeTempDir({
    prefix: "stackchan-camera-state-",
  });
  const deviceId = "cores3-aabbcc000007";
  try {
    await withServer(async (baseURL, registry) => {
      const device = await connectDevice(baseURL, deviceId);
      try {
        device.socket.send(JPEG);
        let firstFrameAccepted = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          const detail = await fetch(`${baseURL}/api/devices/${deviceId}`).then(
            (result) => result.json(),
          );
          if (detail.frameCount === 1) {
            firstFrameAccepted = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(firstFrameAccepted, "first frame was not accepted");
        registry.flush();
        device.socket.send(SECOND_JPEG);
        for (let attempt = 0; attempt < 20; attempt++) {
          const detail = await fetch(`${baseURL}/api/devices/${deviceId}`).then(
            (result) => result.json(),
          );
          if (detail.frameCount === 2) {
            registry.flush();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(
          "second frame was not accepted before persistence flush",
        );
      } finally {
        device.socket.close();
      }
    }, { stateDirectory, persistenceDelayMs: 60_000 });

    await withServer(async (baseURL) => {
      const detail = await fetch(`${baseURL}/api/devices/${deviceId}`).then(
        (result) => result.json(),
      );
      assert(detail.deviceId === deviceId, "persisted device was not restored");
      assert(!detail.online, "restored device must start offline");
      assert(detail.frameCount === 2, "persisted frame count changed");
      assert(detail.hasFrame, "persisted final-frame flag was lost");
      const latest = await fetch(`${baseURL}/devices/${deviceId}/latest.jpg`);
      assert(latest.ok, "persisted final JPEG is unavailable");
      const frame = new Uint8Array(await latest.arrayBuffer());
      assert(
        frame.byteLength === SECOND_JPEG.byteLength &&
          frame.every((byte, index) => byte === SECOND_JPEG[index]),
        "persisted final JPEG contents changed",
      );
    }, { stateDirectory, persistenceDelayMs: 60_000 });
  } finally {
    await Deno.remove(stateDirectory, { recursive: true });
  }
});

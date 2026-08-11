const DEFAULT_PORT = 8080;
const DEFAULT_HOSTNAME = "0.0.0.0";
const CAMERA_PATH = "/camera";
const BOUNDARY = "stackchan-camera-frame";
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_COMMAND_HISTORY = 20;
const PROTOCOL_VERSION = 1;
const VIEWER_FPS = Object.freeze({ none: 1, grid: 2, detail: 8 });
const encoder = new TextEncoder();

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
  close: () => void;
};

export function createCameraRegistry(
  options: { log?: (message: string) => void } = {},
): CameraRegistry {
  const log = options.log ?? console.log;
  const registry = new Map<string, DeviceRecord>();

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
      return new Response(BLE_PROVISION_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
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
        record.socket.close(1001, "hub shutting down");
      }
    }
  }

  return { handler, devices, close };
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
  <header><h1>Stack-chan Private Camera Hub</h1><div><a class="back" href="/provision">BLE setup</a> <span id="summary" class="summary">読込中…</span></div></header>
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

const BLE_PROVISION_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StackCam BLE provisioning</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  body { margin: 0; background: #071019; color: #edf6fb; }
  main { width: min(620px, 92vw); margin: 28px auto; }
  section { padding: 20px; border: 1px solid #29465c; border-radius: 14px; background: #0d1924; }
  label { display: block; margin-top: 14px; color: #afc4d2; }
  input { width: 100%; box-sizing: border-box; margin-top: 5px; padding: 10px; color: inherit;
    background: #071019; border: 1px solid #365d77; border-radius: 8px; }
  button, a { display: inline-block; margin: 14px 6px 0 0; padding: 10px 13px; color: inherit;
    background: #164566; border: 1px solid #4382aa; border-radius: 8px; text-decoration: none; cursor: pointer; }
  pre { min-height: 110px; padding: 12px; overflow: auto; white-space: pre-wrap; background: #03080c;
    border: 1px solid #20394c; border-radius: 8px; color: #9ed9bd; }
  .hint { color: #9bb1c0; }
</style></head><body><main>
<a href="/">← Camera hub</a><h1>StackCam BLE provisioning</h1>
<p class="hint">Windowsの「Bluetoothとデバイス」で先に <code>StackCam-…</code> を追加し、CoreS3画面の6桁番号でペアリングしてください。その後、Codex内蔵ブラウザではなくWindows版ChromeまたはEdgeでこのページを開きます。</p>
<section>
  <button id="connect">BLEで接続</button><strong id="state">未接続</strong>
  <label>Wi-Fi SSID<input id="ssid" autocomplete="off"></label>
  <label>Wi-Fi password<input id="password" type="password" autocomplete="new-password"></label>
  <label>Tailscale auth key<input id="auth" type="password" autocomplete="off"></label>
  <label>Hub URL<input id="hub" value="ws://stackchan-hub:8080/camera"></label>
  <button id="save" disabled>設定を保存</button><button id="read" disabled>状態を取得</button>
  <button id="restart" disabled>再起動</button><button id="clear" disabled>NVS設定を消去</button>
  <pre id="log">ブラウザーから機密値を外部へ送信しません。</pre>
</section>
<script>
  const SERVICE = '7a910001-6b8a-4d1f-9a3d-535441434b43';
  const RX = '7a910002-6b8a-4d1f-9a3d-535441434b43';
  const TX = '7a910003-6b8a-4d1f-9a3d-535441434b43';
  const encoder = new TextEncoder(); const decoder = new TextDecoder();
  const log = document.querySelector('#log'); const state = document.querySelector('#state');
  let rx; let buffer = '';
  function append(value) { log.textContent += '\\n' + value; log.scrollTop = log.scrollHeight; }
  function enabled(value) { for (const id of ['save','read','restart','clear']) document.querySelector('#'+id).disabled = !value; }
  async function send(message) {
    if (!rx) throw new Error('BLE未接続です');
    const line = JSON.stringify({...message, requestId:crypto.randomUUID()}) + '\\n';
    const bytes = encoder.encode(line);
    for (let offset = 0; offset < bytes.length; offset += 180) {
      await rx.writeValueWithResponse(bytes.slice(offset, offset + 180));
    }
  }
  document.querySelector('#connect').onclick = async () => {
    try {
      if (!navigator.bluetooth)
        throw new Error('Web Bluetooth非対応です。Windows版ChromeまたはEdgeでlocalhostを開いてください');
      const device = await navigator.bluetooth.requestDevice({filters:[{services:[SERVICE]}]});
      state.textContent = '接続中…';
      const server = await device.gatt.connect(); const service = await server.getPrimaryService(SERVICE);
      rx = await service.getCharacteristic(RX); const tx = await service.getCharacteristic(TX);
      await tx.startNotifications();
      tx.addEventListener('characteristicvaluechanged', event => {
        buffer += decoder.decode(event.target.value, {stream:true});
        let end; while ((end = buffer.indexOf('\\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) append(line);
        }
      });
      device.addEventListener('gattserverdisconnected', () => { rx = null; enabled(false); state.textContent = '切断'; });
      state.textContent = device.name + ' 接続済み'; enabled(true); await send({type:'provision.get'});
    } catch (error) {
      append('ERROR: ' + error.message);
      if (/GATT Server is disconnected|retrieve services/i.test(error.message))
        append('HINT: Windowsの「Bluetoothとデバイス」でStackCamを先にペアリングし、CoreS3を再起動してから再接続してください。');
      state.textContent = '接続失敗';
    }
  };
  document.querySelector('#save').onclick = () => send({type:'provision.set', config:{
    wifi:{ssid:document.querySelector('#ssid').value, password:document.querySelector('#password').value},
    tailscale:{authKey:document.querySelector('#auth').value}, hubURL:document.querySelector('#hub').value
  }}).catch(error => append('ERROR: '+error.message));
  document.querySelector('#read').onclick = () => send({type:'provision.get'}).catch(error => append('ERROR: '+error.message));
  document.querySelector('#restart').onclick = () => send({type:'provision.restart'}).catch(error => append('ERROR: '+error.message));
  document.querySelector('#clear').onclick = () => send({type:'provision.clear'}).catch(error => append('ERROR: '+error.message));
</script></main></body></html>`;

function parsePort(value: string | undefined): number {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("port must be between 1 and 65535");
  }
  return port;
}

if (import.meta.main) {
  const port = parsePort(Deno.args[0]);
  const hostname = Deno.args[1] ?? DEFAULT_HOSTNAME;
  const registry = createCameraRegistry();
  const hostnames = [hostname];
  if (
    hostname !== "0.0.0.0" && hostname !== "::" &&
    hostname !== "127.0.0.1" && hostname !== "::1" &&
    hostname.toLowerCase() !== "localhost"
  ) hostnames.push("127.0.0.1");

  for (const bindAddress of hostnames) {
    console.log(
      `Device WebSocket: ws://${bindAddress}:${port}${CAMERA_PATH}`,
    );
    console.log(`Camera dashboard: http://${bindAddress}:${port}/`);
    Deno.serve({ hostname: bindAddress, port }, registry.handler);
  }
}

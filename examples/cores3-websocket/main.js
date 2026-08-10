import WiFi from "embedded:network/interface/wifi";
import config from "mc/config";
import SNTP from "sntp";
import Time from "time";
import Timer from "timer";
import WebSocketStream from "stackcam-websocket-stream";
import Tailnet from "tailscale";
import BLEProvisioning from "ble-provisioning";
import CameraStream from "camera-stream";
import DeviceConfig from "device-config";
import ProvisioningProtocol from "provisioning-protocol";
import StatusDisplay from "status-display";
import USBProvisioning from "usb-provisioning";

const PROTOCOL_VERSION = 1;
const FIRMWARE_VERSION = "0.2.0";
const STACKCAM_CONFIG = config.stackcam ?? {};
const DEVICE_MODEL = STACKCAM_CONFIG.model ?? "m5stack-cores3";
// Values from mc/config can live in the read-only XS archive. JSON.stringify
// needs a writable instance while it marks objects for circularity checks, so
// copy manifest-provided arrays into RAM before including them in device.hello.
const CAPABILITIES = Object.freeze(Array.from(STACKCAM_CONFIG.capabilities ?? ["camera", "display", "provision.usb", "provision.ble"]));
const BLE_PROVISIONING_ENABLED = CAPABILITIES.includes("provision.ble");
const USB_PROVISIONING_ENABLED = CAPABILITIES.includes("provision.usb");
const WEBSOCKET_WRITE_TIMEOUT = 10_000;
const HEARTBEAT_WATCHDOG_MS = 25_000;

let tailnet;
let webSocket;
let wifi;
let wifiHadIP = false;
let wifiConnected = false;
let wifiConnectTimer;
let wifiReconnectTimer;
let webSocketRetryTimer;
let starting = false;
let bleProvisioning;
const status = new StatusDisplay();
const deviceConfig = new DeviceConfig({devicePrefix: STACKCAM_CONFIG.devicePrefix ?? "cores3"});

const provisioningProtocol = new ProvisioningProtocol({
	config: deviceConfig,
	onChanged() {
		status.message("CONFIG SAVED", "Restart to apply", "ok", 8_000);
	},
	onBLERequested() {
		if (BLE_PROVISIONING_ENABLED)
			startBLEProvisioning();
		else
			status.message("BLE DISABLED", "Use USB serial", "error", 5_000);
	},
});

if (USB_PROVISIONING_ENABLED)
	new USBProvisioning({config: deviceConfig, protocol: provisioningProtocol});

function startBLEProvisioning() {
	if (bleProvisioning) {
		bleProvisioning.extendWindow();
		return;
	}
	bleProvisioning = new BLEProvisioning({
		config: deviceConfig,
		protocol: provisioningProtocol,
		onStateChanged(state, detail) {
			trace(`BLE provisioning: ${state}\n`);
			if (state === "passkey")
				status.message("BLE PASSKEY", detail.passkey, "info", 60_000);
			else if (state === "advertising")
				status.set("address", `BLE ${detail.name}`, "info");
			else if (state === "authenticated")
				status.message("BLE CONNECTED", "Send provisioning JSON", "ok", 5_000);
			else if (state === "closed")
				bleProvisioning = undefined;
		},
	});
}

if (BLE_PROVISIONING_ENABLED)
	startBLEProvisioning();
status.message("DEVICE ID", deviceConfig.deviceId, "info", 2_000);

const wifiOptions = deviceConfig.wifi.password
	? {SSID: deviceConfig.wifi.ssid, password: deviceConfig.wifi.password}
	: {SSID: deviceConfig.wifi.ssid};

function waitWithTimeout(promise, milliseconds, message) {
	return new Promise((resolve, reject) => {
		const timer = Timer.set(() => reject(new Error(message)), milliseconds);
		promise.then(
			value => {
				Timer.clear(timer);
				resolve(value);
			},
			error => {
				Timer.clear(timer);
				reject(error);
			},
		);
	});
}

function scheduleWebSocketRetry() {
	if (webSocket || webSocketRetryTimer || !wifiConnected || (tailnet?.state !== "connected"))
		return;
	status.set("websocket", "RETRYING", "pending");
	status.set("camera", "OFFLINE", "error");
	trace("WebSocket retry scheduled\n");
	webSocketRetryTimer = Timer.set(() => {
		webSocketRetryTimer = undefined;
		void openWebSocket();
	}, 5_000);
}

function retireWebSocket(socket) {
	if (webSocket === socket)
		webSocket = undefined;
	scheduleWebSocketRetry();
}

function commandError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function writeWebSocket(writer, value) {
	return waitWithTimeout(writer.write(value), WEBSOCKET_WRITE_TIMEOUT, "WebSocket write timed out");
}

async function handleCommand(message, writer, cameraStream) {
	if ((message.protocol !== PROTOCOL_VERSION) || (typeof message.commandId !== "string"))
		throw commandError("invalid_command", "invalid command envelope");
	const payload = message.payload ?? {};
	let result;
	if (message.command === "stream.set") {
		const fps = cameraStream.setFPS(payload.fps);
		result = {fps};
	}
	else if (message.command === "device.identify") {
		const duration = Number.isInteger(payload.durationMs) ? payload.durationMs : 3_000;
		if ((duration < 1) || (duration > 30_000))
			throw commandError("invalid_payload", "durationMs must be between 1 and 30000");
		status.identify(deviceConfig.deviceId, duration);
		result = {displayed: true, durationMs: duration};
	}
	else if ((message.command === "tts.speak") || (message.command === "panTilt.move"))
		throw commandError("not_supported", `${message.command} is not available in this firmware`);
	else
		throw commandError("unknown_command", `unknown command: ${message.command}`);

	await writeWebSocket(writer, JSON.stringify({
		type: "command.ack",
		protocol: PROTOCOL_VERSION,
		commandId: message.commandId,
		command: message.command,
		ok: true,
		result,
	}));
}

async function readServerMessages(readable, writer, cameraStream, socket) {
	const reader = readable.getReader();
	try {
		while (webSocket === socket) {
			const {done, value} = await reader.read();
			if (done)
				break;
			if (typeof value !== "string")
				continue;
			let message;
			try {
				message = JSON.parse(value);
			}
			catch {
				continue;
			}
			trace("WebSocket RX: ", value, "\n");
			if (message.type !== "command")
				continue;
			try {
				await handleCommand(message, writer, cameraStream);
			}
			catch (error) {
				await writeWebSocket(writer, JSON.stringify({
					type: "command.ack",
					protocol: PROTOCOL_VERSION,
					commandId: String(message.commandId ?? ""),
					command: String(message.command ?? ""),
					ok: false,
					error: {code: error.code ?? "command_failed", message: String(error.message ?? error)},
				}));
			}
		}
	}
	finally {
		reader.releaseLock();
		retireWebSocket(socket);
		socket.close();
	}
}

async function openWebSocket() {
	if (webSocket)
		return;
	trace(`WebSocket: ${deviceConfig.websocketURL}\n`);
	status.set("websocket", "CONNECTING", "pending");
	status.set("camera", "WAITING", "pending");
	let socket;
	let wasOpened = false;
	try {
		socket = webSocket = new WebSocketStream(deviceConfig.websocketURL, {
			ws: tailnet.ws,
			onPing() {
				deviceConfig.feedHeartbeatWatchdog();
			},
		});
		// Observe closure immediately. The local WebSocketStream reports transport
		// failures as close code 1006 to avoid XS's stuck Stream error state.
		const closedTask = socket.closed.then(
			closeInfo => {
				retireWebSocket(socket);
				if (wasOpened) {
					trace(`WebSocket closed (${closeInfo.closeCode}); restarting device\n`);
					status.message("HUB LOST", "Restarting", "error", 1_000);
					deviceConfig.restart();
				}
			},
			error => {
				trace(`WebSocket closed with error: ${error}\n`);
				retireWebSocket(socket);
			},
		);
		const {readable, writable} = await waitWithTimeout(socket.opened, 65_000, "WebSocket connection timed out");
		wasOpened = true;
		trace("WebSocket connected\n");
		status.set("websocket", "CONNECTED", "ok");

		const writer = writable.getWriter();
		// This ESP-IDF timer runs outside the JS thread, so it can reboot even if
		// a native TCP write blocks the event loop completely.
		deviceConfig.startHeartbeatWatchdog(HEARTBEAT_WATCHDOG_MS);
		const cameraStream = new CameraStream({
			fps: 1,
			onStateChanged(state, detail) {
				if (state === "starting")
					status.set("camera", "STARTING", "pending");
				else if (state === "streaming")
					status.set("camera", `${detail.width}x${detail.height} @ ${detail.fps}fps`, "ok");
				else if (state === "rate")
					status.set("camera", `${cameraStream.width}x${cameraStream.height} @ ${detail.fps}fps`, "ok");
				else if (state === "waiting")
					status.set("camera", "WAITING FRAME", "pending");
				else if (state === "frame") {
					// A completed frame proves that the JS and TCP send paths are still
					// making progress even when Deno does not need to send an idle ping.
					deviceConfig.feedHeartbeatWatchdog();
					// Serial output can block the JS thread when no USB monitor is reading it.
					// Keep diagnostics useful without logging every frame at detail-view rates.
					if ((detail.frameNumber % Math.max(10, cameraStream.fps * 10)) === 0)
						trace(`Camera frame ${detail.frameNumber}: ${detail.byteLength} bytes\n`);
					if ((detail.frameNumber % 5) === 0)
						status.set("camera", `${cameraStream.fps}fps F${detail.frameNumber} ${detail.byteLength >> 10}KiB`, "ok");
				}
				else if (state === "stopped")
					status.set("camera", "STOPPED", "error");
			},
		});
		const readTask = readServerMessages(readable, writer, cameraStream, socket).catch(error => {
			trace(`WebSocket read error: ${error}\n`);
		});
		const cameraTask = cameraStream.run(writer, () => webSocket === socket, {
				type: "device.hello",
				protocol: PROTOCOL_VERSION,
				deviceId: deviceConfig.deviceId,
				name: deviceConfig.deviceName,
				model: DEVICE_MODEL,
				firmware: FIRMWARE_VERSION,
				capabilities: CAPABILITIES,
			}).catch(error => {
				trace(`Camera stream error: ${error}\n`);
				status.set("camera", "FAILED", "error");
			});

		// A transport error can leave an in-flight WritableStream operation
		// pending in the SDK. Reconnect as soon as any side observes closure;
		// cameraTask remains the sole owner of the retired writer until GC.
		await Promise.race([closedTask, readTask, cameraTask]);
	}
	catch (error) {
		trace(`WebSocket error: ${error}\n`);
		status.set("websocket", "ERROR", "error");
		status.set("camera", "FAILED", "error");
	}
	finally {
		deviceConfig.stopHeartbeatWatchdog();
		socket?.close();
		retireWebSocket(socket);
		scheduleWebSocketRetry();
	}
}

async function startTailnet() {
	if (starting)
		return;
	starting = true;
	try {
		if (!tailnet) {
			tailnet = new Tailnet({
				...deviceConfig.tailscale,
				onStateChanged(state) {
					trace(`Tailnet state: ${state}\n`);
					status.set("tailnet", String(state).toUpperCase(), state === "connected" ? "ok" : "pending");
				},
				onError(error) {
					trace(`Tailnet error: ${error.message}\n`);
					status.set("tailnet", "ERROR", "error");
				},
			});
			await tailnet.start();
			trace(`Tailnet address: ${tailnet.vpnAddress}\n`);
			status.set("address", tailnet.vpnAddress, "ok");
			const peers = tailnet.peers;
			trace(`Tailnet peers: ${peers.map(peer => `${peer.address}/${peer.online ? "online" : "offline"}/${peer.direct ? "direct" : "relay"}`).join(", ")}\n`);
			status.set("tailnet", `CONNECTED (${peers.length})`, "ok");
		}
		else
			await tailnet.rebind();
		await new Promise(resolve => Timer.set(resolve, 2_000));
		void openWebSocket();
	}
	catch (error) {
		trace(`Tailnet startup failed: ${error}\n`);
		status.set("tailnet", "START FAILED", "error");
	}
	finally {
		starting = false;
	}
}

function setClockAndStart() {
	trace("Synchronizing clock for TLS certificate validation\n");
	status.set("tailnet", "TIME SYNC", "pending");
	new SNTP({host: "time.google.com"}, (message, value) => {
		if (message === SNTP.time) {
			Time.set(value);
			void startTailnet();
		}
		else if (message === SNTP.error) {
			trace(`SNTP failed; Tailnet was not started: ${value}\n`);
			status.set("tailnet", "SNTP ERROR", "error");
		}
	});
}

function scheduleWiFiReconnect() {
	if (wifiReconnectTimer)
		return;
	wifiReconnectTimer = Timer.set(connectWiFi, 1_000);
}

function clearWiFiConnectTimer() {
	if (!wifiConnectTimer)
		return;
	Timer.clear(wifiConnectTimer);
	wifiConnectTimer = undefined;
}

function connectWiFi() {
	wifiReconnectTimer = undefined;
	try {
		trace("Wi-Fi connecting\n");
		status.set("wifi", "CONNECTING", "pending");
		wifi.connect(wifiOptions);
		wifiConnectTimer = Timer.set(() => {
			wifiConnectTimer = undefined;
			if (wifi.connection !== 300)
				return;
			trace("Wi-Fi connection timed out\n");
			status.set("wifi", "TIMEOUT", "error");
			wifi.disconnect();
			scheduleWiFiReconnect();
		}, 20_000);
	}
	catch (error) {
		trace(`Wi-Fi connect failed: ${error}\n`);
		status.set("wifi", "CONNECT ERROR", "error");
		scheduleWiFiReconnect();
	}
}

function scanAndConnectWiFi() {
	let found = false;
	trace("Wi-Fi scanning\n");
	status.set("wifi", "SCANNING", "pending");
	try {
		wifi.scan({
			onFound(accessPoint) {
				if ((accessPoint.SSID === deviceConfig.wifi.ssid) && !found) {
					found = true;
					trace(`Configured Wi-Fi found: channel ${accessPoint.channel}, RSSI ${accessPoint.RSSI}\n`);
					status.set("wifi", `FOUND ${accessPoint.RSSI} dBm`, "info");
				}
			},
			onComplete() {
				if (!found)
					trace("Configured Wi-Fi was not found during scan\n");
				if (!found)
					status.set("wifi", "NOT FOUND", "error");
				connectWiFi();
			},
		});
	}
	catch (error) {
		trace(`Wi-Fi scan failed: ${error}\n`);
		status.set("wifi", "SCAN ERROR", "error");
		connectWiFi();
	}
}

wifi = new WiFi({
	onChanged(property) {
		if (property !== "connection")
			return;

		const connection = this.connection;
		if (connection >= 500) {
			if (wifiConnected)
				return;
			clearWiFiConnectTimer();
			wifiConnected = true;
			trace(`Wi-Fi address: ${this.address}\n`);
			status.set("wifi", "CONNECTED", "ok");
			status.set("address", `LAN ${this.address}`, "info");
			if (wifiHadIP)
				void startTailnet();
			else {
				wifiHadIP = true;
				setClockAndStart();
			}
		}
		else if (connection >= 400) {
			trace("Wi-Fi associated\n");
			status.set("wifi", "ASSOCIATED", "info");
		}
		else if (connection <= 200) {
			clearWiFiConnectTimer();
			wifiConnected = false;
			trace("Wi-Fi disconnected\n");
			status.set("wifi", "DISCONNECTED", "error");
			status.set("tailnet", "OFFLINE", "error");
			status.set("websocket", "OFFLINE", "error");
			status.set("camera", "OFFLINE", "error");
			if (webSocketRetryTimer) {
				Timer.clear(webSocketRetryTimer);
				webSocketRetryTimer = undefined;
			}
			webSocket?.close();
			webSocket = undefined;
			scheduleWiFiReconnect();
		}
	},
});

scanAndConnectWiFi();

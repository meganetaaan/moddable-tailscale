import WiFi from "embedded:network/interface/wifi";
import SNTP from "sntp";
import Time from "time";
import Timer from "timer";
import WebSocketStream from "web/websocketstream";
import Tailnet from "tailscale";
import credentials from "credentials";
import StatusDisplay from "status-display";

let tailnet;
let webSocket;
let wifi;
let wifiHadIP = false;
let wifiConnected = false;
let wifiConnectTimer;
let wifiReconnectTimer;
let webSocketRetryTimer;
let starting = false;
const status = new StatusDisplay();

const wifiOptions = credentials.wifi.password
	? {SSID: credentials.wifi.ssid, password: credentials.wifi.password}
	: {SSID: credentials.wifi.ssid};

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
	if (webSocketRetryTimer || !wifiConnected || (tailnet?.state !== "connected"))
		return;
	status.set("websocket", "RETRYING", "pending");
	webSocketRetryTimer = Timer.set(() => {
		webSocketRetryTimer = undefined;
		void openWebSocket();
	}, 5_000);
}

async function openWebSocket() {
	if (webSocket)
		return;
	trace(`WebSocket: ${credentials.websocketURL}\n`);
	status.set("websocket", "CONNECTING", "pending");
	status.set("echo", "WAITING", "pending");
	let socket;
	try {
		socket = webSocket = new WebSocketStream(credentials.websocketURL, {ws: tailnet.ws});
		const {readable, writable} = await waitWithTimeout(socket.opened, 65_000, "WebSocket connection timed out");
		trace("WebSocket connected\n");
		status.set("websocket", "CONNECTED", "ok");
		const writer = writable.getWriter();
		await writer.write("hello from Moddable over Tailscale");
		status.set("echo", "SENT", "info");
		writer.releaseLock();

		const reader = readable.getReader();
		while (true) {
			const {done, value} = await reader.read();
			if (done)
				break;
			trace("WebSocket RX: ", String(value), "\n");
			status.set("echo", `OK: ${String(value)}`, "ok");
		}
	}
	catch (error) {
		trace(`WebSocket error: ${error}\n`);
		status.set("websocket", "ERROR", "error");
		status.set("echo", "FAILED", "error");
	}
	finally {
		socket?.close();
		if (webSocket === socket)
			webSocket = undefined;
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
				...credentials.tailscale,
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
				if ((accessPoint.SSID === credentials.wifi.ssid) && !found) {
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
			status.set("echo", "OFFLINE", "error");
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

import WiFi from "wifi";
import SNTP from "sntp";
import Time from "time";
import WebSocketStream from "web/websocketstream";
import Tailnet from "tailscale";
import credentials from "credentials";

let tailnet;
let webSocket;
let wifiHadIP = false;
let starting = false;

async function openWebSocket() {
	if (webSocket)
		return;
	trace(`WebSocket: ${credentials.websocketURL}\n`);
	const socket = webSocket = new WebSocketStream(credentials.websocketURL, {ws: tailnet.ws});
	try {
		const {readable, writable} = await socket.opened;
		trace("WebSocket connected\n");
		const writer = writable.getWriter();
		await writer.write("hello from Moddable over Tailscale");
		writer.releaseLock();

		const reader = readable.getReader();
		while (true) {
			const {done, value} = await reader.read();
			if (done)
				break;
			trace("WebSocket RX: ", String(value), "\n");
		}
	}
	catch (error) {
		trace(`WebSocket error: ${error}\n`);
	}
	finally {
		if (webSocket === socket)
			webSocket = undefined;
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
				onStateChanged(state) { trace(`Tailnet state: ${state}\n`); },
				onError(error) { trace(`Tailnet error: ${error.message}\n`); },
			});
			await tailnet.start();
			trace(`Tailnet address: ${tailnet.vpnAddress}\n`);
		}
		else
			await tailnet.rebind();
		void openWebSocket();
	}
	catch (error) {
		trace(`Tailnet startup failed: ${error}\n`);
	}
	finally {
		starting = false;
	}
}

function setClockAndStart() {
	trace("Synchronizing clock for TLS certificate validation\n");
	new SNTP({host: "time.google.com"}, (message, value) => {
		if (message === SNTP.time) {
			Time.set(value);
			void startTailnet();
		}
		else if (message === SNTP.error)
			trace(`SNTP failed; Tailnet was not started: ${value}\n`);
	});
}

new WiFi(credentials.wifi, message => {
	if (message === WiFi.gotIP) {
		if (wifiHadIP)
			void startTailnet();
		else {
			wifiHadIP = true;
			setClockAndStart();
		}
	}
	else if (message === WiFi.disconnected) {
		trace("Wi-Fi disconnected\n");
		webSocket?.close();
		webSocket = undefined;
	}
});

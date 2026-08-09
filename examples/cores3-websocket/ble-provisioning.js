import BLEServer from "bleserver";
import {uuid} from "btutils";
import {IOCapability} from "sm";
import Timer from "timer";

const SERVICE_UUID = uuid`7A910001-6B8A-4D1F-9A3D-535441434B43`;
const WINDOW_MS = 180_000;
// 60 UTF-16 code units fit the 244-byte characteristic after UTF-8 encoding.
const NOTIFY_CHUNK = 60;

export default class BLEProvisioning extends BLEServer {
	constructor(options) {
		super();
		this.config = options.config;
		this.protocol = options.protocol;
		this.onStateChanged = options.onStateChanged;
		this.window = options.window ?? WINDOW_MS;
		this.connected = false;
		this.closed = false;
		this.armWindow();
	}

	armWindow() {
		if (this.windowTimer)
			Timer.clear(this.windowTimer);
		this.windowTimer = Timer.set(() => this.shutdown(), this.window);
	}

	extendWindow() {
		if (this.closed)
			return false;
		if (!this.connected)
			this.armWindow();
		return true;
	}

	onReady() {
		this.deviceName = `StackCam-${this.config.mac.slice(-6)}`;
		this.securityParameters = {encryption: true, mitm: true, bonding: true, ioCapability: IOCapability.DisplayOnly};
		this.advertise();
	}

	advertise() {
		if (this.closed)
			return;
		this.startAdvertising({
			advertisingData: {flags: 6, completeUUID128List: [SERVICE_UUID]},
			scanResponseData: {completeName: this.deviceName},
		});
		this.onStateChanged?.("advertising", {name: this.deviceName});
	}

	onConnected() {
		this.stopAdvertising();
		this.connected = true;
		if (this.windowTimer) {
			Timer.clear(this.windowTimer);
			this.windowTimer = undefined;
		}
		this.authenticated = false;
		this.onStateChanged?.("connected");
	}

	onAuthenticated() {
		this.authenticated = true;
		this.onStateChanged?.("authenticated");
	}

	onDisconnected() {
		this.connected = false;
		this.authenticated = false;
		delete this.tx;
		this.armWindow();
		this.advertise();
	}

	onPasskeyDisplay(params) {
		this.onStateChanged?.("passkey", {passkey: String(params.passkey).padStart(6, "0")});
	}

	onCharacteristicNotifyEnabled(characteristic) {
		if (characteristic.name === "tx")
			this.tx = characteristic;
	}

	onCharacteristicNotifyDisabled(characteristic) {
		if (characteristic.name === "tx")
			delete this.tx;
	}

	onCharacteristicWritten(characteristic, value) {
		if ((characteristic.name !== "rx") || !this.authenticated)
			return;
		this.protocol.feed(String(value), response => this.notify(response));
	}

	notify(value) {
		if (!this.tx)
			return;
		for (let offset = 0; offset < value.length; offset += NOTIFY_CHUNK)
			this.notifyValue(this.tx, value.slice(offset, offset + NOTIFY_CHUNK));
	}

	shutdown() {
		if (this.closed)
			return;
		this.closed = true;
		if (this.windowTimer) {
			Timer.clear(this.windowTimer);
			this.windowTimer = undefined;
		}
		this.stopAdvertising();
		this.close();
		this.onStateChanged?.("closed");
	}
}

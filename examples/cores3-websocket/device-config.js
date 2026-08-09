import native from "device-config-native";
import credentials from "credentials";

const CONFIG_VERSION = 1;
const DEFAULT_HUB_URL = "ws://stackchan-hub:8080/camera";
const mac = native.baseMac();

function isObject(value) {
	return value && (typeof value === "object") && !Array.isArray(value);
}

function requireString(value, name, maximum, allowEmpty = false) {
	if ((typeof value !== "string") || (!allowEmpty && !value.length) || (value.length > maximum))
		throw new RangeError(`invalid ${name}`);
	return value;
}

function validate(value) {
	if (!isObject(value) || (value.version !== CONFIG_VERSION))
		throw new RangeError("invalid config version");
	if (!isObject(value.wifi) || !isObject(value.tailscale))
		throw new RangeError("invalid config sections");
	requireString(value.wifi.ssid, "Wi-Fi SSID", 32);
	requireString(value.wifi.password ?? "", "Wi-Fi password", 63, true);
	const authKey = requireString(value.tailscale.authKey, "Tailscale auth key", 160);
	if (!authKey.startsWith("tskey-auth-"))
		throw new RangeError("invalid Tailscale auth key");
	const hubURL = requireString(value.hubURL, "hub URL", 160);
	if (!/^ws:\/\/[a-z0-9.-]+(?::\d{1,5})?\/camera$/i.test(hubURL))
		throw new RangeError("hub URL must be ws://<MagicDNS-name>:<port>/camera");
	if (value.tailscale.priorityPeer !== undefined) {
		const peer = requireString(value.tailscale.priorityPeer, "priority peer", 15);
		if (!/^100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}$/.test(peer))
			throw new RangeError("invalid priority peer");
	}
	return value;
}

function defaults() {
	const result = {
		version: CONFIG_VERSION,
		wifi: {
			ssid: credentials.wifi.ssid,
			password: credentials.wifi.password ?? "",
		},
		tailscale: {
			authKey: credentials.tailscale.authKey,
		},
		hubURL: DEFAULT_HUB_URL,
	};
	if (credentials.tailscale.priorityPeer)
		result.tailscale.priorityPeer = credentials.tailscale.priorityPeer;
	return validate(result);
}

export default class DeviceConfig {
	constructor() {
		this.mac = mac;
		this.deviceId = `cores3-${mac}`;
		this.deviceName = `stackcam-${mac.slice(-6)}`;
		this.persisted = false;
		this.value = defaults();
		const stored = native.load();
		if (stored) {
			try {
				this.value = validate(JSON.parse(stored));
				this.persisted = true;
			}
			catch (error) {
				trace(`Ignoring invalid NVS config: ${error}\n`);
			}
		}
	}

	get wifi() {
		return this.value.wifi;
	}

	get websocketURL() {
		return this.value.hubURL;
	}

	get tailscale() {
		const result = {
			authKey: this.value.tailscale.authKey,
			deviceName: this.deviceName,
		};
		if (this.value.tailscale.priorityPeer)
			result.priorityPeer = this.value.tailscale.priorityPeer;
		return result;
	}

	save(patch) {
		if (!isObject(patch))
			throw new TypeError("config must be an object");
		const next = {
			version: CONFIG_VERSION,
			wifi: {
				...this.value.wifi,
				...(isObject(patch.wifi) ? patch.wifi : {}),
			},
			tailscale: {
				...this.value.tailscale,
				...(isObject(patch.tailscale) ? patch.tailscale : {}),
			},
			hubURL: patch.hubURL ?? this.value.hubURL,
		};
		validate(next);
		native.save(JSON.stringify(next));
		this.value = next;
		this.persisted = true;
		return this.summary();
	}

	clear() {
		native.clear();
		this.value = defaults();
		this.persisted = false;
		return this.summary();
	}

	summary() {
		return {
			deviceId: this.deviceId,
			deviceName: this.deviceName,
			persisted: this.persisted,
			wifi: {ssid: this.value.wifi.ssid, passwordSet: !!this.value.wifi.password},
			tailscale: {authKeySet: !!this.value.tailscale.authKey},
			hubURL: this.value.hubURL,
		};
	}

	restart() {
		native.restart();
	}

	startHeartbeatWatchdog(timeout) {
		native.watchdogStart(timeout);
	}

	feedHeartbeatWatchdog() {
		native.watchdogFeed();
	}

	stopHeartbeatWatchdog() {
		native.watchdogStop();
	}

	usbRead() {
		return native.usbRead();
	}

	usbWrite(value) {
		native.usbWrite(value);
	}
}

Object.freeze(DeviceConfig.prototype);

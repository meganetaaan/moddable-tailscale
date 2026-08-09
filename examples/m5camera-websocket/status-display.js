export default class HeadlessStatus {
	constructor() {
		this.values = {};
	}

	set(name, value, tone = "info") {
		value = String(value);
		if (this.values[name] === value)
			return;
		this.values[name] = value;
		trace(`[${tone}] ${name}: ${value}\n`);
	}

	message(title, detail, tone = "info") {
		trace(`[${tone}] ${title}: ${detail}\n`);
	}

	identify(deviceId, duration) {
		trace(`[identify] ${deviceId} for ${duration}ms\n`);
	}
}

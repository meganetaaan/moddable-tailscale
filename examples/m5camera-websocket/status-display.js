import Digital from "embedded:io/digital";
import Timer from "timer";

const LED_PIN = 14;
const LED_ON = 0;
const LED_OFF = 1;

export default class HeadlessStatus {
	constructor() {
		this.values = {};
		this.tones = {};
		this.pattern = undefined;
		this.identifying = false;
		this.led = new Digital({
			pin: LED_PIN,
			mode: Digital.Output,
			initialValue: LED_OFF,
		});
		this.setPattern("connecting");
	}

	set(name, value, tone = "info") {
		value = String(value);
		if ((this.values[name] === value) && (this.tones[name] === tone))
			return;
		this.values[name] = value;
		this.tones[name] = tone;
		trace(`[${tone}] ${name}: ${value}\n`);
		this.refreshLED();
	}

	message(title, detail, tone = "info") {
		trace(`[${tone}] ${title}: ${detail}\n`);
	}

	identify(deviceId, duration) {
		trace(`[identify] ${deviceId} for ${duration}ms\n`);
		this.identifying = true;
		if (this.identifyTimer)
			Timer.clear(this.identifyTimer);
		this.setPattern("identify");
		this.identifyTimer = Timer.set(() => {
			this.identifyTimer = undefined;
			this.identifying = false;
			this.refreshLED();
		}, duration);
	}

	refreshLED() {
		if (this.identifying)
			return;

		const ready = (this.tones.wifi === "ok") &&
			(this.tones.tailnet === "ok") &&
			(this.tones.websocket === "ok") &&
			(this.tones.camera === "ok");
		if (ready)
			this.setPattern("ready");
		else if (Object.values(this.tones).includes("error"))
			this.setPattern("error");
		else
			this.setPattern("connecting");
	}

	setPattern(pattern) {
		if (this.pattern === pattern)
			return;
		this.pattern = pattern;
		if (this.blinkTimer) {
			Timer.clear(this.blinkTimer);
			this.blinkTimer = undefined;
		}

		if (pattern === "ready") {
			this.led.write(LED_ON);
			return;
		}

		let lit = true;
		this.led.write(LED_ON);
		const interval = pattern === "connecting" ? 500 : 125;
		this.blinkTimer = Timer.repeat(() => {
			lit = !lit;
			this.led.write(lit ? LED_ON : LED_OFF);
		}, interval);
	}
}

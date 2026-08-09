import Timer from "timer";

const PREFIX = "@stackchan ";

export default class USBProvisioning {
	constructor(options) {
		this.config = options.config;
		this.protocol = options.protocol;
		this.timer = Timer.repeat(() => this.poll(), 100);
		Timer.set(() => this.write({
			type: "provision.ready",
			transport: "usb-serial",
			...this.config.summary(),
		}), 2_200);
	}

	poll() {
		const chunk = this.config.usbRead();
		if (chunk)
			this.protocol.feed(chunk, value => this.writeRaw(value));
	}

	write(value) {
		this.writeRaw(`${JSON.stringify(value)}\n`);
	}

	writeRaw(value) {
		this.config.usbWrite(`${PREFIX}${value}`);
	}

	close() {
		if (this.timer) {
			Timer.clear(this.timer);
			this.timer = undefined;
		}
	}
}

Object.freeze(USBProvisioning.prototype);

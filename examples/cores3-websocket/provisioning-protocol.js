import Timer from "timer";

const MAX_LINE_BYTES = 1400;

export default class ProvisioningProtocol {
	constructor(options) {
		this.config = options.config;
		this.onChanged = options.onChanged;
		this.onBLERequested = options.onBLERequested;
		this.onTailnetResetRequested = options.onTailnetResetRequested;
		this.getRuntime = options.getRuntime;
		this.buffer = "";
	}

	feed(chunk, send) {
		this.buffer += chunk;
		if (this.buffer.length > MAX_LINE_BYTES) {
			this.buffer = "";
			this.send(send, {type: "provision.ack", ok: false, error: "request too large"});
			return;
		}
		while (true) {
			const end = this.buffer.indexOf("\n");
			if (end < 0)
				break;
			let line = this.buffer.slice(0, end).trim();
			this.buffer = this.buffer.slice(end + 1);
			if (line.startsWith("@stackchan "))
				line = line.slice(11);
			if (line)
				this.handle(line, send);
		}
	}

	handle(line, send) {
		let request;
		try {
			request = JSON.parse(line);
		}
		catch {
			this.send(send, {type: "provision.ack", ok: false, error: "invalid JSON"});
			return;
		}
		const response = {type: "provision.ack", requestId: request.requestId, command: request.type};
		try {
			if (request.type === "provision.get") {
				response.config = this.config.summary();
				response.runtime = this.getRuntime?.();
			}
			else if (request.type === "provision.set") {
				response.config = this.config.save(request.config);
				response.restartRequired = true;
				this.onChanged?.(response.config);
			}
			else if (request.type === "provision.clear") {
				response.config = this.config.clear();
				response.restartRequired = true;
				this.onChanged?.(response.config);
			}
			else if (request.type === "provision.ble.start")
				this.onBLERequested?.();
			else if (request.type === "provision.restart")
				response.restarting = true;
			else if (request.type === "provision.tailnet.reset")
				response.restarting = true;
			else
				throw new RangeError("unknown provisioning command");
			response.ok = true;
			this.send(send, response);
			if (request.type === "provision.restart")
				Timer.set(() => this.config.restart(), 500);
			else if (request.type === "provision.tailnet.reset")
				Timer.set(() => this.onTailnetResetRequested?.(), 500);
		}
		catch (error) {
			response.ok = false;
			response.error = String(error?.message ?? error);
			this.send(send, response);
		}
	}

	send(send, response) {
		send(`${JSON.stringify(response)}\n`);
	}
}

Object.freeze(ProvisioningProtocol.prototype);

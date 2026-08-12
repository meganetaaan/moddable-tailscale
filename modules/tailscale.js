import Timer from "timer";
import {ReadableStream, WritableStream} from "web/streams";

const EVENT_READABLE = 1;
const EVENT_WRITABLE = 2;
const EVENT_ERROR = 4;

const STATE_NAMES = Object.freeze([
	"idle",
	"wifi-wait",
	"connecting",
	"registering",
	"connected",
	"reconnecting",
	"error",
	"needs-auth",
	"needs-approval",
	"reconnecting",
	"closed",
]);

const NATIVE_ERRORS = Object.freeze([
	"",
	"MicroLink initialization failed",
	"MicroLink start failed",
	"MicroLink rebind failed",
	"MicroLink node key rotation failed",
]);

function parseIPv4(value) {
	if (typeof value !== "string")
		return;
	const parts = value.split(".");
	if (parts.length !== 4)
		return;
	const bytes = parts.map(part => {
		if (!/^\d{1,3}$/.test(part))
			return -1;
		const byte = Number(part);
		return byte <= 255 ? byte : -1;
	});
	if (bytes.includes(-1))
		return;
	return bytes;
}

function isTailnetIPv4(value) {
	const bytes = parseIPv4(value);
	return !!bytes && (bytes[0] === 100) && (bytes[1] >= 64) && (bytes[1] <= 127);
}

function nativeManager(value) {
	return value?._native ?? value;
}

class NativeManager extends Native("xs_tailscale_manager_destructor") {
	constructor(options) {
		super();
		native("xs_tailscale_manager_constructor").call(this, options);
	}
	start() { native("xs_tailscale_manager_start").call(this); }
	rebind() { native("xs_tailscale_manager_rebind").call(this); }
	close() { native("xs_tailscale_manager_close").call(this); }
	release() { native("xs_tailscale_manager_release").call(this); }
	get state() { return native("xs_tailscale_manager_get_state").call(this); }
	get error() { return native("xs_tailscale_manager_get_error").call(this); }
	get errorMessage() { return native("xs_tailscale_manager_get_error_message").call(this); }
	get authURL() { return native("xs_tailscale_manager_get_auth_url").call(this); }
	get closed() { return native("xs_tailscale_manager_get_closed").call(this); }
	get vpnAddress() { return native("xs_tailscale_manager_get_vpn_address").call(this); }
	get peerCount() { return native("xs_tailscale_manager_get_peer_count").call(this); }
	getPeer(index) { return native("xs_tailscale_manager_get_peer").call(this, index); }
	resolve(host) { return native("xs_tailscale_manager_resolve").call(this, host); }
	static factoryReset() { return native("xs_tailscale_manager_factory_reset").call(this); }
}

class TailnetTCP extends Native("xs_tailscale_tcp_destructor") {
	#onReadable;
	#onWritable;
	#onError;
	#closed = false;

	constructor(options) {
		super();
		this.#onReadable = options.onReadable;
		this.#onWritable = options.onWritable;
		this.#onError = options.onError;
		native("xs_tailscale_tcp_constructor").call(this, {
			...options,
			manager: nativeManager(options.manager),
		});
	}

	callback(event, value) {
		if (event === EVENT_READABLE)
			this.#onReadable?.call(this, value);
		else if (event === EVENT_WRITABLE)
			this.#onWritable?.call(this, value);
		else if (event === EVENT_ERROR) {
			this.#closed = true;
			this.#onError?.call(this, value);
		}
	}

	close() {
		if (this.#closed)
			return;
		this.#closed = true;
		native("xs_tailscale_tcp_close").call(this);
	}
	read(value) {
		if (!arguments.length)
			return native("xs_tailscale_tcp_read").call(this);
		return native("xs_tailscale_tcp_read").call(this, value);
	}
	write(value) { return native("xs_tailscale_tcp_write").call(this, value); }
	get format() { return native("xs_tailscale_tcp_get_format").call(this); }
	set format(value) { native("xs_tailscale_tcp_set_format").call(this, value); }
	get remoteAddress() { return native("xs_tailscale_tcp_get_remote_address").call(this); }
	get remotePort() { return native("xs_tailscale_tcp_get_remote_port").call(this); }

	static {
		this.prototype[Symbol.dispose] = this.prototype.close;
	}
}

class TailnetResolver {
	#manager;
	#timer;

	constructor(options) {
		this.#manager = options.manager;
	}

	resolve(options) {
		this.close();
		this.#timer = Timer.set(() => {
			this.#timer = undefined;
			const address = this.#manager.resolve(options.host);
			if (address)
				options.onResolved?.(options.host, address);
			else
				options.onError?.();
		});
	}

	close() {
		if (this.#timer !== undefined) {
			Timer.clear(this.#timer);
			this.#timer = undefined;
		}
	}
}

class UDP extends Native("xs_tailscale_udp_destructor") {
	#onReadable;
	#onError;
	#closed = false;

	constructor(options) {
		super();
		const manager = options.tailnet ?? options.manager;
		if (!manager)
			throw new TypeError("tailnet is required");
		this.#onReadable = options.onReadable;
		this.#onError = options.onError;
		native("xs_tailscale_udp_constructor").call(this, {
			manager: nativeManager(manager),
			port: options.port ?? 0,
		});
	}

	callback(event, value) {
		if (event === EVENT_READABLE)
			this.#onReadable?.call(this, value);
		else if (event === EVENT_ERROR)
			this.#onError?.call(this, new Error(`Tailnet UDP error ${value}`));
	}

	close() {
		if (this.#closed)
			return;
		this.#closed = true;
		native("xs_tailscale_udp_close").call(this);
	}
	read() { return native("xs_tailscale_udp_read").call(this); }
	write(data, address, port) {
		return native("xs_tailscale_udp_write").call(this, data, address, port);
	}
	get localPort() { return native("xs_tailscale_udp_get_local_port").call(this); }
	get droppedPackets() { return native("xs_tailscale_udp_get_dropped").call(this); }
	get format() { return "buffer"; }
	set format(value) {
		if (value !== "buffer")
			throw new RangeError("UDP format must be buffer");
	}

	static {
		this.prototype[Symbol.dispose] = this.prototype.close;
	}
}

function createStreams(tailnet, address, options) {
	const opened = Promise.withResolvers();
	let socket;
	let readableController;
	let writableController;
	let readableLength = 0;
	let writableLength = 0;
	let writableWaiter;
	let ready = false;
	let failed = false;

	function fail(error = new Error("Tailnet TCP error")) {
		if (failed)
			return;
		failed = true;
		if (!ready)
			opened.reject(error);
		readableController?.error(error);
		writableController?.error(error);
	}

	function drainReadable() {
		if (!readableLength || !readableController || (readableController.desiredSize <= 0))
			return;
		const buffer = socket.read(readableLength);
		readableLength = 0;
		readableController.enqueue(new Uint8Array(buffer));
	}

	const readable = new ReadableStream({
		type: "bytes",
		start(controller) { readableController = controller; },
		pull() { drainReadable(); },
		cancel() { socket?.close(); },
	});
	const writable = new WritableStream({
		start(controller) { writableController = controller; },
		async write(chunk) {
			const bytes = chunk instanceof ArrayBuffer
				? new Uint8Array(chunk)
				: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			let offset = 0;
			while (offset < bytes.byteLength) {
				while (!writableLength) {
					writableWaiter = Promise.withResolvers();
					await writableWaiter.promise;
				}
				const count = Math.min(writableLength, bytes.byteLength - offset);
				writableLength = socket.write(bytes.subarray(offset, offset + count));
				offset += count;
			}
		},
		close() { socket.close(); },
		abort() { socket.close(); },
	});

	socket = new TailnetTCP({
		manager: tailnet,
		address,
		port: options.port,
		connectTimeout: options.connectTimeout,
		onReadable(count) {
			readableLength = count;
			drainReadable();
		},
		onWritable(count) {
			writableLength = count;
			writableWaiter?.resolve();
			writableWaiter = undefined;
			if (!ready) {
				ready = true;
				opened.resolve({readable, writable, socket, address});
			}
		},
		onError() { fail(); },
	});
	return opened.promise;
}

class Tailnet {
	#native;
	#state = "idle";
	#timer;
	#connectTimeout;
	#onStateChanged;
	#onAuthRequired;
	#onError;
	#authURL;
	#startResult;
	#startDeadline;
	#startTimeoutRemaining;
	#rebindResult;
	#rebindDeadline;
	#rebindNotBefore;
	#closeResult;
	#closing = false;
	#reportedError;

	constructor(options = {}) {
		if (!options || (typeof options !== "object"))
			throw new TypeError("options must be an object");
		if ((options.authKey !== undefined) &&
			((typeof options.authKey !== "string") || !options.authKey.startsWith("tskey-auth-")))
			throw new TypeError("authKey must be a Tailscale auth key");
		if ((options.deviceName !== undefined) && (typeof options.deviceName !== "string"))
			throw new TypeError("deviceName must be a string");
		if ((options.priorityPeer !== undefined) && !isTailnetIPv4(options.priorityPeer))
			throw new RangeError("priorityPeer must be in 100.64.0.0/10");
		this.#connectTimeout = options.connectTimeout ?? 60000;
		if (!Number.isInteger(this.#connectTimeout) || (this.#connectTimeout <= 0))
			throw new RangeError("invalid connectTimeout");
		this.#onStateChanged = options.onStateChanged;
		if ((options.onAuthRequired !== undefined) && (typeof options.onAuthRequired !== "function"))
			throw new TypeError("onAuthRequired must be a function");
		this.#onAuthRequired = options.onAuthRequired;
		this.#onError = options.onError;
		this.#native = new NativeManager(options);
	}

	get _native() { return this.#native; }
	get state() { return this.#state; }
	get authURL() { return this.#authURL; }
	get vpnAddress() { return this.#native?.vpnAddress; }
	get peers() {
		const peers = [];
		for (let index = 0, count = this.#native.peerCount; index < count; index++) {
			const peer = this.#native.getPeer(index);
			if (peer)
				peers.push(peer);
		}
		return peers;
	}
	get ws() {
		return {
			dns: {io: TailnetResolver, manager: this},
			socket: {io: TailnetTCP, manager: this, connectTimeout: 30000},
		};
	}

	#setState(state) {
		if (state === this.#state)
			return;
		this.#state = state;
		if (state !== "error")
			this.#reportedError = undefined;
		this.#onStateChanged?.call(this, state);
	}

	#error(message) {
		const error = new Error(message);
		if (message !== this.#reportedError) {
			this.#reportedError = message;
			this.#onError?.call(this, error);
		}
		return error;
	}

	#ensureTimer() {
		if (this.#timer === undefined)
			this.#timer = Timer.repeat(() => this.#poll(), 250);
	}

	#poll() {
		if (!this.#native)
			return;
		const now = Date.now();
		if (this.#closing) {
			if (this.#native.closed) {
				this.#native.release();
				this.#native = undefined;
				this.#closing = false;
				this.#setState("closed");
				this.#closeResult?.resolve();
				this.#closeResult = undefined;
				Timer.clear(this.#timer);
				this.#timer = undefined;
			}
			return;
		}

		const nativeState = STATE_NAMES[this.#native.state] ?? "error";
		const state = this.#rebindResult && (nativeState === "connected") && (now < this.#rebindNotBefore)
			? "reconnecting"
			: nativeState;
		const authURL = this.#native.authURL;
		const authChanged = authURL !== this.#authURL;
		this.#authURL = authURL;
		this.#setState(state);
		if (authChanged && authURL)
			this.#onAuthRequired?.call(this, authURL);
		if (state === "error") {
			const error = this.#error(this.#native.errorMessage || NATIVE_ERRORS[this.#native.error] || "MicroLink connection failed");
			this.#startResult?.reject(error);
			this.#rebindResult?.reject(error);
			this.#startResult = this.#rebindResult = undefined;
			this.#startTimeoutRemaining = undefined;
			return;
		}
		const waitingForUser = (state === "needs-auth") || (state === "needs-approval");
		if (this.#startResult && waitingForUser && (this.#startDeadline !== undefined)) {
			this.#startTimeoutRemaining = Math.max(0, this.#startDeadline - now);
			this.#startDeadline = undefined;
		}
		else if (this.#startResult && !waitingForUser && (this.#startDeadline === undefined)) {
			this.#startDeadline = now + (this.#startTimeoutRemaining ?? this.#connectTimeout);
			this.#startTimeoutRemaining = undefined;
		}
		if (this.#startResult && (state === "connected")) {
			this.#startResult.resolve(this);
			this.#startResult = undefined;
			this.#startTimeoutRemaining = undefined;
		}
		else if (this.#startResult && (this.#startDeadline !== undefined) && (now >= this.#startDeadline)) {
			this.#startResult.reject(this.#error("Tailnet connection timed out"));
			this.#startResult = undefined;
			this.#startTimeoutRemaining = undefined;
		}
		if (this.#rebindResult && (state === "connected") && (now >= this.#rebindNotBefore)) {
			this.#rebindResult.resolve(this);
			this.#rebindResult = undefined;
		}
		else if (this.#rebindResult && (now >= this.#rebindDeadline)) {
			this.#rebindResult.reject(this.#error("Tailnet rebind timed out"));
			this.#rebindResult = undefined;
		}
	}

	start() {
		if (this.#state !== "idle")
			throw new Error("Tailnet already started");
		this.#native.start();
		this.#setState("connecting");
		this.#startResult = Promise.withResolvers();
		this.#startTimeoutRemaining = undefined;
		this.#startDeadline = Date.now() + this.#connectTimeout;
		this.#ensureTimer();
		return this.#startResult.promise;
	}

	rebind() {
		if (this.#state !== "connected")
			throw new Error("Tailnet is not connected");
		if (this.#rebindResult)
			return this.#rebindResult.promise;
		this.#native.rebind();
		this.#setState("reconnecting");
		this.#rebindResult = Promise.withResolvers();
		this.#rebindNotBefore = Date.now() + 500;
		this.#rebindDeadline = Date.now() + this.#connectTimeout;
		this.#ensureTimer();
		return this.#rebindResult.promise;
	}

	close() {
		if (!this.#native)
			return Promise.resolve();
		if (this.#closeResult)
			return this.#closeResult.promise;
		const error = new Error("Tailnet closed");
		this.#startResult?.reject(error);
		this.#rebindResult?.reject(error);
		this.#startResult = this.#rebindResult = undefined;
		this.#startTimeoutRemaining = undefined;
		this.#closeResult = Promise.withResolvers();
		this.#closing = true;
		this.#native.close();
		this.#ensureTimer();
		return this.#closeResult.promise;
	}

	resolve(host) {
		if (typeof host !== "string")
			throw new TypeError("host must be a string");
		if (parseIPv4(host))
			return isTailnetIPv4(host) ? host : undefined;
		return this.#native.resolve(host);
	}

	connect(options) {
		if (this.#state !== "connected")
			return Promise.reject(new Error("Tailnet is not connected"));
		if (!options || !Number.isInteger(options.port) || (options.port <= 0) || (options.port > 65535))
			return Promise.reject(new RangeError("invalid port"));
		const address = this.resolve(options.host);
		if (!address)
			return Promise.reject(new Error(`Tailnet host not found: ${options.host}`));
		return createStreams(this, address, {
			port: options.port,
			connectTimeout: options.connectTimeout ?? 30000,
		});
	}

	openDatagram(options = {}) {
		if (this.#state !== "connected")
			throw new Error("Tailnet is not connected");
		return new UDP({...options, tailnet: this});
	}

	static factoryReset() { return NativeManager.factoryReset(); }

	static {
		this.prototype[Symbol.asyncDispose] = this.prototype.close;
	}
}

export {TailnetTCP, TailnetResolver, UDP};
export default Tailnet;

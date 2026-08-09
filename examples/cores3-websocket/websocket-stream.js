/*
 * Copyright (c) 2026 Moddable Tech, Inc.
 *
 * Derived from the Moddable SDK WebSocketStream implementation under the
 * GNU Lesser General Public License version 3 or later.
 */

import {ReadableStream, WritableStream} from "web/streams";
import URL from "url";

class WebSocketStream {
	#protocol = "";
	#extensions = "";
	#url = "";

	#client = null;
	#state = 0;
	#closed = null;
	#opened = null;

	#readable = null;
	#readableBuffer = null;
	#readableController = null;
	#readableLength = 0;
	#readableOptions = null;

	#writable = null;
	#writableController = null;
	#writableBuffers = [];
	#writableLength = 0;

	constructor(href, options) {
		let protocol;
		const url = new URL(href);
		const scheme = url.protocol;
		let port;
		let config;
		if (scheme === "ws:") {
			port = url.port || 80;
			config = {...(options?.ws ?? device.network.ws)};
		}
		else if (scheme === "wss:") {
			port = url.port || 443;
			config = {...(options?.wss ?? device.network.wss)};
		}
		else
			throw new URIError("only ws or wss");

		const host = url.hostname;
		let path = url.pathname;
		const query = url.search;
		if (query)
			path += query;
		this.#url = href;

		protocol = options?.protocols;
		this.#closed = Promise.withResolvers();
		this.#opened = Promise.withResolvers();

		options = {...config, host, port, path, protocol};
		this.#client = new device.network.ws.io({
			...options,
			onControl: (opcode, data) => {
				switch (opcode) {
					case this.#client.constructor.close:
						if (this.#state < 3) {
							const error = new Error("WebSocket closed");
							this.#state = 3;
							this.#readableController.close();
							this.#drainWritable();
							data = new Uint8Array(data);
							this.#closed.resolve({
								closeCode: (data[0] << 8) | data[1],
								reason: String.fromArrayBuffer(data.buffer.slice(2)),
							});
						}
						break;
					case this.#client.constructor.ping:
						// WebSocketClient automatically queues the RFC 6455 pong with
						// the same payload after this control callback returns.
						break;
					case this.#client.constructor.pong:
						break;
				}
			},
			onReadable: (count, readableOptions) => {
				if (!count || (this.#state === 0))
					return;
				if (this.#readableController.desiredSize > 0)
					this.#read(count, readableOptions);
				else {
					this.#readableLength = count;
					this.#readableOptions = readableOptions;
				}
			},
			onWritable: count => {
				this.#writableLength = count;
				if (this.#state === 0) {
					this.#state = 1;
					this.#opened.resolve({
						readable: this.#readable,
						writable: this.#writable,
						protocol: this.#protocol,
						extensions: this.#extensions,
					});
					return;
				}

				const buffers = this.#writableBuffers;
				while (buffers.length) {
					const buffer = buffers[0];
					const writeOptions = buffer.options;
					const writeData = buffer.data;
					const offset = buffer.offset;
					const dataLength = writeData.byteLength - offset;
					const writableLength = this.#writableLength;
					if (dataLength <= writableLength) {
						const data = offset
							? new Uint8Array(writeData, offset, dataLength)
							: writeData;
						this.#writableLength = this.#clientWrite(data, writeOptions);
						buffer.result?.resolve();
						buffers.shift();
					}
					else if (writableLength > 0) {
						const moreOptions = {...writeOptions, more: true};
						const data = new Uint8Array(writeData, offset, writableLength);
						this.#writableLength = this.#clientWrite(data, moreOptions);
						buffer.offset += writableLength;
						break;
					}
					else
						break;
				}
			},
			onClose() {},
			onError: () => {
				const error = new Error("WebSocket error");
				if (this.#state === 0)
					this.#opened.reject(error);
				if (this.#state < 3) {
					this.#state = 3;
					// XS's WritableStream can remain in an erroring state forever when
					// its sink has an in-flight promise. Treat a transport failure as
					// an abnormal close and let the owner reconnect instead.
					this.#readableController.close();
					this.#drainWritable();
					this.#closed.resolve({closeCode: 1006, reason: error.message});
				}
			},
		});

		this.#readable = new ReadableStream({
			start: controller => {
				this.#readableController = controller;
			},
			pull: () => {
				if (this.#state === 3)
					throw new Error("WebSocket closed");
				const count = this.#readableLength;
				const readableOptions = this.#readableOptions;
				if (count && readableOptions) {
					this.#readableLength = 0;
					this.#readableOptions = null;
					this.#read(count, readableOptions);
				}
			},
			cancel: (reason = "ReadableStream canceled") => {
				if (this.#state === 1)
					this.close({closeCode: 4000, reason});
			},
		});
		this.#writable = new WritableStream({
			start: controller => {
				this.#writableController = controller;
			},
			write: data => {
				if (this.#state === 2)
					throw new Error("WebSocket closing");
				if (this.#state === 3)
					throw new Error("WebSocket closed");
				let binary = false;
				if (data instanceof ArrayBuffer)
					binary = true;
				else if ((data instanceof DataView) || (data instanceof TypedArray)) {
					binary = true;
					if ((data.byteOffset === 0) && (data.byteLength === data.buffer.byteLength))
						data = data.buffer;
					else
						data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
				}
				else
					data = ArrayBuffer.fromString(data);
				const buffer = this.#write(data, {binary});
				if (buffer) {
					buffer.result = Promise.withResolvers();
					return buffer.result.promise;
				}
			},
			close: () => {
				if (this.#state === 1)
					this.close({closeCode: 4001, reason: "WritableStream closed"});
			},
			abort: (reason = "WritableStream aborted") => {
				if (this.#state === 1)
					this.close({closeCode: 4002, reason});
			},
		});
	}

	get opened() {
		return this.#opened.promise;
	}

	get closed() {
		return this.#closed.promise;
	}

	get url() {
		return this.#url;
	}

	close(options) {
		let code = options?.closeCode;
		let reason = options?.reason;
		if (code === undefined) {
			code = 1000;
			reason = "";
		}
		else {
			if ((code !== 1000) && ((code < 3000) || (code > 4999)))
				throw new Error(`invalid code: ${code}`);
			if (reason === undefined)
				throw new Error("code but no reason");
		}
		reason = ArrayBuffer.fromString(reason);
		if (reason.byteLength > 123)
			throw new Error("too long reason");
		if (this.#state === 1) {
			let data = new Uint8Array(2);
			data[0] = code >> 8;
			data[1] = code & 0xFF;
			data = data.buffer.concat(reason);
			this.#write(data, {opcode: this.#client.constructor.close});
			this.#state = 2;
		}
	}

	#drainWritable() {
		const buffers = this.#writableBuffers;
		while (buffers.length)
			buffers.shift().result?.resolve();
	}

	#read(count, options) {
		let data = this.#clientRead(count);
		let buffer = this.#readableBuffer;
		if (buffer)
			buffer = buffer.concat(data);
		else
			buffer = data;
		if (!options.more) {
			if (options.binary)
				data = new Uint8Array(buffer);
			else
				data = String.fromArrayBuffer(buffer);
			this.#readableBuffer = null;
			this.#readableController.enqueue(data);
		}
		else
			this.#readableBuffer = buffer;
	}

	#write(data, options) {
		const buffers = this.#writableBuffers;
		let buffer = null;
		if (buffers.length)
			buffer = {data, offset: 0, options};
		else {
			const dataLength = data.byteLength;
			const writableLength = this.#writableLength;
			if (dataLength <= writableLength)
				this.#writableLength = this.#clientWrite(data, options);
			else if (writableLength > 0) {
				const moreOptions = {...options, more: true};
				this.#writableLength = this.#clientWrite(new Uint8Array(data, 0, writableLength), moreOptions);
				buffer = {data, offset: writableLength, options};
			}
			else
				buffer = {data, offset: 0, options};
		}
		if (buffer)
			buffers.push(buffer);
		return buffer;
	}

	#clientRead(count) {
		return this.#client.read(count);
	}

	#clientWrite(buffer, options) {
		return this.#client.write(buffer, options);
	}
}

export default WebSocketStream;

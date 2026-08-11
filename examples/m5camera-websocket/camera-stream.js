import Camera from "embedded:io/image/in/camera";
import Timer from "timer";

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 240;
const DEFAULT_FPS = 1;
const WRITE_TIMEOUT = 30_000;

function writeWithTimeout(socket, value) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer;
		const finish = error => {
			if (settled)
				return;
			settled = true;
			Timer.clear(timer);
			if (error)
				reject(error);
			else
				resolve();
		};
		timer = Timer.set(() => finish(new Error("WebSocket write timed out")), WRITE_TIMEOUT);
		try {
			socket.send(value, {onComplete: () => finish(), onError: finish});
		}
		catch (error) {
			finish(error);
		}
	});
}

export default class CameraStream {
	constructor(options = {}) {
		this.width = options.width ?? DEFAULT_WIDTH;
		this.height = options.height ?? DEFAULT_HEIGHT;
		this.fps = options.fps ?? DEFAULT_FPS;
		this.interval = Math.round(1_000 / this.fps);
		this.onStateChanged = options.onStateChanged;
		this.onFrameSent = options.onFrameSent;
		this.camera = undefined;
		this.framesSent = 0;
	}

	setFPS(fps) {
		if (!Number.isInteger(fps) || (fps < 1) || (fps > 8))
			throw new RangeError("fps must be between 1 and 8");
		if (this.fps === fps)
			return this.fps;
		this.fps = fps;
		this.interval = Math.round(1_000 / fps);
		this.onStateChanged?.("rate", {fps, interval: this.interval});
		return this.fps;
	}

	async run(socket, isConnected, hello, options = {}) {
		try {
			try {
				this.start();
			}
			catch (error) {
				await writeWithTimeout(socket, JSON.stringify({
					type: "camera.error",
					message: String(error),
				}));
				throw error;
			}
			await writeWithTimeout(socket, JSON.stringify({
				...hello,
				camera: {
					format: "jpeg",
					width: this.width,
					height: this.height,
					fps: this.fps,
				},
			}));
			this.onStateChanged?.("streaming", {
				width: this.width,
				height: this.height,
				fps: this.fps,
			});
			await this.streamFrames(socket, isConnected);
		}
		finally {
			if (options.keepCameraOpen)
				this.onStateChanged?.("waiting");
			else
				this.close();
		}
	}

	streamFrames(socket, isConnected) {
		let nextFrameAt = Date.now() + this.interval;
		return new Promise((resolve, reject) => {
			let timer;
			let writeTimer;
			let settled = false;
			let pendingFrame;
			let pendingInterval;
			let pendingByteLength;

			const clearWriteTimer = () => {
				if (!writeTimer)
					return;
				Timer.clear(writeTimer);
				writeTimer = undefined;
			};

			const finish = error => {
				if (settled)
					return;
				settled = true;
				if (timer)
					Timer.clear(timer);
				clearWriteTimer();
				if (error)
					reject(error);
				else
					resolve();
			};

			const onWriteTimeout = () => {
				writeTimer = undefined;
				finish(new Error("WebSocket frame write timed out"));
			};

			const schedule = () => {
				if (!isConnected()) {
					finish();
					return;
				}
				timer = Timer.set(sendFrame, Math.max(1, nextFrameAt - Date.now()));
			};

			const advance = interval => {
				if (this.interval !== interval)
					nextFrameAt = Date.now() + this.interval;
				else if ((Date.now() - nextFrameAt) > interval)
					nextFrameAt = Date.now() + interval;
				schedule();
			};

			const onWriteComplete = () => {
				const frame = pendingFrame;
				const interval = pendingInterval;
				const byteLength = pendingByteLength;
				pendingFrame = undefined;
				clearWriteTimer();
				frame?.close?.();
				if (settled)
					return;
				this.framesSent += 1;
				this.onFrameSent?.(this.framesSent, byteLength);
				advance(interval);
			};

			const onWriteError = error => {
				const frame = pendingFrame;
				pendingFrame = undefined;
				clearWriteTimer();
				frame?.close?.();
				finish(error);
			};

			// Only one frame is in flight, so these callback records can be reused
			// for the whole session instead of allocating closures at camera rate.
			const sendCallbacks = {onComplete: onWriteComplete, onError: onWriteError};

			const sendFrame = () => {
				timer = undefined;
				if (!isConnected()) {
					finish();
					return;
				}
				const interval = this.interval;
				nextFrameAt += interval;
				const frame = this.takeLatestFrame();
				if (!frame) {
					this.onStateChanged?.("waiting");
					advance(interval);
					return;
				}

				const bytes = new Uint8Array(frame);
				const byteLength = bytes.byteLength;
				if ((bytes.byteLength < 4) || (bytes[0] !== 0xFF) || (bytes[1] !== 0xD8) ||
					(bytes[bytes.byteLength - 2] !== 0xFF) || (bytes[bytes.byteLength - 1] !== 0xD9)) {
					frame.close?.();
					finish(new Error("OV2640 returned an invalid JPEG"));
					return;
				}

				pendingFrame = frame;
				pendingInterval = interval;
				pendingByteLength = byteLength;
				writeTimer = Timer.set(onWriteTimeout, WRITE_TIMEOUT);
				try {
					socket.send(bytes, sendCallbacks);
				}
				catch (error) {
					pendingFrame = undefined;
					clearWriteTimer();
					frame.close?.();
					finish(error);
				}
			};

			schedule();
		});
	}

	start() {
		if (this.camera)
			return;
		this.onStateChanged?.("starting");
		const camera = new Camera({
			width: this.width,
			height: this.height,
			imageType: "jpeg",
			format: "buffer/disposable",
		});
		this.camera = camera;
		this.width = camera.width;
		this.height = camera.height;
		camera.start();
	}

	takeLatestFrame() {
		// Poll at the requested stream rate. The ESP32 camera task retains up to
		// three native frames, so an onReadable callback for every sensor frame is
		// unnecessary and can overwhelm the shared JS event queue at 8 fps.
		return this.camera?.read();
	}

	close() {
		if (this.camera) {
			this.camera.stop();
			this.camera.close();
			this.camera = undefined;
		}
		this.onStateChanged?.("stopped");
	}
}

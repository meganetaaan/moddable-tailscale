import Camera from "embedded:io/image/in/camera";
import Bitmap from "commodetto/Bitmap";
import encodeJPEG from "jpeg-encoder";
import Timer from "timer";

const DEFAULT_WIDTH = 240;
const DEFAULT_HEIGHT = 176;
const DEFAULT_FPS = 1;
const DEFAULT_JPEG_QUALITY = 50;
const WRITE_TIMEOUT = 10_000;

function delay(milliseconds) {
	return new Promise(resolve => Timer.set(resolve, milliseconds));
}

function writeWithTimeout(writer, value) {
	return new Promise((resolve, reject) => {
		const timer = Timer.set(() => reject(new Error("WebSocket write timed out")), WRITE_TIMEOUT);
		writer.write(value).then(
			result => {
				Timer.clear(timer);
				resolve(result);
			},
			error => {
				Timer.clear(timer);
				reject(error);
			},
		);
	});
}

export default class CameraStream {
	constructor(options = {}) {
		this.width = options.width ?? DEFAULT_WIDTH;
		this.height = options.height ?? DEFAULT_HEIGHT;
		this.fps = options.fps ?? DEFAULT_FPS;
		this.interval = Math.round(1_000 / this.fps);
		this.quality = options.quality ?? DEFAULT_JPEG_QUALITY;
		this.onStateChanged = options.onStateChanged;
		this.camera = undefined;
		this.latestFrame = undefined;
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

	async run(writer, isConnected, hello, options = {}) {
		let nextFrameAt = Date.now() + this.interval;
		try {
			try {
				this.start();
			}
			catch (error) {
				await writeWithTimeout(writer, JSON.stringify({
					type: "camera.error",
					message: String(error),
				}));
				throw error;
			}
			await writeWithTimeout(writer, JSON.stringify({
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

			while (isConnected()) {
				const interval = this.interval;
				const wait = nextFrameAt - Date.now();
				if (wait > 0)
					await delay(wait);
				nextFrameAt += interval;
				const frame = this.takeLatestFrame();
				if (!frame) {
					this.onStateChanged?.("waiting");
					continue;
				}

				let jpeg;
				try {
					jpeg = encodeJPEG(frame, this.width, this.height, this.quality);
				}
				finally {
					frame.close?.();
				}

				try {
					const bytes = new Uint8Array(jpeg);
					await writeWithTimeout(writer, bytes);
					this.framesSent += 1;
					this.onStateChanged?.("frame", {
						frameNumber: this.framesSent,
						byteLength: bytes.byteLength,
					});
				}
				finally {
					jpeg = undefined;
				}

				// Avoid burst catch-up after temporary network or encoding stalls.
				if (this.interval !== interval)
					nextFrameAt = Date.now() + this.interval;
				else if ((Date.now() - nextFrameAt) > interval)
					nextFrameAt = Date.now() + interval;
			}
		}
		finally {
			if (options.keepCameraOpen)
				this.onStateChanged?.("waiting");
			else
				this.close();
		}
	}

	start() {
		if (this.camera)
			return;
		this.onStateChanged?.("starting");
		const camera = new Camera({
			width: this.width,
			height: this.height,
			// CoreS3's GC0308 emits raw pixels, so JPEG is encoded in software.
			imageType: Bitmap.RGB565LE,
			format: "buffer/disposable",
			onReadable: () => {
				const frame = camera.read();
				if (!frame)
					return;
				// Keep the driver queue moving while the network is unavailable.
				// Disposable frames must be returned before all native slots fill.
				this.latestFrame?.close?.();
				this.latestFrame = frame;
			},
		});
		this.camera = camera;
		this.width = camera.width;
		this.height = camera.height;
		camera.start();
	}

	takeLatestFrame() {
		let frame = this.latestFrame;
		this.latestFrame = undefined;
		// onReadable notifications may already have been consumed while a frame
		// was pending. Pull one queued native frame directly on the next tick.
		if (!frame && this.camera)
			frame = this.camera.read();
		return frame;
	}

	close() {
		this.latestFrame?.close?.();
		this.latestFrame = undefined;
		if (this.camera) {
			this.camera.stop();
			this.camera.close();
			this.camera = undefined;
		}
		this.onStateChanged?.("stopped");
	}
}

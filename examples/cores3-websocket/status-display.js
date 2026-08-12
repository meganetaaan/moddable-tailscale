import Poco from "commodetto/Poco";
import parseBMF from "commodetto/parseBMF";
import qrCode from "qrcode";
import Resource from "Resource";
import Timer from "timer";

const rowDefinitions = [
	["wifi", "Wi-Fi"],
	["tailnet", "Tailnet"],
	["address", "Address"],
	["websocket", "WebSocket"],
	["camera", "Camera"],
];

export default class StatusDisplay {
	constructor() {
		this.render = new Poco(screen, {displayListLength: 2048});
		this.font = parseBMF(new Resource("OpenSans-Semibold-18.bf4"));
		this.colors = {
			background: this.render.makeColor(10, 18, 30),
			header: this.render.makeColor(20, 48, 78),
			row: this.render.makeColor(18, 30, 46),
			alternateRow: this.render.makeColor(23, 37, 55),
			label: this.render.makeColor(155, 178, 202),
			text: this.render.makeColor(239, 245, 251),
			pending: this.render.makeColor(245, 166, 35),
			ok: this.render.makeColor(44, 204, 113),
			error: this.render.makeColor(239, 83, 80),
			info: this.render.makeColor(64, 156, 255),
		};
		this.rows = new Map(rowDefinitions.map(([key, label]) => [key, {
			label,
			text: "WAITING",
			tone: "pending",
		}]));
		this.headerHeight = 40;
		this.rowHeight = 40;
		this.labelX = 18;
		this.valueX = 112;
		this.draw();
	}

	set(key, text, tone = "pending") {
		const row = this.rows.get(key);
		if (!row)
			return;
		text = String(text);
		if ((row.text === text) && (row.tone === tone))
			return;
		row.text = text;
		row.tone = tone;
		if (this.overlay || this.authURL || this.approvalPending)
			return;
		this.drawRow(rowDefinitions.findIndex(([name]) => name === key));
	}

	message(title, detail, tone = "info", duration = 10_000) {
		if (this.overlayTimer)
			Timer.clear(this.overlayTimer);
		this.overlay = {title: String(title), detail: String(detail), tone};
		this.drawOverlay();
		if (duration > 0) {
			this.overlayTimer = Timer.set(() => {
				this.overlayTimer = undefined;
				this.overlay = undefined;
				this.draw();
			}, duration);
		}
	}

	identify(deviceId, duration = 3_000) {
		this.message("IDENTIFY", deviceId, "info", duration);
	}

	tailnetError(detail) {
		this.message("TAILNET ERROR", detail, "error", 10_000);
	}

	authRequired(url) {
		if (this.overlayTimer) {
			Timer.clear(this.overlayTimer);
			this.overlayTimer = undefined;
		}
		this.overlay = undefined;
		this.approvalPending = false;
		this.authURL = String(url);
		this.drawAuth();
	}

	approvalRequired() {
		this.authURL = undefined;
		this.overlay = undefined;
		this.approvalPending = true;
		this.drawApproval();
	}

	clearAuth() {
		if (!this.authURL && !this.approvalPending)
			return;
		this.authURL = undefined;
		this.approvalPending = false;
		this.draw();
	}

	draw() {
		if (this.authURL) {
			this.drawAuth();
			return;
		}
		if (this.approvalPending) {
			this.drawApproval();
			return;
		}
		if (this.overlay) {
			this.drawOverlay();
			return;
		}
		const render = this.render;
		const colors = this.colors;
		render.begin();
		render.fillRectangle(colors.background, 0, 0, render.width, render.height);
		render.fillRectangle(colors.header, 0, 0, render.width, this.headerHeight);
		render.drawText("Moddable Tailscale", this.font, colors.text, 14, 9);
		render.end();
		for (let index = 0; index < rowDefinitions.length; index++)
			this.drawRow(index);
	}

	drawAuth() {
		const render = this.render;
		const white = render.makeColor(255, 255, 255);
		const black = render.makeColor(0, 0, 0);
		const panel = this.colors.header;
		let qr;
		try {
			qr = qrCode({input: this.authURL, maxVersion: 20});
		}
		catch {
			this.approvalPending = true;
			this.authURL = undefined;
			this.drawApproval("AUTH URL TOO LONG");
			return;
		}
		const area = Math.min(216, render.height - 16);
		const pixels = Math.max(1, Math.idiv(area - 16, qr.size));
		const size = qr.size * pixels;
		const x = 8 + ((area - size) >> 1);
		const y = (render.height - size) >> 1;
		render.begin();
		render.fillRectangle(white, 0, 0, area + 16, render.height);
		render.fillRectangle(panel, area + 16, 0, render.width - area - 16, render.height);
		render.drawQRCode(qr, x, y, pixels, black);
		render.drawText("TAILSCALE", this.font, this.colors.text, area + 24, 58);
		render.drawText("SCAN", this.font, this.colors.ok, area + 24, 98);
		render.drawText("TO LOGIN", this.font, this.colors.text, area + 24, 132);
		render.end();
	}

	drawApproval(title = "APPROVAL REQUIRED") {
		const render = this.render;
		const colors = this.colors;
		const heading = this.fitText(title, render.width - 24);
		const detail = "Approve in Tailscale admin";
		render.begin();
		render.fillRectangle(colors.info, 0, 0, render.width, render.height);
		render.drawText(heading, this.font, colors.text,
			(render.width - render.getTextWidth(heading, this.font)) >> 1, 80);
		render.drawText(detail, this.font, colors.text,
			(render.width - render.getTextWidth(detail, this.font)) >> 1, 122);
		render.end();
	}

	drawOverlay() {
		const render = this.render;
		const colors = this.colors;
		const background = colors[this.overlay.tone] ?? colors.info;
		const title = this.fitText(this.overlay.title, render.width - 24);
		const detail = this.fitText(this.overlay.detail, render.width - 24);
		const titleWidth = render.getTextWidth(title, this.font);
		const detailWidth = render.getTextWidth(detail, this.font);
		render.begin();
		render.fillRectangle(background, 0, 0, render.width, render.height);
		render.drawText(title, this.font, colors.text, (render.width - titleWidth) >> 1, 78);
		render.drawText(detail, this.font, colors.text, (render.width - detailWidth) >> 1, 122);
		render.end();
	}

	drawRow(index) {
		const render = this.render;
		const colors = this.colors;
		const row = this.rows.get(rowDefinitions[index][0]);
		const y = this.headerHeight + (index * this.rowHeight);
		const background = index & 1 ? colors.alternateRow : colors.row;
		const textY = y + ((this.rowHeight - this.font.height) >> 1);
		const maxValueWidth = render.width - this.valueX - 8;
		const text = this.fitText(row.text, maxValueWidth);

		render.begin(0, y, render.width, this.rowHeight);
		render.fillRectangle(background, 0, y, render.width, this.rowHeight);
		render.fillRectangle(colors[row.tone] ?? colors.pending, 0, y, 6, this.rowHeight);
		render.drawText(row.label, this.font, colors.label, this.labelX, textY);
		render.drawText(text, this.font, colors.text, this.valueX, textY);
		render.end();
	}

	fitText(text, maxWidth) {
		if (this.render.getTextWidth(text, this.font) <= maxWidth)
			return text;
		while (text.length && (this.render.getTextWidth(`${text}...`, this.font) > maxWidth))
			text = text.slice(0, -1);
		return `${text}...`;
	}
}

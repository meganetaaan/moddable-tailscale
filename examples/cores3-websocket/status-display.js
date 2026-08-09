import Poco from "commodetto/Poco";
import parseBMF from "commodetto/parseBMF";
import Resource from "Resource";

const rowDefinitions = [
	["wifi", "Wi-Fi"],
	["tailnet", "Tailnet"],
	["address", "Address"],
	["websocket", "WebSocket"],
	["echo", "Echo"],
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
		this.drawRow(rowDefinitions.findIndex(([name]) => name === key));
	}

	draw() {
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

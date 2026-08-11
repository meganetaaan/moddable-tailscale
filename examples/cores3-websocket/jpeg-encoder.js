export default function encodeJPEG(source, width, height, quality = 50) {
	return native("xs_cores3_encode_jpeg").call(null, source, width, height, quality);
}

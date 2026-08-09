#include "xsmc.h"

#include "img_converters.h"
#include "sensor.h"

#include <stdlib.h>

void xs_cores3_encode_jpeg(xsMachine *the)
{
	uint8_t *source;
	xsUnsignedValue sourceLength;
	uint8_t *jpeg = NULL;
	size_t jpegLength = 0;
	int width = xsmcToInteger(xsArg(1));
	int height = xsmcToInteger(xsArg(2));
	int quality = xsmcToInteger(xsArg(3));

	if ((width <= 0) || (height <= 0))
		xsRangeError("invalid dimensions");
	if ((quality < 1) || (quality > 100))
		xsRangeError("invalid JPEG quality");

	xsmcGetBufferReadable(xsArg(0), (void **)&source, &sourceLength);
	if (sourceLength < ((xsUnsignedValue)width * height * 2))
		xsRangeError("RGB565 frame too small");

	// The Moddable camera API exposes RGB565LE after swapping the sensor bytes.
	jpgSetRgb565BE(false);
	if (!fmt2jpg(source, sourceLength, width, height, PIXFORMAT_RGB565,
			quality, &jpeg, &jpegLength))
		xsUnknownError("JPEG encode failed");

	xsmcSetArrayBuffer(xsResult, jpeg, jpegLength);
	free(jpeg);
}

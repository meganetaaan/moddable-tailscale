#include "xsmc.h"
#include "mc.xs.h"

#include "esp_mac.h"
#include "esp_system.h"
#include "usb_serial_jtag.h"
#include "freertos/FreeRTOS.h"
#include "nvs.h"
#include "nvs_flash.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CONFIG_NAMESPACE "stackcam"
#define CONFIG_KEY "config"
#define CONFIG_MAX_BYTES 1536
#define USB_READ_MAX 256

static bool gNVSInitialized;
static bool gUSBInitialized;

static bool ensure_usb(void) {
#ifdef mxDebug
	return false;
#else
	if (!gUSBInitialized) {
		usb_serial_jtag_driver_config_t config = {
			.rx_buffer_size = 1024,
			.tx_buffer_size = 1024,
		};
		esp_err_t err = usb_serial_jtag_driver_install(&config);
		if ((err != ESP_OK) && (err != ESP_ERR_INVALID_STATE))
			return false;
		gUSBInitialized = true;
	}
	return true;
#endif
}

static void ensure_nvs(xsMachine *the) {
	esp_err_t err;
	if (gNVSInitialized)
		return;
	err = nvs_flash_init();
	if (err != ESP_OK)
		xsUnknownError("cannot initialize provisioning NVS");
	gNVSInitialized = true;
}

void xs_device_config_base_mac(xsMachine *the) {
	uint8_t mac[6];
	char text[13];
	if (esp_efuse_mac_get_default(mac) != ESP_OK)
		xsUnknownError("cannot read eFuse MAC");
	for (int index = 0; index < 6; index++) {
		static const char hex[] = "0123456789abcdef";
		text[index * 2] = hex[mac[index] >> 4];
		text[(index * 2) + 1] = hex[mac[index] & 15];
	}
	text[12] = 0;
	xsmcSetString(xsResult, text);
}

void xs_device_config_load(xsMachine *the) {
	nvs_handle_t handle;
	size_t length = 0;
	char *value;
	esp_err_t err;

	ensure_nvs(the);
	err = nvs_open(CONFIG_NAMESPACE, NVS_READONLY, &handle);
	if (err == ESP_ERR_NVS_NOT_FOUND)
		return;
	if (err != ESP_OK)
		xsUnknownError("cannot open provisioning NVS");
	err = nvs_get_str(handle, CONFIG_KEY, NULL, &length);
	if (err == ESP_ERR_NVS_NOT_FOUND) {
		nvs_close(handle);
		return;
	}
	if ((err != ESP_OK) || !length || (length > CONFIG_MAX_BYTES)) {
		nvs_close(handle);
		xsUnknownError("invalid provisioning NVS value");
	}
	value = malloc(length);
	if (!value) {
		nvs_close(handle);
		xsUnknownError("no memory for provisioning config");
	}
	err = nvs_get_str(handle, CONFIG_KEY, value, &length);
	nvs_close(handle);
	if (err != ESP_OK) {
		free(value);
		xsUnknownError("cannot read provisioning config");
	}
	xsmcSetString(xsResult, value);
	free(value);
}

void xs_device_config_save(xsMachine *the) {
	nvs_handle_t handle;
	const char *value = xsmcToString(xsArg(0));
	size_t length = strlen(value) + 1;
	esp_err_t err;
	if (length > CONFIG_MAX_BYTES)
		xsRangeError("provisioning config is too large");
	ensure_nvs(the);
	if (nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK)
		xsUnknownError("cannot open provisioning NVS");
	err = nvs_set_str(handle, CONFIG_KEY, value);
	if (err == ESP_OK)
		err = nvs_commit(handle);
	nvs_close(handle);
	if (err != ESP_OK)
		xsUnknownError("cannot save provisioning config");
	xsmcSetBoolean(xsResult, true);
}

void xs_device_config_clear(xsMachine *the) {
	nvs_handle_t handle;
	esp_err_t err;
	ensure_nvs(the);
	err = nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &handle);
	if (err == ESP_ERR_NVS_NOT_FOUND) {
		xsmcSetBoolean(xsResult, true);
		return;
	}
	if (err != ESP_OK)
		xsUnknownError("cannot open provisioning NVS");
	err = nvs_erase_all(handle);
	if (err == ESP_OK)
		err = nvs_commit(handle);
	nvs_close(handle);
	if (err != ESP_OK)
		xsUnknownError("cannot clear provisioning config");
	xsmcSetBoolean(xsResult, true);
}

void xs_device_config_restart(xsMachine *the) {
	esp_restart();
}

void xs_device_config_usb_read(xsMachine *the) {
	char value[USB_READ_MAX + 1];
	int count = ensure_usb()
		? usb_serial_jtag_read_bytes(value, USB_READ_MAX, 0)
		: 0;
	if (count) {
		value[count] = 0;
		xsmcSetStringBuffer(xsResult, value, count);
	}
}

void xs_device_config_usb_write(xsMachine *the) {
	const char *value = xsmcToString(xsArg(0));
	if (ensure_usb())
		usb_serial_jtag_write_bytes(value, strlen(value), pdMS_TO_TICKS(100));
}

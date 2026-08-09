#include "xsmc.h"
#include "mc.xs.h"
#include "mc.defines.h"

#include "esp_mac.h"
#include "esp_system.h"
#include "esp_timer.h"
#if MODDEF_STACKCAM_UART_PROVISIONING
	#include "driver/uart.h"
#else
	#include "usb_serial_jtag.h"
#endif
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
static bool gProvisioningSerialInitialized;
static esp_timer_handle_t gHeartbeatWatchdog;
static uint32_t gHeartbeatWatchdogTicks;
static volatile uint32_t gHeartbeatWatchdogRemaining;

static void heartbeat_watchdog_callback(void *context) {
	(void)context;
	uint32_t remaining = __atomic_load_n(&gHeartbeatWatchdogRemaining, __ATOMIC_RELAXED);
	if (remaining && (__atomic_sub_fetch(&gHeartbeatWatchdogRemaining, 1, __ATOMIC_RELAXED) == 0))
		esp_restart();
}

static bool ensure_usb(void) {
#ifdef mxDebug
	return false;
#else
	if (!gProvisioningSerialInitialized) {
	#if MODDEF_STACKCAM_UART_PROVISIONING
		if (!uart_is_driver_installed(UART_NUM_0)) {
			const uart_config_t config = {
				.baud_rate = 115200,
				.data_bits = UART_DATA_8_BITS,
				.parity = UART_PARITY_DISABLE,
				.stop_bits = UART_STOP_BITS_1,
				.flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
				.source_clk = UART_SCLK_DEFAULT,
			};
			if (uart_param_config(UART_NUM_0, &config) != ESP_OK)
				return false;
			if (uart_driver_install(UART_NUM_0, 1024, 1024, 0, NULL, 0) != ESP_OK)
				return false;
		}
	#else
		usb_serial_jtag_driver_config_t config = {
			.rx_buffer_size = 1024,
			.tx_buffer_size = 1024,
		};
		esp_err_t err = usb_serial_jtag_driver_install(&config);
		if ((err != ESP_OK) && (err != ESP_ERR_INVALID_STATE))
			return false;
	#endif
		gProvisioningSerialInitialized = true;
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

void xs_device_config_watchdog_start(xsMachine *the) {
	int timeout = xsmcToInteger(xsArg(0));
	esp_err_t err;
	if ((timeout < 5000) || (timeout > 300000))
		xsRangeError("invalid heartbeat watchdog timeout");
	if (!gHeartbeatWatchdog) {
		const esp_timer_create_args_t args = {
			.callback = heartbeat_watchdog_callback,
			.name = "stackcam-heartbeat",
		};
		err = esp_timer_create(&args, &gHeartbeatWatchdog);
		if (err != ESP_OK)
			xsUnknownError("cannot create heartbeat watchdog");
	}
	esp_timer_stop(gHeartbeatWatchdog);
	gHeartbeatWatchdogTicks = (timeout + 999) / 1000;
	__atomic_store_n(&gHeartbeatWatchdogRemaining, gHeartbeatWatchdogTicks, __ATOMIC_RELAXED);
	err = esp_timer_start_periodic(gHeartbeatWatchdog, 1000000);
	if (err != ESP_OK)
		xsUnknownError("cannot start heartbeat watchdog");
}

void xs_device_config_watchdog_feed(xsMachine *the) {
	(void)the;
	if (gHeartbeatWatchdogTicks)
		__atomic_store_n(&gHeartbeatWatchdogRemaining, gHeartbeatWatchdogTicks, __ATOMIC_RELAXED);
}

void xs_device_config_watchdog_stop(xsMachine *the) {
	(void)the;
	__atomic_store_n(&gHeartbeatWatchdogRemaining, 0, __ATOMIC_RELAXED);
	if (gHeartbeatWatchdog)
		esp_timer_stop(gHeartbeatWatchdog);
}

void xs_device_config_usb_read(xsMachine *the) {
	char value[USB_READ_MAX + 1];
	int count = 0;
	if (ensure_usb()) {
	#if MODDEF_STACKCAM_UART_PROVISIONING
		count = uart_read_bytes(UART_NUM_0, value, USB_READ_MAX, 0);
	#else
		count = usb_serial_jtag_read_bytes(value, USB_READ_MAX, 0);
	#endif
	}
	if (count) {
		value[count] = 0;
		xsmcSetStringBuffer(xsResult, value, count);
	}
}

void xs_device_config_usb_write(xsMachine *the) {
	const char *value = xsmcToString(xsArg(0));
	if (ensure_usb()) {
	#if MODDEF_STACKCAM_UART_PROVISIONING
		uart_write_bytes(UART_NUM_0, value, strlen(value));
	#else
		usb_serial_jtag_write_bytes(value, strlen(value), pdMS_TO_TICKS(100));
	#endif
	}
}

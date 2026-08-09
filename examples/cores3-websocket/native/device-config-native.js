function baseMac() @ "xs_device_config_base_mac";
function load() @ "xs_device_config_load";
function save(value) @ "xs_device_config_save";
function clear() @ "xs_device_config_clear";
function restart() @ "xs_device_config_restart";
function usbRead() @ "xs_device_config_usb_read";
function usbWrite(value) @ "xs_device_config_usb_write";

export default Object.freeze({baseMac, load, save, clear, restart, usbRead, usbWrite});

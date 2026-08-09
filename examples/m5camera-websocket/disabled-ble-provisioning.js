export default class DisabledBLEProvisioning {
	constructor() {
		throw new Error("BLE provisioning is disabled on headless M5Camera devices");
	}
}

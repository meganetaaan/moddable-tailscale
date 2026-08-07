#include "xsmc.h"
#include "xsHost.h"
#include "mc.xs.h"

#include "microlink.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define TCP_BUFFER_SIZE  (16 * 1024)
#define TCP_IO_CHUNK     1400
#define UDP_QUEUE_SIZE   4
#define UDP_PACKET_SIZE  1400

enum {
	EVENT_READABLE = 1,
	EVENT_WRITABLE = 2,
	EVENT_ERROR = 4,
	EVENT_FINAL = 8,
};

enum {
	MANAGER_START = 1,
	MANAGER_REBIND,
};

typedef struct TailnetManagerRecord TailnetManagerRecord;
typedef struct TailnetTCPRecord TailnetTCPRecord;
typedef struct TailnetUDPRecord TailnetUDPRecord;

typedef struct {
	uint8_t *data;
	size_t capacity;
	size_t read;
	size_t write;
	size_t used;
} ByteRing;

struct TailnetManagerRecord {
	microlink_t *ml;
	QueueHandle_t commands;
	SemaphoreHandle_t mutex;
	TaskHandle_t task;
	TailnetTCPRecord *tcp;
	TailnetUDPRecord *udp;
	char auth_key[128];
	char device_name[64];
	uint32_t priority_peer;
	volatile uint8_t last_error;
	volatile bool start_requested;
	volatile bool stop_requested;
	volatile bool task_running;
	volatile bool tcp_active;
	volatile bool udp_active;
	volatile bool closed;
	volatile bool abandoned;
};

struct TailnetTCPRecord {
	TailnetManagerRecord *manager;
	microlink_tcp_socket_t *socket;
	xsMachine *the;
	xsSlot obj;
	SemaphoreHandle_t mutex;
	TaskHandle_t task;
	ByteRing rx;
	ByteRing tx;
	uint32_t address;
	uint32_t timeout;
	uint16_t port;
	volatile uint8_t pending;
	volatile uint8_t error;
	volatile bool connected;
	volatile bool closing;
	volatile bool task_running;
	uint8_t number_format;
};

typedef struct {
	uint32_t address;
	uint16_t port;
	uint16_t length;
	uint8_t data[UDP_PACKET_SIZE];
} UDPPacket;

struct TailnetUDPRecord {
	TailnetManagerRecord *manager;
	microlink_udp_socket_t *socket;
	xsMachine *the;
	xsSlot obj;
	SemaphoreHandle_t mutex;
	SemaphoreHandle_t wake;
	TaskHandle_t task;
	UDPPacket rx[UDP_QUEUE_SIZE];
	UDPPacket tx[UDP_QUEUE_SIZE];
	uint8_t rx_read;
	uint8_t rx_write;
	uint8_t rx_count;
	uint8_t tx_read;
	uint8_t tx_write;
	uint8_t tx_count;
	uint16_t local_port;
	volatile uint8_t pending;
	volatile uint8_t error;
	volatile bool closing;
	volatile bool task_running;
	uint32_t dropped;
};

void xs_tailscale_manager_destructor(void *data);
void xs_tailscale_tcp_destructor(void *data);
void xs_tailscale_udp_destructor(void *data);

static const xsHostHooks gManagerHooks = { xs_tailscale_manager_destructor, NULL, NULL };
static const xsHostHooks gTCPHooks = { xs_tailscale_tcp_destructor, NULL, NULL };
static const xsHostHooks gUDPHooks = { xs_tailscale_udp_destructor, NULL, NULL };
static TailnetManagerRecord *gManager;

static void lock(SemaphoreHandle_t mutex) {
	xSemaphoreTake(mutex, portMAX_DELAY);
}

static void unlock(SemaphoreHandle_t mutex) {
	xSemaphoreGive(mutex);
}

static bool is_tailnet_ip(uint32_t address) {
	return (address & 0xffc00000U) == 0x64400000U;
}

static size_t ring_write(ByteRing *ring, const uint8_t *source, size_t count) {
	size_t first = ring->capacity - ring->write;
	if (first > count)
		first = count;
	memcpy(ring->data + ring->write, source, first);
	memcpy(ring->data, source + first, count - first);
	ring->write = (ring->write + count) % ring->capacity;
	ring->used += count;
	return count;
}

static size_t ring_read(ByteRing *ring, uint8_t *destination, size_t count) {
	size_t first = ring->capacity - ring->read;
	if (first > count)
		first = count;
	memcpy(destination, ring->data + ring->read, first);
	memcpy(destination + first, ring->data, count - first);
	ring->read = (ring->read + count) % ring->capacity;
	ring->used -= count;
	return count;
}

static void manager_free(TailnetManagerRecord *manager) {
	if (manager->commands)
		vQueueDelete(manager->commands);
	if (manager->mutex)
		vSemaphoreDelete(manager->mutex);
	free(manager);
}

static microlink_t *manager_microlink(TailnetManagerRecord *manager) {
	microlink_t *ml;
	lock(manager->mutex);
	ml = manager->ml;
	unlock(manager->mutex);
	return ml;
}

static void tcp_request_close(TailnetTCPRecord *tcp) {
	if (!tcp)
		return;
	lock(tcp->mutex);
	tcp->closing = true;
	unlock(tcp->mutex);
}

static void udp_request_close(TailnetUDPRecord *udp) {
	if (!udp)
		return;
	lock(udp->mutex);
	udp->closing = true;
	unlock(udp->mutex);
	xSemaphoreGive(udp->wake);
}

static void manager_close_transports(TailnetManagerRecord *manager) {
	lock(manager->mutex);
	tcp_request_close(manager->tcp);
	udp_request_close(manager->udp);
	unlock(manager->mutex);
	while (manager->tcp_active || manager->udp_active)
		vTaskDelay(pdMS_TO_TICKS(20));
}

static void manager_task(void *context) {
	TailnetManagerRecord *manager = context;
	uint8_t command;

	while (!manager->stop_requested) {
		if (xQueueReceive(manager->commands, &command, pdMS_TO_TICKS(100)) != pdTRUE)
			continue;
		if (manager->stop_requested)
			break;

		if (MANAGER_START == command) {
			microlink_config_t config = {
				.auth_key = manager->auth_key,
				.device_name = manager->device_name[0] ? manager->device_name : NULL,
				.enable_derp = true,
				.enable_stun = true,
				.enable_disco = true,
				.max_peers = 8,
				.priority_peer_ip = manager->priority_peer,
			};
			microlink_t *ml = microlink_init(&config);
			if (!ml) {
				manager->last_error = 1;
				continue;
			}
			lock(manager->mutex);
			manager->ml = ml;
			unlock(manager->mutex);
			if (microlink_start(ml) != ESP_OK)
				manager->last_error = 2;
		}
		else if (MANAGER_REBIND == command) {
			microlink_t *ml = manager_microlink(manager);
			if (!ml || (microlink_rebind(ml) != ESP_OK))
				manager->last_error = 3;
		}
	}

	manager_close_transports(manager);
	lock(manager->mutex);
	microlink_t *ml = manager->ml;
	manager->ml = NULL;
	unlock(manager->mutex);
	if (ml)
		microlink_destroy(ml);

	manager->task_running = false;
	manager->closed = true;
	if (gManager == manager)
		gManager = NULL;
	if (manager->abandoned)
		manager_free(manager);
	vTaskDelete(NULL);
}

void xs_tailscale_manager_constructor(xsMachine *the) {
	TailnetManagerRecord *manager;
	xsmcVars(1);

	if (gManager)
		xsUnknownError("Tailnet already exists");
	manager = calloc(1, sizeof(*manager));
	if (!manager)
		xsUnknownError("no memory");
	manager->commands = xQueueCreate(4, sizeof(uint8_t));
	manager->mutex = xSemaphoreCreateMutex();
	if (!manager->commands || !manager->mutex) {
		manager_free(manager);
		xsUnknownError("no memory");
	}

	xsmcGet(xsVar(0), xsArg(0), xsID_authKey);
	xsmcToStringBuffer(xsVar(0), manager->auth_key, sizeof(manager->auth_key));
	if (xsmcGet(xsVar(0), xsArg(0), xsID_deviceName))
		xsmcToStringBuffer(xsVar(0), manager->device_name, sizeof(manager->device_name));
	if (xsmcGet(xsVar(0), xsArg(0), xsID_priorityPeer)) {
		char address[16];
		xsmcToStringBuffer(xsVar(0), address, sizeof(address));
		manager->priority_peer = microlink_parse_ip(address);
		if (!is_tailnet_ip(manager->priority_peer)) {
			manager_free(manager);
			xsRangeError("invalid priority peer");
		}
	}

	xsmcSetHostData(xsThis, manager);
	xsSetHostHooks(xsThis, (xsHostHooks *)&gManagerHooks);
	manager->task_running = true;
	gManager = manager;
	if (xTaskCreatePinnedToCore(manager_task, "tailscale", 6144, manager, 4,
			&manager->task, 0) != pdPASS) {
		gManager = NULL;
		manager->task_running = false;
		xsmcSetHostData(xsThis, NULL);
		manager_free(manager);
		xsUnknownError("cannot create Tailnet task");
	}
}

void xs_tailscale_manager_destructor(void *data) {
	TailnetManagerRecord *manager = data;
	if (!manager)
		return;
	if (manager->task_running) {
		manager->abandoned = true;
		manager->stop_requested = true;
		xQueueSendToBack(manager->commands, &(uint8_t){0}, 0);
	}
	else
		manager_free(manager);
}

static TailnetManagerRecord *manager_validate(xsMachine *the, xsSlot slot) {
	TailnetManagerRecord *manager = xsmcGetHostDataValidate(slot, (void *)&gManagerHooks);
	if (!manager || manager->closed)
		xsUnknownError("Tailnet is closed");
	return manager;
}

void xs_tailscale_manager_start(xsMachine *the) {
	TailnetManagerRecord *manager = manager_validate(the, xsThis);
	uint8_t command = MANAGER_START;
	if (manager->start_requested)
		xsUnknownError("Tailnet already started");
	manager->start_requested = true;
	if (xQueueSend(manager->commands, &command, 0) != pdTRUE) {
		manager->start_requested = false;
		xsUnknownError("Tailnet command queue full");
	}
}

void xs_tailscale_manager_rebind(xsMachine *the) {
	TailnetManagerRecord *manager = manager_validate(the, xsThis);
	uint8_t command = MANAGER_REBIND;
	if (!manager_microlink(manager))
		xsUnknownError("Tailnet not started");
	manager->last_error = 0;
	if (xQueueSend(manager->commands, &command, 0) != pdTRUE)
		xsUnknownError("Tailnet command queue full");
}

void xs_tailscale_manager_close(xsMachine *the) {
	TailnetManagerRecord *manager = xsmcGetHostDataValidate(xsThis, (void *)&gManagerHooks);
	if (!manager || manager->closed)
		return;
	manager->stop_requested = true;
	xQueueSendToBack(manager->commands, &(uint8_t){0}, 0);
}

void xs_tailscale_manager_release(xsMachine *the) {
	TailnetManagerRecord *manager = xsmcGetHostDataValidate(xsThis, (void *)&gManagerHooks);
	if (!manager)
		return;
	if (!manager->closed || manager->task_running)
		xsUnknownError("Tailnet is still closing");
	xsmcSetHostData(xsThis, NULL);
	xsmcSetHostDestructor(xsThis, NULL);
	manager_free(manager);
}

void xs_tailscale_manager_get_state(xsMachine *the) {
	TailnetManagerRecord *manager = xsmcGetHostDataValidate(xsThis, (void *)&gManagerHooks);
	if (!manager || manager->closed) {
		xsmcSetInteger(xsResult, 7);
		return;
	}
	if (manager->last_error) {
		xsmcSetInteger(xsResult, ML_STATE_ERROR);
		return;
	}
	lock(manager->mutex);
	int state = manager->ml ? microlink_get_state(manager->ml) : ML_STATE_IDLE;
	unlock(manager->mutex);
	xsmcSetInteger(xsResult, state);
}

void xs_tailscale_manager_get_error(xsMachine *the) {
	TailnetManagerRecord *manager = xsmcGetHostDataValidate(xsThis, (void *)&gManagerHooks);
	xsmcSetInteger(xsResult, manager ? manager->last_error : 0);
}

void xs_tailscale_manager_get_closed(xsMachine *the) {
	TailnetManagerRecord *manager = xsmcGetHostDataValidate(xsThis, (void *)&gManagerHooks);
	xsmcSetBoolean(xsResult, !manager || manager->closed);
}

void xs_tailscale_manager_get_vpn_address(xsMachine *the) {
	TailnetManagerRecord *manager = manager_validate(the, xsThis);
	lock(manager->mutex);
	uint32_t address = manager->ml ? microlink_get_vpn_ip(manager->ml) : 0;
	unlock(manager->mutex);
	if (address) {
		char text[16];
		microlink_ip_to_str(address, text);
		xsmcSetString(xsResult, text);
	}
}

void xs_tailscale_manager_get_peer_count(xsMachine *the) {
	TailnetManagerRecord *manager = manager_validate(the, xsThis);
	lock(manager->mutex);
	int count = manager->ml ? microlink_get_peer_count(manager->ml) : 0;
	unlock(manager->mutex);
	xsmcSetInteger(xsResult, count);
}

void xs_tailscale_manager_get_peer(xsMachine *the) {
	TailnetManagerRecord *manager = manager_validate(the, xsThis);
	microlink_peer_info_t peer = {0};
	lock(manager->mutex);
	esp_err_t result = manager->ml
		? microlink_get_peer_info(manager->ml, xsmcToInteger(xsArg(0)), &peer)
		: ESP_ERR_INVALID_STATE;
	unlock(manager->mutex);
	if (result != ESP_OK)
		return;

	xsmcVars(1);
	xsmcSetNewObject(xsResult);
	char address[16];
	microlink_ip_to_str(peer.vpn_ip, address);
	xsmcSetString(xsVar(0), address);
	xsmcSet(xsResult, xsID_address, xsVar(0));
	xsmcSetString(xsVar(0), peer.hostname);
	xsmcSet(xsResult, xsID_hostname, xsVar(0));
	xsmcSetBoolean(xsVar(0), peer.online);
	xsmcSet(xsResult, xsID_online, xsVar(0));
	xsmcSetBoolean(xsVar(0), peer.direct_path);
	xsmcSet(xsResult, xsID_direct, xsVar(0));
}

void xs_tailscale_manager_resolve(xsMachine *the) {
	TailnetManagerRecord *manager = manager_validate(the, xsThis);
	lock(manager->mutex);
	uint32_t address = manager->ml ? microlink_resolve(manager->ml, xsmcToString(xsArg(0))) : 0;
	unlock(manager->mutex);
	if (address) {
		char text[16];
		microlink_ip_to_str(address, text);
		xsmcSetString(xsResult, text);
	}
}

void xs_tailscale_manager_factory_reset(xsMachine *the) {
	if (gManager)
		xsUnknownError("close Tailnet before factory reset");
	xsmcSetBoolean(xsResult, microlink_factory_reset() == ESP_OK);
}

static void tcp_deliver(void *the, void *context, uint8_t *message, uint16_t length) {
	TailnetTCPRecord *tcp = context;
	uint8_t events;
	size_t readable;
	size_t writable;
	lock(tcp->mutex);
	events = tcp->pending;
	tcp->pending = 0;
	readable = tcp->rx.used;
	writable = tcp->tx.capacity - tcp->tx.used;
	unlock(tcp->mutex);

	xsBeginHost(the);
	if ((events & EVENT_READABLE) && readable)
		xsCall2(tcp->obj, xsID_callback, xsInteger(EVENT_READABLE), xsInteger(readable));
	if ((events & EVENT_WRITABLE) && tcp->connected)
		xsCall2(tcp->obj, xsID_callback, xsInteger(EVENT_WRITABLE), xsInteger(writable));
	if (events & EVENT_ERROR)
		xsCall2(tcp->obj, xsID_callback, xsInteger(EVENT_ERROR), xsInteger(tcp->error));
	if (events & EVENT_FINAL) {
		xsmcSetHostData(tcp->obj, NULL);
		xsForget(tcp->obj);
	}
	xsEndHost(the);

	if (events & EVENT_FINAL) {
		vSemaphoreDelete(tcp->mutex);
		heap_caps_free(tcp->rx.data);
		heap_caps_free(tcp->tx.data);
		free(tcp);
	}
}

static void tcp_trigger(TailnetTCPRecord *tcp, uint8_t events) {
	bool post;
	lock(tcp->mutex);
	post = (0 == tcp->pending);
	tcp->pending |= events;
	unlock(tcp->mutex);
	if (post)
		modMessagePostToMachine(tcp->the, NULL, 0, tcp_deliver, tcp);
}

static void tcp_task(void *context) {
	TailnetTCPRecord *tcp = context;
	microlink_t *ml = manager_microlink(tcp->manager);
	uint8_t buffer[TCP_IO_CHUNK];

	if (ml)
		tcp->socket = microlink_tcp_connect(ml, tcp->address, tcp->port, tcp->timeout);
	if (!tcp->socket)
		tcp->error = 1;
	else {
		lock(tcp->mutex);
		tcp->connected = true;
		bool closing = tcp->closing;
		unlock(tcp->mutex);
		if (!closing)
			tcp_trigger(tcp, EVENT_WRITABLE);

		while (!closing) {
			size_t count = 0;
			lock(tcp->mutex);
			closing = tcp->closing;
			if (!closing && tcp->tx.used) {
				count = tcp->tx.used;
				if (count > sizeof(buffer))
					count = sizeof(buffer);
				ring_read(&tcp->tx, buffer, count);
			}
			unlock(tcp->mutex);
			if (closing)
				break;
			if (count) {
				if (microlink_tcp_send(tcp->socket, buffer, count) != ESP_OK) {
					tcp->error = 2;
					break;
				}
				tcp_trigger(tcp, EVENT_WRITABLE);
			}

			lock(tcp->mutex);
			size_t free_space = tcp->rx.capacity - tcp->rx.used;
			unlock(tcp->mutex);
			if (free_space) {
				if (free_space > sizeof(buffer))
					free_space = sizeof(buffer);
				int received = microlink_tcp_recv(tcp->socket, buffer, free_space, 20);
				if (received < 0) {
					tcp->error = 2;
					break;
				}
				if (received > 0) {
					lock(tcp->mutex);
					ring_write(&tcp->rx, buffer, received);
					unlock(tcp->mutex);
					tcp_trigger(tcp, EVENT_READABLE);
				}
			}
			else
				vTaskDelay(pdMS_TO_TICKS(10));
		}
	}

	if (tcp->socket) {
		microlink_tcp_close(tcp->socket);
		tcp->socket = NULL;
	}
	lock(tcp->mutex);
	bool explicit_close = tcp->closing;
	tcp->connected = false;
	unlock(tcp->mutex);
	TailnetManagerRecord *manager = tcp->manager;
	lock(manager->mutex);
	if (manager->tcp == tcp)
		manager->tcp = NULL;
	manager->tcp_active = false;
	unlock(manager->mutex);
	tcp->manager = NULL;
	tcp->task_running = false;
	tcp_trigger(tcp, EVENT_FINAL | ((!explicit_close && tcp->error) ? EVENT_ERROR : 0));
	vTaskDelete(NULL);
}

void xs_tailscale_tcp_constructor(xsMachine *the) {
	xsmcVars(1);
	xsmcGet(xsVar(0), xsArg(0), xsID_manager);
	TailnetManagerRecord *manager = manager_validate(the, xsVar(0));
	microlink_t *ml = manager_microlink(manager);
	if (!ml || !microlink_is_connected(ml))
		xsUnknownError("Tailnet is not connected");

	xsmcGet(xsVar(0), xsArg(0), xsID_address);
	uint32_t address = microlink_parse_ip(xsmcToString(xsVar(0)));
	if (!is_tailnet_ip(address))
		xsRangeError("address is outside 100.64.0.0/10");
	xsmcGet(xsVar(0), xsArg(0), xsID_port);
	int port = xsmcToInteger(xsVar(0));
	if ((port <= 0) || (port > 65535))
		xsRangeError("invalid port");
	uint32_t timeout = 30000;
	if (xsmcGet(xsVar(0), xsArg(0), xsID_connectTimeout)) {
		int value = xsmcToInteger(xsVar(0));
		if ((value <= 0) || (value > 120000))
			xsRangeError("invalid connect timeout");
		timeout = value;
	}

	TailnetTCPRecord *tcp = calloc(1, sizeof(*tcp));
	if (!tcp)
		xsUnknownError("no memory");
	tcp->mutex = xSemaphoreCreateMutex();
	tcp->rx.data = heap_caps_malloc(TCP_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
	tcp->tx.data = heap_caps_malloc(TCP_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
	if (!tcp->mutex || !tcp->rx.data || !tcp->tx.data) {
		if (tcp->mutex) vSemaphoreDelete(tcp->mutex);
		heap_caps_free(tcp->rx.data);
		heap_caps_free(tcp->tx.data);
		free(tcp);
		xsUnknownError("no PSRAM");
	}
	tcp->rx.capacity = TCP_BUFFER_SIZE;
	tcp->tx.capacity = TCP_BUFFER_SIZE;
	tcp->manager = manager;
	tcp->the = the;
	tcp->obj = xsThis;
	tcp->address = address;
	tcp->port = port;
	tcp->timeout = timeout;

	lock(manager->mutex);
	if (manager->tcp || manager->stop_requested) {
		unlock(manager->mutex);
		vSemaphoreDelete(tcp->mutex);
		heap_caps_free(tcp->rx.data);
		heap_caps_free(tcp->tx.data);
		free(tcp);
		xsUnknownError("only one TCP connection is supported");
	}
	manager->tcp = tcp;
	manager->tcp_active = true;
	unlock(manager->mutex);

	xsmcSetHostData(xsThis, tcp);
	xsSetHostHooks(xsThis, (xsHostHooks *)&gTCPHooks);
	xsRemember(tcp->obj);
	tcp->task_running = true;
	if (xTaskCreatePinnedToCore(tcp_task, "tailscale_tcp", 6144, tcp, 4,
			&tcp->task, 0) != pdPASS) {
		tcp->task_running = false;
		lock(manager->mutex);
		manager->tcp = NULL;
		manager->tcp_active = false;
		unlock(manager->mutex);
		xsForget(tcp->obj);
		xsmcSetHostData(xsThis, NULL);
		vSemaphoreDelete(tcp->mutex);
		heap_caps_free(tcp->rx.data);
		heap_caps_free(tcp->tx.data);
		free(tcp);
		xsUnknownError("cannot create TCP task");
	}
}

void xs_tailscale_tcp_destructor(void *data) {
	TailnetTCPRecord *tcp = data;
	if (tcp)
		tcp_request_close(tcp);
}

void xs_tailscale_tcp_close(xsMachine *the) {
	TailnetTCPRecord *tcp = xsmcGetHostData(xsThis);
	if (tcp && xsmcGetHostDataValidate(xsThis, (void *)&gTCPHooks))
		tcp_request_close(tcp);
}

void xs_tailscale_tcp_read(xsMachine *the) {
	TailnetTCPRecord *tcp = xsmcGetHostDataValidate(xsThis, (void *)&gTCPHooks);
	if (!tcp)
		return;
	lock(tcp->mutex);
	size_t available = tcp->rx.used;
	unlock(tcp->mutex);
	if (!available)
		return;

	if (tcp->number_format) {
		uint8_t byte;
		lock(tcp->mutex);
		ring_read(&tcp->rx, &byte, 1);
		unlock(tcp->mutex);
		xsmcSetInteger(xsResult, byte);
		return;
	}

	void *destination;
	xsUnsignedValue byte_length;
	size_t requested;
	bool supplied = (xsmcArgc && (xsReferenceType == xsmcTypeOf(xsArg(0))));
	if (supplied) {
		xsResult = xsArg(0);
		xsmcGetBufferWritable(xsResult, &destination, &byte_length);
		requested = byte_length;
	}
	else {
		requested = xsmcArgc ? xsmcToInteger(xsArg(0)) : available;
		if (!requested || (requested > available))
			xsUnknownError("invalid read size");
		destination = xsmcSetArrayBuffer(xsResult, NULL, requested);
	}
	if (!requested || (requested > available))
		xsUnknownError("invalid read buffer");
	lock(tcp->mutex);
	ring_read(&tcp->rx, destination, requested);
	unlock(tcp->mutex);
	if (supplied)
		xsmcSetInteger(xsResult, requested);
}

void xs_tailscale_tcp_write(xsMachine *the) {
	TailnetTCPRecord *tcp = xsmcGetHostDataValidate(xsThis, (void *)&gTCPHooks);
	if (!tcp || !tcp->connected)
		xsUnknownError("not connected");
	uint8_t byte;
	void *source;
	xsUnsignedValue length;
	if (tcp->number_format) {
		byte = xsmcToInteger(xsArg(0));
		source = &byte;
		length = 1;
	}
	else
		xsmcGetBufferReadable(xsArg(0), &source, &length);
	lock(tcp->mutex);
	if (length > (tcp->tx.capacity - tcp->tx.used)) {
		unlock(tcp->mutex);
		xsUnknownError("would block");
	}
	ring_write(&tcp->tx, source, length);
	size_t writable = tcp->tx.capacity - tcp->tx.used;
	unlock(tcp->mutex);
	xsmcSetInteger(xsResult, writable);
}

void xs_tailscale_tcp_get_format(xsMachine *the) {
	TailnetTCPRecord *tcp = xsmcGetHostDataValidate(xsThis, (void *)&gTCPHooks);
	xsmcSetString(xsResult, (tcp && tcp->number_format) ? "number" : "buffer");
}

void xs_tailscale_tcp_set_format(xsMachine *the) {
	TailnetTCPRecord *tcp = xsmcGetHostDataValidate(xsThis, (void *)&gTCPHooks);
	const char *format = xsmcToString(xsArg(0));
	if (!strcmp(format, "number"))
		tcp->number_format = true;
	else if (!strcmp(format, "buffer"))
		tcp->number_format = false;
	else
		xsRangeError("invalid format");
}

void xs_tailscale_tcp_get_remote_address(xsMachine *the) {
	TailnetTCPRecord *tcp = xsmcGetHostDataValidate(xsThis, (void *)&gTCPHooks);
	if (tcp) {
		char address[16];
		microlink_ip_to_str(tcp->address, address);
		xsmcSetString(xsResult, address);
	}
}

void xs_tailscale_tcp_get_remote_port(xsMachine *the) {
	TailnetTCPRecord *tcp = xsmcGetHostDataValidate(xsThis, (void *)&gTCPHooks);
	xsmcSetInteger(xsResult, tcp ? tcp->port : 0);
}

static void udp_deliver(void *the, void *context, uint8_t *message, uint16_t length) {
	TailnetUDPRecord *udp = context;
	uint8_t events;
	uint8_t count;
	lock(udp->mutex);
	events = udp->pending;
	udp->pending = 0;
	count = udp->rx_count;
	unlock(udp->mutex);

	xsBeginHost(the);
	if ((events & EVENT_READABLE) && count)
		xsCall2(udp->obj, xsID_callback, xsInteger(EVENT_READABLE), xsInteger(count));
	if (events & EVENT_ERROR)
		xsCall2(udp->obj, xsID_callback, xsInteger(EVENT_ERROR), xsInteger(udp->error));
	if (events & EVENT_FINAL) {
		xsmcSetHostData(udp->obj, NULL);
		xsForget(udp->obj);
	}
	xsEndHost(the);
	if (events & EVENT_FINAL) {
		vSemaphoreDelete(udp->mutex);
		vSemaphoreDelete(udp->wake);
		heap_caps_free(udp);
	}
}

static void udp_trigger(TailnetUDPRecord *udp, uint8_t events) {
	bool post;
	lock(udp->mutex);
	post = (0 == udp->pending);
	udp->pending |= events;
	unlock(udp->mutex);
	if (post)
		modMessagePostToMachine(udp->the, NULL, 0, udp_deliver, udp);
}

static void udp_receive(microlink_udp_socket_t *socket, uint32_t address, uint16_t port,
		const uint8_t *data, size_t length, void *context) {
	TailnetUDPRecord *udp = context;
	if (length > UDP_PACKET_SIZE)
		length = UDP_PACKET_SIZE;
	lock(udp->mutex);
	if (udp->closing) {
		unlock(udp->mutex);
		return;
	}
	if (udp->rx_count == UDP_QUEUE_SIZE) {
		udp->rx_read = (udp->rx_read + 1) % UDP_QUEUE_SIZE;
		udp->rx_count--;
		udp->dropped++;
	}
	UDPPacket *packet = &udp->rx[udp->rx_write];
	packet->address = address;
	packet->port = port;
	packet->length = length;
	memcpy(packet->data, data, length);
	udp->rx_write = (udp->rx_write + 1) % UDP_QUEUE_SIZE;
	udp->rx_count++;
	unlock(udp->mutex);
	udp_trigger(udp, EVENT_READABLE);
}

static void udp_task(void *context) {
	TailnetUDPRecord *udp = context;
	microlink_t *ml = manager_microlink(udp->manager);
	if (ml)
		udp->socket = microlink_udp_create(ml, udp->local_port);
	if (!udp->socket) {
		udp->error = 1;
		udp_trigger(udp, EVENT_ERROR);
	}
	else {
		udp->local_port = microlink_udp_get_local_port(udp->socket);
		microlink_udp_set_rx_callback(udp->socket, udp_receive, udp);
		while (true) {
			xSemaphoreTake(udp->wake, pdMS_TO_TICKS(100));
			lock(udp->mutex);
			bool closing = udp->closing;
			bool have_packet = udp->tx_count > 0;
			UDPPacket packet;
			if (have_packet) {
				packet = udp->tx[udp->tx_read];
				udp->tx_read = (udp->tx_read + 1) % UDP_QUEUE_SIZE;
				udp->tx_count--;
			}
			unlock(udp->mutex);
			if (closing)
				break;
			if (have_packet && microlink_udp_send(udp->socket, packet.address,
					packet.port, packet.data, packet.length) != ESP_OK) {
				udp->error = 2;
				udp_trigger(udp, EVENT_ERROR);
			}
		}
		microlink_udp_set_rx_callback(udp->socket, NULL, NULL);
		microlink_udp_close(udp->socket);
		udp->socket = NULL;
	}

	TailnetManagerRecord *manager = udp->manager;
	lock(manager->mutex);
	if (manager->udp == udp)
		manager->udp = NULL;
	manager->udp_active = false;
	unlock(manager->mutex);
	udp->manager = NULL;
	udp->task_running = false;
	udp_trigger(udp, EVENT_FINAL);
	vTaskDelete(NULL);
}

void xs_tailscale_udp_constructor(xsMachine *the) {
	xsmcVars(1);
	xsmcGet(xsVar(0), xsArg(0), xsID_manager);
	TailnetManagerRecord *manager = manager_validate(the, xsVar(0));
	microlink_t *ml = manager_microlink(manager);
	if (!ml || !microlink_is_connected(ml))
		xsUnknownError("Tailnet is not connected");

	uint16_t local_port = 0;
	if (xsmcGet(xsVar(0), xsArg(0), xsID_port)) {
		int port = xsmcToInteger(xsVar(0));
		if ((port < 0) || (port > 65535))
			xsRangeError("invalid port");
		local_port = port;
	}

	TailnetUDPRecord *udp = heap_caps_calloc(1, sizeof(*udp), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
	if (!udp)
		xsUnknownError("no PSRAM");
	udp->mutex = xSemaphoreCreateMutex();
	udp->wake = xSemaphoreCreateCounting(UDP_QUEUE_SIZE + 1, 0);
	if (!udp->mutex || !udp->wake) {
		if (udp->mutex) vSemaphoreDelete(udp->mutex);
		if (udp->wake) vSemaphoreDelete(udp->wake);
		heap_caps_free(udp);
		xsUnknownError("no memory");
	}
	udp->manager = manager;
	udp->the = the;
	udp->obj = xsThis;
	udp->local_port = local_port;

	lock(manager->mutex);
	if (manager->udp || manager->stop_requested) {
		unlock(manager->mutex);
		vSemaphoreDelete(udp->mutex);
		vSemaphoreDelete(udp->wake);
		heap_caps_free(udp);
		xsUnknownError("only one UDP socket is supported");
	}
	manager->udp = udp;
	manager->udp_active = true;
	unlock(manager->mutex);

	xsmcSetHostData(xsThis, udp);
	xsSetHostHooks(xsThis, (xsHostHooks *)&gUDPHooks);
	xsRemember(udp->obj);
	udp->task_running = true;
	if (xTaskCreatePinnedToCore(udp_task, "tailscale_udp", 4096, udp, 4,
			&udp->task, 1) != pdPASS) {
		udp->task_running = false;
		lock(manager->mutex);
		manager->udp = NULL;
		manager->udp_active = false;
		unlock(manager->mutex);
		xsForget(udp->obj);
		xsmcSetHostData(xsThis, NULL);
		vSemaphoreDelete(udp->mutex);
		vSemaphoreDelete(udp->wake);
		heap_caps_free(udp);
		xsUnknownError("cannot create UDP task");
	}
}

void xs_tailscale_udp_destructor(void *data) {
	TailnetUDPRecord *udp = data;
	if (udp)
		udp_request_close(udp);
}

void xs_tailscale_udp_close(xsMachine *the) {
	TailnetUDPRecord *udp = xsmcGetHostData(xsThis);
	if (udp && xsmcGetHostDataValidate(xsThis, (void *)&gUDPHooks))
		udp_request_close(udp);
}

void xs_tailscale_udp_read(xsMachine *the) {
	TailnetUDPRecord *udp = xsmcGetHostDataValidate(xsThis, (void *)&gUDPHooks);
	if (!udp)
		return;
	UDPPacket packet;
	lock(udp->mutex);
	if (!udp->rx_count) {
		unlock(udp->mutex);
		return;
	}
	packet = udp->rx[udp->rx_read];
	udp->rx_read = (udp->rx_read + 1) % UDP_QUEUE_SIZE;
	udp->rx_count--;
	unlock(udp->mutex);

	xsmcSetArrayBuffer(xsResult, packet.data, packet.length);
	xsmcVars(1);
	char address[16];
	microlink_ip_to_str(packet.address, address);
	xsmcSetString(xsVar(0), address);
	xsmcSet(xsResult, xsID_address, xsVar(0));
	xsmcSetInteger(xsVar(0), packet.port);
	xsmcSet(xsResult, xsID_port, xsVar(0));
}

void xs_tailscale_udp_write(xsMachine *the) {
	TailnetUDPRecord *udp = xsmcGetHostDataValidate(xsThis, (void *)&gUDPHooks);
	void *data;
	xsUnsignedValue length;
	xsmcGetBufferReadable(xsArg(0), &data, &length);
	if (!length || (length > UDP_PACKET_SIZE))
		xsRangeError("invalid datagram size");
	uint32_t address = microlink_parse_ip(xsmcToString(xsArg(1)));
	if (!is_tailnet_ip(address))
		xsRangeError("address is outside 100.64.0.0/10");
	int port = xsmcToInteger(xsArg(2));
	if ((port <= 0) || (port > 65535))
		xsRangeError("invalid port");

	lock(udp->mutex);
	if (udp->closing || (udp->tx_count == UDP_QUEUE_SIZE)) {
		unlock(udp->mutex);
		xsmcSetBoolean(xsResult, false);
		return;
	}
	UDPPacket *packet = &udp->tx[udp->tx_write];
	packet->address = address;
	packet->port = port;
	packet->length = length;
	memcpy(packet->data, data, length);
	udp->tx_write = (udp->tx_write + 1) % UDP_QUEUE_SIZE;
	udp->tx_count++;
	unlock(udp->mutex);
	xSemaphoreGive(udp->wake);
	xsmcSetBoolean(xsResult, true);
}

void xs_tailscale_udp_get_local_port(xsMachine *the) {
	TailnetUDPRecord *udp = xsmcGetHostDataValidate(xsThis, (void *)&gUDPHooks);
	xsmcSetInteger(xsResult, udp ? udp->local_port : 0);
}

void xs_tailscale_udp_get_dropped(xsMachine *the) {
	TailnetUDPRecord *udp = xsmcGetHostDataValidate(xsThis, (void *)&gUDPHooks);
	xsmcSetInteger(xsResult, udp ? udp->dropped : 0);
}

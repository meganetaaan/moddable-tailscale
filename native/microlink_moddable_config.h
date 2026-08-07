#pragma once

/* Moddable 9.0.0 puts lwIP's upstream headers before ESP-IDF 6's wrapper
 * headers. ESP-IDF 6 disables LWIP_COMPAT_SOCKETS, so bind(), socket(), and
 * friends otherwise compile as unresolved POSIX symbols. Keep the aliases
 * local to MicroLink translation units through this injected config header. */
#include "lwip/sockets.h"
#include "lwip/netdb.h"

#if !LWIP_COMPAT_SOCKETS
#define bind            lwip_bind
#define connect         lwip_connect
#define freeaddrinfo    lwip_freeaddrinfo
#define getaddrinfo     lwip_getaddrinfo
#define getsockname     lwip_getsockname
#define recv            lwip_recv
#define recvfrom        lwip_recvfrom
#define send            lwip_send
#define sendto          lwip_sendto
#define setsockopt      lwip_setsockopt
#define shutdown        lwip_shutdown
#define socket          lwip_socket
#endif

/* MicroLink normally receives these values from its ESP-IDF Kconfig menu.
 * Moddable owns sdkconfig, so keep the small-tailnet profile here instead. */
#ifndef CONFIG_ML_MAX_PEERS
#define CONFIG_ML_MAX_PEERS 8
#endif
#ifndef CONFIG_ML_NVS_MAX_PEERS
#define CONFIG_ML_NVS_MAX_PEERS 16
#endif
#ifndef CONFIG_ML_H2_BUFFER_SIZE_KB
#define CONFIG_ML_H2_BUFFER_SIZE_KB 64
#endif
#ifndef CONFIG_ML_JSON_BUFFER_SIZE_KB
#define CONFIG_ML_JSON_BUFFER_SIZE_KB 64
#endif
#ifndef CONFIG_ML_PRIORITY_PEER_IP
#define CONFIG_ML_PRIORITY_PEER_IP ""
#endif
#ifndef CONFIG_ML_DEVICE_NAME
#define CONFIG_ML_DEVICE_NAME ""
#endif

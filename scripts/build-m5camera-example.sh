#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly EXAMPLE_DIRECTORY="${PROJECT_ROOT}/examples/m5camera-websocket"
readonly APPLICATION_NAME="m5camera-websocket"

case "${1:-release}" in
	release)
		readonly BUILD_MODE="release"
		readonly MCCONFIG_FLAGS=(-m)
		;;
	debug)
		readonly BUILD_MODE="debug"
		readonly MCCONFIG_FLAGS=(-d -m)
		;;
	*)
		echo "usage: $0 [release|debug]" >&2
		exit 2
		;;
esac

if [[ -z "${MODDABLE:-}" ]]; then
	echo "error: MODDABLE is not set" >&2
	exit 1
fi
if [[ -z "${IDF_PATH:-}" ]]; then
	echo "error: IDF_PATH is not set" >&2
	exit 1
fi
if [[ ! -f "${PROJECT_ROOT}/examples/cores3-websocket/credentials.js" ]]; then
	echo "error: create examples/cores3-websocket/credentials.js first" >&2
	exit 1
fi

readonly IDF_PROJECT_DIRECTORY="${MODDABLE}/build/tmp/esp32/${BUILD_MODE}/${APPLICATION_NAME}/xsProj-esp32"
readonly MODDABLE_MAKEFILE="${MODDABLE}/build/tmp/esp32/${BUILD_MODE}/${APPLICATION_NAME}/makefile"
readonly SDKCONFIG_HEADER="${IDF_PROJECT_DIRECTORY}/build/config/sdkconfig.h"

(
	cd "${EXAMPLE_DIRECTORY}"
	mcconfig "${MCCONFIG_FLAGS[@]}" -p esp32 -t dependencies
)

if [[ ! -f "${IDF_PROJECT_DIRECTORY}/main/idf_component.yml" || ! -f "${MODDABLE_MAKEFILE}" ]]; then
	echo "error: generated IDF project was not found: ${IDF_PROJECT_DIRECTORY}" >&2
	exit 1
fi

(
	# shellcheck disable=SC1091
	source "${IDF_PATH}/export.sh" >/dev/null
	make -B -f "${MODDABLE_MAKEFILE}" "${SDKCONFIG_HEADER}"
)

(
	cd "${EXAMPLE_DIRECTORY}"
	mcconfig "${MCCONFIG_FLAGS[@]}" -p esp32 -t build
)

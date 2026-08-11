#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly EXAMPLE_DIRECTORY="${PROJECT_ROOT}/examples/cores3-websocket"
readonly APPLICATION_NAME="cores3-websocket"
readonly PLATFORM_NAME="m5stack_cores3"

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

readonly IDF_PROJECT_DIRECTORY="${MODDABLE}/build/tmp/esp32/${PLATFORM_NAME}/${BUILD_MODE}/${APPLICATION_NAME}/xsProj-esp32s3"
readonly MODDABLE_MAKEFILE="${MODDABLE}/build/tmp/esp32/${PLATFORM_NAME}/${BUILD_MODE}/${APPLICATION_NAME}/makefile"
readonly SDKCONFIG_HEADER="${IDF_PROJECT_DIRECTORY}/build/config/sdkconfig.h"

# Generate the IDF project and declare managed camera dependencies without
# compiling native sources before those dependencies have been downloaded.
(
	cd "${EXAMPLE_DIRECTORY}"
	mcconfig "${MCCONFIG_FLAGS[@]}" -p "esp32/${PLATFORM_NAME}" -t dependencies
)

if [[ ! -f "${IDF_PROJECT_DIRECTORY}/main/idf_component.yml" || ! -f "${MODDABLE_MAKEFILE}" ]]; then
	echo "error: generated IDF project was not found: ${IDF_PROJECT_DIRECTORY}" >&2
	exit 1
fi

(
	# Use Moddable's generated reconfigure target so IDF_TARGET, debug transport,
	# sdkconfig defaults, and native source paths match the final build. This also
	# downloads esp32-camera and esp_jpeg before camera.c is compiled.
	# shellcheck disable=SC1091
	source "${IDF_PATH}/export.sh" >/dev/null
	make -B -f "${MODDABLE_MAKEFILE}" "${SDKCONFIG_HEADER}"
)

(
	cd "${EXAMPLE_DIRECTORY}"
	mcconfig "${MCCONFIG_FLAGS[@]}" -p "esp32/${PLATFORM_NAME}" -t build
)

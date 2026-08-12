#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly MICROLINK_ROOT="${PROJECT_ROOT}/.deps/microlink"
readonly MICROLINK_COMMIT="216da3300f0493b0860247d43f7af5ce29df63a5"
readonly WIREGUARD_ROOT="${MICROLINK_ROOT}/components/microlink/components/wireguard_lwip/src"
readonly REFC_ROOT="${WIREGUARD_ROOT}/crypto/refc"
VERIFY_TMP="$(mktemp -d)"
readonly VERIFY_TMP
trap 'rm -rf -- "${VERIFY_TMP}"' EXIT

"${PROJECT_ROOT}/scripts/bootstrap.sh"
"${PROJECT_ROOT}/scripts/bootstrap.sh"

actual_commit="$(git -C "${MICROLINK_ROOT}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${MICROLINK_COMMIT}" ]]; then
	echo "error: unexpected MicroLink commit ${actual_commit}" >&2
	exit 1
fi
git -C "${MICROLINK_ROOT}" diff --check

readonly DERP_SOURCE="${MICROLINK_ROOT}/components/microlink/src/ml_derp.c"
readonly NOISE_SOURCE="${MICROLINK_ROOT}/components/microlink/src/ml_noise.c"
readonly WG_SOURCE="${WIREGUARD_ROOT}/wireguardif.c"

if rg -q "MBEDTLS_SSL_VERIFY_NONE" "${DERP_SOURCE}"; then
	echo "error: DERP certificate verification is disabled" >&2
	exit 1
fi
rg -q "MBEDTLS_SSL_VERIFY_REQUIRED" "${DERP_SOURCE}"
rg -q "esp_crt_bundle_attach" "${DERP_SOURCE}"
rg -q "mbedtls_ssl_set_hostname" "${DERP_SOURCE}"
rg -q "psa_crypto_init" "${DERP_SOURCE}"
rg -q "__builtin_bswap64" "${NOISE_SOURCE}"
rg -q "device->netif->input" "${WG_SOURCE}"

if rg -n --hidden --glob '!.git/**' --glob '!.deps/**' \
		--glob '!**/credentials.js' 'tskey-auth-[A-Za-z0-9_-]{20,}' "${PROJECT_ROOT}"; then
	echo "error: a probable Tailscale auth key is present in tracked sources" >&2
	exit 1
fi

"${CC:-cc}" -std=gnu11 -Wall -Wextra \
	-I"${WIREGUARD_ROOT}" -I"${REFC_ROOT}" \
	"${PROJECT_ROOT}/tests/noise_aead_test.c" \
	"${WIREGUARD_ROOT}/crypto.c" \
	"${REFC_ROOT}/chacha20.c" \
	"${REFC_ROOT}/chacha20poly1305.c" \
	"${REFC_ROOT}/poly1305-donna.c" \
	-o "${VERIFY_TMP}/noise_aead_test"
"${VERIFY_TMP}/noise_aead_test"

"${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
	-I"${MICROLINK_ROOT}/components/microlink/include" \
	"${PROJECT_ROOT}/tests/register_codec_test.c" \
	"${MICROLINK_ROOT}/components/microlink/src/ml_register_codec.c" \
	-o "${VERIFY_TMP}/register_codec_test"
"${VERIFY_TMP}/register_codec_test"

node -e 'for (const file of process.argv.slice(1)) JSON.parse(require("fs").readFileSync(file))' \
	"${PROJECT_ROOT}/manifest.json" \
	"${PROJECT_ROOT}/examples/cores3-websocket/manifest.json" \
	"${PROJECT_ROOT}/examples/m5camera-websocket/manifest.json"

echo "Repository verification: OK"

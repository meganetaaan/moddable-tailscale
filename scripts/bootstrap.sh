#!/usr/bin/env bash
set -euo pipefail

readonly MICROLINK_REPOSITORY="https://github.com/CamM2325/microlink.git"
readonly MICROLINK_COMMIT="216da3300f0493b0860247d43f7af5ce29df63a5"
readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEPENDENCY_ROOT="${PROJECT_ROOT}/.deps"
readonly MICROLINK_ROOT="${DEPENDENCY_ROOT}/microlink"

mkdir -p "${DEPENDENCY_ROOT}"

if [[ ! -d "${MICROLINK_ROOT}/.git" ]]; then
  if [[ -e "${MICROLINK_ROOT}" ]]; then
    echo "error: ${MICROLINK_ROOT} exists but is not a Git checkout" >&2
    exit 1
  fi
  git clone --no-checkout "${MICROLINK_REPOSITORY}" "${MICROLINK_ROOT}"
  git -C "${MICROLINK_ROOT}" checkout --detach "${MICROLINK_COMMIT}"
fi

actual_commit="$(git -C "${MICROLINK_ROOT}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${MICROLINK_COMMIT}" ]]; then
  echo "error: MicroLink is at ${actual_commit}; expected ${MICROLINK_COMMIT}" >&2
  echo "Remove or move ${MICROLINK_ROOT}, then run this script again." >&2
  exit 1
fi

for patch in "${PROJECT_ROOT}"/patches/*.patch; do
  [[ -e "${patch}" ]] || continue
  if git -C "${MICROLINK_ROOT}" apply --ignore-space-change --reverse --check "${patch}" 2>/dev/null; then
    echo "already applied: $(basename "${patch}")"
  elif git -C "${MICROLINK_ROOT}" apply --ignore-space-change --check "${patch}"; then
    git -C "${MICROLINK_ROOT}" apply --ignore-space-change "${patch}"
    echo "applied: $(basename "${patch}")"
  else
    echo "error: cannot apply $(basename "${patch}")" >&2
    exit 1
  fi
done

echo "MicroLink ${MICROLINK_COMMIT} is ready at ${MICROLINK_ROOT}"

#!/usr/bin/env bash
# Backward-compatibility shim.
# Delegates old decommission entrypoint to the renamed delete wrapper.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/delete-instance.sh" "$@"

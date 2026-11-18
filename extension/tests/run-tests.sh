#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$DIR/parseAlcbV2Text.test.js"
node "$DIR/noBareConsole.test.js"

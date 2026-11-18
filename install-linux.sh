#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID="${1:-}"
BROWSER="${2:-chrome}"

if [[ -z "$EXTENSION_ID" ]]; then
  echo "Usage: ./install-linux.sh <chrome-extension-id> [chrome|chromium]" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_JS="$ROOT_DIR/host/index.js"
HOST_NAME="com.anton.local_command"

if [[ ! -x "$HOST_JS" ]]; then
  chmod +x "$HOST_JS"
fi

case "$BROWSER" in
  chrome)
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  chromium)
    TARGET_DIR="$HOME/.config/chromium/NativeMessagingHosts"
    ;;
  *)
    echo "Unknown browser: $BROWSER. Use chrome or chromium." >&2
    exit 1
    ;;
esac

mkdir -p "$TARGET_DIR"
MANIFEST="$TARGET_DIR/$HOST_NAME.json"

sed \
  -e "s#__HOST_PATH__#$HOST_JS#g" \
  -e "s#__EXTENSION_ID__#$EXTENSION_ID#g" \
  "$ROOT_DIR/host/$HOST_NAME.json.template" > "$MANIFEST"

chmod 0644 "$MANIFEST"

echo "Installed Native Messaging manifest: $MANIFEST"
echo "Host path: $HOST_JS"
echo "Allowed extension: chrome-extension://$EXTENSION_ID/"

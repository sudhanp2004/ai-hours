#!/bin/bash
# End-to-end check of the real, unpacked extension in headless Chrome (not part of npm test:
# it needs google-chrome, openssl and python3). A local HTTPS server plays chatgpt.com.
# It checks: a reply is recorded with its model; after the extension reloads, an open tab
# shows ↻ and does not count; after the tab is refreshed, it counts again.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
EXT=$(cd "${1:-$HERE/../../extension}" && pwd)  # or a directory given as $1, e.g. an unzipped store package
TMP=$(mktemp -d); trap 'kill $CH $SRV 2>/dev/null; wait 2>/dev/null; sleep 1; rm -rf "$TMP" 2>/dev/null || true' EXIT
cd "$TMP"
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj "/CN=chatgpt.com" \
  -addext "subjectAltName=DNS:chatgpt.com" 2>/dev/null
python3 "$HERE/server.py" & SRV=$!
google-chrome --headless=new --no-sandbox --disable-gpu --user-data-dir="$TMP/profile" --remote-debugging-port=9333 \
  --enable-unsafe-extension-debugging --ignore-certificate-errors \
  --host-resolver-rules="MAP chatgpt.com 127.0.0.1:8443" about:blank >/dev/null 2>&1 & CH=$!
for i in $(seq 1 30); do curl -s http://127.0.0.1:9333/json/version >/dev/null && break; sleep 0.3; done
echo "extension: $EXT"
timeout 90 node "$HERE/run.mjs" "$EXT"

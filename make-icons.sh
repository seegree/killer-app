#!/bin/bash
# Renders logo.svg onto a felt-green square and saves the home-screen icons.
# Run after changing logo.svg:  ./make-icons.sh
# Needs Google Chrome (used headless to draw the PNGs).
set -euo pipefail
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Google Chrome not found at: $CHROME" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp logo.svg "$TMP/logo.svg"

render() { # size, output file
  local size=$1 out=$2
  # Logo at 72% so it sits inside Android's "maskable" safe zone; iOS rounds the corners itself.
  cat > "$TMP/icon.html" <<EOF
<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;
background:radial-gradient(ellipse 90% 80% at 50% 20%,#24774f,#17563b 55%,#0b2b1e)">
<img src="logo.svg" style="width:72%;height:72%"></body></html>
EOF
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="${size},${size}" --screenshot="$PWD/$out" "file://$TMP/icon.html" >/dev/null 2>&1
  echo "  $out (${size}×${size})"
}

echo "Making icons from logo.svg:"
render 180 apple-touch-icon.png
render 192 icon-192.png
render 512 icon-512.png

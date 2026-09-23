#!/bin/bash
# Renders icon-tile.svg full-bleed and saves the home-screen icons.
# Run after changing icon-tile.svg:  ./make-icons.sh
# Needs Google Chrome (used headless to draw the PNGs).
set -euo pipefail
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Google Chrome not found at: $CHROME" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp icon-tile.svg "$TMP/icon-tile.svg"

render() { # size, output file
  local size=$1 out=$2
  # Full-bleed: the tile's rounded corners are filled with the same ink colour, since
  # iOS and Android apply their own corner masks.
  cat > "$TMP/icon.html" <<EOF
<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:#07100c">
<img src="icon-tile.svg" style="display:block;width:100%;height:100%"></body></html>
EOF
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="${size},${size}" --screenshot="$PWD/$out" "file://$TMP/icon.html" >/dev/null 2>&1
  echo "  $out (${size}×${size})"
}

echo "Making icons from icon-tile.svg:"
render 180 apple-touch-icon.png
render 192 icon-192.png
render 512 icon-512.png

#!/bin/bash
# Sets a new release version everywhere it's used, so phones pick up the update.
# Run before each release:  ./bump-version.sh
set -euo pipefail
cd "$(dirname "$0")"
OLD=$(python3 -c "import json; print(json.load(open('version.json'))['version'])")
TODAY=$(date +%Y.%m.%d)
if [[ "$OLD" == "$TODAY".* ]]; then NEW="$TODAY.$(( ${OLD##*.} + 1 ))"; else NEW="$TODAY.1"; fi
python3 - "$OLD" "$NEW" <<'PY'
import sys
old, new = sys.argv[1], sys.argv[2]
for path, pairs in {
    'version.json': [(f'"{old}"', f'"{new}"')],
    'app.js': [(f"const APP_VERSION = '{old}';", f"const APP_VERSION = '{new}';")],
    'index.html': [(f'?v={old}"', f'?v={new}"')],
}.items():
    s = open(path).read()
    for a, b in pairs:
        if a not in s:
            sys.exit(f'{path}: could not find {a}')
        s = s.replace(a, b)
    open(path, 'w').write(s)
print(f'{old} -> {new}')
PY

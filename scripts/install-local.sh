#!/bin/sh
# Install pi-roost as a pi package from this checkout, without publishing to npm.
#
#   scripts/install-local.sh            # build, pack, install, register with pi
#   PI_ROOST_INSTALL_DIR=... scripts/install-local.sh
#
# The packed copy lives outside the checkout, so editing or rebuilding here does not
# change what pi loads until you run this again.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
dest=${PI_ROOST_INSTALL_DIR:-$HOME/.pi/agent/local-packages/pi-roost}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cd "$root"
echo "pi-roost: packing $(node -p 'require("./package.json").version')"
npm pack --silent --pack-destination "$tmp" >/dev/null # prepare runs the build
tarball=$(ls "$tmp"/*.tgz)

# A daemon started from the old copy would launch new jobs with the new files.
if [ -f "$dest/dist/bin/pi-roost.js" ]; then
	node "$dest/dist/bin/pi-roost.js" daemon stop >/dev/null 2>&1 || true
fi

mkdir -p "$tmp/unpacked"
tar -xzf "$tarball" -C "$tmp/unpacked"
rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
mv "$tmp/unpacked/package" "$dest"

# pi provides @earendil-works/* to extensions itself; only the runtime deps are needed.
(cd "$dest" && npm install --silent --omit=dev --omit=peer --no-audit --no-fund --ignore-scripts)
# (the tarball already has dist/; skipping scripts also skips the root prepare. node-pty ships prebuilds)
# npm drops spawn-helper's exec bit when scripts are skipped; node-pty cannot spawn without it
find "$dest/node_modules/node-pty" -name spawn-helper -exec chmod +x {} + 2>/dev/null || true

if pi list 2>/dev/null | grep -q "local-packages/pi-roost\|$dest"; then
	echo "pi-roost: already registered with pi"
else
	pi install "$dest"
fi
echo "pi-roost: installed at $dest"
echo "CLI: node $dest/dist/bin/pi-roost.js --help   (or: ln -s $dest/dist/bin/pi-roost.js ~/.local/bin/pi-roost)"

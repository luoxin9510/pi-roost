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

# Build the new copy beside the old one, so nothing ever runs from a half-installed
# directory (a daemon imports node-pty lazily).
stage="$dest.new"
rm -rf "$stage"
mkdir -p "$tmp/unpacked" "$(dirname "$dest")"
tar -xzf "$tarball" -C "$tmp/unpacked"
mv "$tmp/unpacked/package" "$stage"
# pi provides @earendil-works/* to extensions itself; only the runtime deps are needed.
# (the tarball already has dist/; skipping scripts also skips the root prepare. node-pty ships prebuilds)
(cd "$stage" && npm install --silent --omit=dev --omit=peer --no-audit --no-fund --ignore-scripts)
# npm drops spawn-helper's exec bit when scripts are skipped; node-pty cannot spawn without it
find "$stage/node_modules/node-pty" -name spawn-helper -exec chmod +x {} + 2>/dev/null || true

# A daemon started from the old copy would launch new jobs with the new files: stop it
# (the next pi starts the new one), keeping the background sessions running.
if [ -f "$dest/dist/bin/pi-roost.js" ]; then
	node "$dest/dist/bin/pi-roost.js" daemon stop --keep-workers >/dev/null 2>&1 || true
fi
rm -rf "$dest.old"
[ -d "$dest" ] && mv "$dest" "$dest.old"
mv "$stage" "$dest"
# hosts still running keep files open in the old copy; it goes at the next install
if pi list 2>/dev/null | grep -q "local-packages/pi-roost\|$dest"; then
	echo "pi-roost: already registered with pi"
else
	pi install "$dest"
fi
echo "pi-roost: installed at $dest"
echo "CLI: node $dest/dist/bin/pi-roost.js --help   (or: ln -s $dest/dist/bin/pi-roost.js ~/.local/bin/pi-roost)"

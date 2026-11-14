#!/bin/sh
# Look inside the Linux desktop packages a build made, and run what is in them.
#
#   scripts/check-linux-packages.sh <folder with the .deb, .rpm and .AppImage> [version]
#
# The folder is what scripts/stage-release-files.js writes. For the .deb and for the AppImage:
# the files the app starts with are there (the gateway and the calculation engine next to the
# program, the bundled chat plugin's manifest), and the gateway really runs from the unpacked
# package (scripts/smoke-gateway.mjs): linuxdeploy strips and patches what it bundles, and a
# program Bun compiled keeps its code appended to the file, which that can cut off. The .rpm is
# only checked to be there and to be an RPM. Needs node, and dpkg-deb for the .deb.
# Exits 0 when everything holds; every failure is printed as a GitHub error line.
set -eu

dir=${1:-}
[ -d "$dir" ] || { echo "usage: check-linux-packages.sh <folder> [version]" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
version=${2:-$(node -p "require('$here/../apps/desktop/src-tauri/tauri.conf.json').version")}
work=$(mktemp -d "${TMPDIR:-/tmp}/clerq-linux-packages.XXXXXX")
trap 'rm -rf "$work"' EXIT

fail() {
  echo "::error::$*"
  exit 1
}

# The one file in the folder matching a name, in $found, or a failure. (Not run in a command
# substitution, so that a failure ends the script and its message is printed.)
only() { # pattern what
  found=$(find "$dir" -maxdepth 1 -type f -name "$1" | sort)
  case $found in
    '') fail "there is no $2 in $dir" ;;
    *"
"*) fail "there is more than one $2 in $dir: $found" ;;
  esac
}

# Run the gateway from an unpacked package.
smoke() { # root-of-the-unpacked-package where
  gateway=$(find "$1" -name clerq-gateway -type f | head -n 1)
  calc=$(find "$1" -name clerq-calc -type f | head -n 1)
  [ -n "$gateway" ] || fail "clerq-gateway is not in $2"
  [ -n "$calc" ] || fail "clerq-calc is not in $2"
  manifest=$(find "$1" -path '*bundled-plugins/chat/manifest.json' | head -n 1)
  [ -n "$manifest" ] || fail "the bundled chat plugin's manifest is not in $2"
  echo "$2 has $gateway, $calc and $manifest"
  node "$here/smoke-gateway.mjs" "$gateway" --calc "$calc" --version "$version" ||
    fail "the gateway does not run from $2 (see above)"
}

only '*.deb' '.deb'
deb=$found
echo "== $deb"
command -v dpkg-deb >/dev/null 2>&1 || fail "dpkg-deb is needed to look inside the .deb"
dpkg-deb --field "$deb" Package Version Architecture Depends
mkdir "$work/deb"
dpkg-deb -x "$deb" "$work/deb"
smoke "$work/deb" "the .deb"

only '*.rpm' '.rpm'
rpm=$found
echo "== $rpm"
case $(file "$rpm") in
  *RPM*) echo "the .rpm is an RPM" ;;
  *) fail "$rpm is not an RPM" ;;
esac

only '*.AppImage' 'AppImage'
appimage=$found
echo "== $appimage"
mkdir "$work/appimage"
cp "$appimage" "$work/appimage/app.AppImage"
chmod +x "$work/appimage/app.AppImage"
# Extracting needs no FUSE: it unpacks the file's own squashfs.
(cd "$work/appimage" && ./app.AppImage --appimage-extract >/dev/null) || fail "the AppImage does not unpack"
smoke "$work/appimage/squashfs-root" "the AppImage"
echo "the Linux packages hold what the app starts with, and the gateway runs from them"

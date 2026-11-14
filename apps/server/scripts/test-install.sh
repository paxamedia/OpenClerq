#!/bin/sh
# Test apps/server/install.sh against a release folder served from this computer.
#
#   apps/server/scripts/test-install.sh <openclerq-server-<version>-<os>-<arch>.tar.gz> [install.sh]
#
# The tarball must be the one for the machine this runs on (scripts/package-server.js
# makes it), or see CLERQ_TEST_PRETEND_LINUX below. The script lays out what a release
# holds (the tarball, SHA256SUMS, install.sh), serves it over HTTP on 127.0.0.1, runs the
# installer against it with a temporary HOME and install folder, and checks that:
#   - it installs the three programs, verifies the checksum, asks no API, touches
#     nothing in HOME and starts nothing; it also works when read from a pipe;
#   - the installed clerq-server and clerq run, and work together: the server
#     starts from the install folder with the clerq-calc beside it, answers, the
#     clerq command talks to it, and SIGTERM stops it with exit 0;
#   - a tampered tarball, a missing checksum line, a version in SHA256SUMS that is
#     really a path, an unknown version, a download address with a user name and a
#     redirect are refused and leave an earlier install as it was; no curl is said so;
#   - with no sha256sum or shasum it refuses, and --no-verify installs with a warning;
#   - an unsupported system or a musl one gets a plain message;
#   - --systemd-user writes the unit and prints the commands without running them;
#   - shellcheck is clean on the three shell scripts (when it is installed; with
#     CLERQ_TEST_REQUIRE_SHELLCHECK=1 it must be).
# With CLERQ_TEST_SUDO=1 (CI: passwordless sudo) it also runs the root cases: refusal to
# run as root without --system, and --system into /usr/local/bin (which it removes again).
#
# CLERQ_TEST_PRETEND_LINUX=1, on a machine that is not Linux (a Mac), runs the Linux branches
# of all this, --systemd-user included: the darwin tarball is renamed as a linux one (the
# programs in it still run here) and a `uname` that says Linux (and passes everything else
# on to the real one) goes first on the PATH. It checks the installer's logic and this
# script's Linux branches as far as this machine's shell and tools behave as Linux's; run it
# under dash too (`dash test-install.sh ...`). It cannot show GNU tool behaviour.
# Exits 0 when every check passed, else 1.
# shellcheck disable=SC2012
# (ls is only used to list a folder this script made, whose file names are known.)
# The helper functions below, and cleanup, are reached through check() or trap, not by a
# direct call, which shellcheck 0.10 reports as SC2317 (0.11: SC2329); each carries a
# directive of its own for both codes. A version that lacks SC2329 ignores that code.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
tarball=${1:-}
installer=${2:-$here/../install.sh}
if [ -z "$tarball" ] || [ ! -f "$tarball" ] || [ ! -f "$installer" ]; then
  echo "usage: test-install.sh <openclerq-server-...tar.gz> [install.sh]" >&2
  exit 2
fi
tarball=$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")
installer=$(cd "$(dirname "$installer")" && pwd)/$(basename "$installer")
file=$(basename "$tarball")

# openclerq-server-<version>-<os>-<arch>.tar.gz
rest=${file#openclerq-server-}
rest=${rest%.tar.gz}
arch=${rest##*-}
rest=${rest%-*}
os=${rest##*-}
version=${rest%-*}
platform=$os-$arch

unset CLERQ_VERSION CLERQ_INSTALL_DIR CLERQ_DOWNLOAD_BASE CLERQ_GATEWAY_URL CLERQ_GATEWAY_TOKEN XDG_CONFIG_HOME
root=$(mktemp -d "${TMPDIR:-/tmp}/clerq-test-install.XXXXXX")
root=$(cd "$root" && pwd -P)
server_pid=""
http_pid=""
system_installed=0
# shellcheck disable=SC2317,SC2329 # called through trap
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; fi
  if [ -n "$http_pid" ]; then kill "$http_pid" 2>/dev/null || true; fi
  if [ "$system_installed" -eq 1 ]; then sudo -n rm -f /usr/local/bin/clerq-server /usr/local/bin/clerq /usr/local/bin/clerq-calc || true; fi
  rm -rf "$root"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

if [ "${CLERQ_TEST_PRETEND_LINUX:-}" = 1 ] && [ "$os" != linux ]; then
  top="openclerq-server-$version-linux-$arch"
  mkdir -p "$root/pretend/pack" "$root/pretend/bin"
  tar -xzf "$tarball" -C "$root/pretend/pack"
  mv "$root/pretend/pack/openclerq-server-$version-$platform" "$root/pretend/pack/$top"
  tarball="$root/pretend/$top.tar.gz"
  (cd "$root/pretend/pack" && COPYFILE_DISABLE=1 tar -czf "$tarball" "$top")
  file=$top.tar.gz
  os=linux
  platform=linux-$arch
  # shellcheck disable=SC2016 # the script written here is meant to expand its own $1 and $@
  printf '#!/bin/sh\nif [ "${1:-}" = -s ]; then echo Linux; else exec "%s" "$@"; fi\n' "$(command -v uname)" >"$root/pretend/bin/uname"
  chmod +x "$root/pretend/bin/uname"
  PATH="$root/pretend/bin:$PATH"
  export PATH
  echo "(CLERQ_TEST_PRETEND_LINUX: $file, and a uname that says Linux)"
fi

failed=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { # description [output file to show]
  printf 'FAIL %s\n' "$1"
  failed=1
  if [ -n "${2:-}" ] && [ -f "$2" ]; then head -n 25 "$2" | sed 's/^/       /'; fi
}
check() { # description, then a command that succeeds when the claim holds
  desc=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}
# shellcheck disable=SC2317,SC2329 # called through check
has() { grep -qF -- "$2" "$1"; } # file text
# shellcheck disable=SC2317,SC2329 # called through check
lacks() { ! grep -qF -- "$2" "$1"; }
# shellcheck disable=SC2317,SC2329 # called through check
empty_dir() { [ -z "$(ls -A "$1")" ]; }
# shellcheck disable=SC2317,SC2329 # called through check
same_file() { [ "$(cksum <"$1")" = "$2" ]; }
# shellcheck disable=SC2317,SC2329 # called through check
last_line_is() { [ "$(tail -n 1 "$1")" = "$2" ]; } # file text
# shellcheck disable=SC2317,SC2329 # called through check
says() { "$1" "$2" 2>&1 | grep -qF -- "$3"; } # program argument text it prints
# run <label> <command...>: output in $root/<label>.out, exit status in $status
run() {
  label=$1
  shift
  if "$@" >"$root/$label.out" 2>&1 </dev/null; then status=0; else status=$?; fi
}

# ---- the fake release, and a server for it
srv="$root/srv"
mkdir -p "$srv/good" "$srv/tampered" "$srv/nosums" "$srv/empty" "$srv/evil"
cp "$tarball" "$srv/good/$file"
cp "$installer" "$srv/good/install.sh"
sums() { # folder: write SHA256SUMS for the folder's tarball and installer
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$1" && sha256sum "$file" install.sh >SHA256SUMS)
  else
    (cd "$1" && shasum -a 256 "$file" install.sh >SHA256SUMS)
  fi
}
sums "$srv/good"
cp "$srv/good/SHA256SUMS" "$srv/tampered/SHA256SUMS"
cp "$tarball" "$srv/tampered/$file"
printf 'x' >>"$srv/tampered/$file"
cp "$tarball" "$srv/nosums/$file"
grep ' install.sh$' "$srv/good/SHA256SUMS" >"$srv/nosums/SHA256SUMS"
# A SHA256SUMS whose server file has a path where its version should be.
printf '%s  openclerq-server-../../x-%s.tar.gz\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$platform" >"$srv/evil/SHA256SUMS"

cat >"$root/serve.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const [dirArg, requests, portFile] = process.argv.slice(2);
const dir = path.resolve(dirArg);
const server = http.createServer((req, res) => {
  fs.appendFileSync(requests, `${req.method} ${req.url}\n`);
  if (req.url.startsWith('/redirect/')) {
    res.writeHead(302, { location: req.url.replace('/redirect/', '/good/') }).end();
    return;
  }
  const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
EOF
: >"$root/requests"
node "$root/serve.mjs" "$srv" "$root/requests" "$root/port" &
http_pid=$!
i=0
while [ ! -s "$root/port" ]; do
  i=$((i + 1))
  [ "$i" -le 100 ] || { echo "the local web server did not start" >&2; exit 1; }
  sleep 0.1
done
base="http://127.0.0.1:$(cat "$root/port")"

new_home() { mkdir -p "$root/$1" && echo "$root/$1"; }

echo "Testing $installer"
echo "  with $file ($platform), release folder served at $base"
echo

# ---- 1. the plain install: the latest release is found from SHA256SUMS
h=$(new_home home1)
: >"$root/requests"
run one env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin1" sh "$installer"
if [ "$status" -eq 0 ]; then ok "install with no version named exits 0"; else bad "install with no version named exits 0" "$root/one.out"; fi
for f in clerq-server clerq clerq-calc; do check "$f is installed and executable" test -x "$root/bin1/$f"; done
check "nothing else is in the install folder" test "$(ls -A "$root/bin1" | tr '\n' ' ')" = "clerq clerq-calc clerq-server "
check "clerq-server version runs and names $version" says "$root/bin1/clerq-server" version "$version"
check "clerq --version runs and names $version" says "$root/bin1/clerq" --version "$version"
check "it says the checksum was checked" has "$root/one.out" "Checksum ok"
check "it prints the next steps" has "$root/one.out" "Next steps"
check "it says the folder is not on the PATH and edits no rc file" has "$root/one.out" "not on your PATH"
check "HOME is untouched" empty_dir "$h"
check "it asked for SHA256SUMS and the tarball, and nothing else" test "$(tr '\n' ' ' <"$root/requests")" = "GET /good/SHA256SUMS GET /good/$file "

# ---- 2. a named version; installing over an install
: >"$root/requests"
run two env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin2" CLERQ_VERSION="v$version" sh "$installer"
if [ "$status" -eq 0 ]; then ok "CLERQ_VERSION=v$version installs"; else bad "CLERQ_VERSION=v$version installs" "$root/two.out"; fi
run two_again env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin2" CLERQ_VERSION="$version" sh "$installer"
if [ "$status" -eq 0 ]; then ok "installing over an install exits 0"; else bad "installing over an install exits 0" "$root/two_again.out"; fi
check "and says what it replaced and that a running server keeps its version" has "$root/two_again.out" "This replaced: clerq-server"
check "no half-written file is left behind" test "$(ls -A "$root/bin2" | tr '\n' ' ')" = "clerq clerq-calc clerq-server "
run unknown env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin2b" CLERQ_VERSION="0.0.1" sh "$installer"
if [ "$status" -ne 0 ]; then ok "a version that is not there is refused"; else bad "a version that is not there is refused" "$root/unknown.out"; fi
check "and says which file it could not get" has "$root/unknown.out" "openclerq-server-0.0.1-$platform.tar.gz"
check "and creates nothing" test ! -e "$root/bin2b"
run badver env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin2c" CLERQ_VERSION="1.0/../x" sh "$installer"
if [ "$status" -ne 0 ]; then ok "a CLERQ_VERSION that is not a version is refused"; else bad "a CLERQ_VERSION that is not a version is refused" "$root/badver.out"; fi
run badbase env HOME="$h" CLERQ_DOWNLOAD_BASE="http://example.com/x" CLERQ_INSTALL_DIR="$root/bin2d" sh "$installer"
if [ "$status" -ne 0 ] && has "$root/badbase.out" "must start with https://"; then ok "plain http to another computer is refused"; else bad "plain http to another computer is refused" "$root/badbase.out"; fi

# ---- 3. read from a pipe, as curl | sh does
# shellcheck disable=SC2002 # the script must arrive on stdin, which `sh < file` would also do but is not what curl | sh is
cat "$installer" | env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin3" sh >"$root/three.out" 2>&1 && status=0 || status=$?
if [ "$status" -eq 0 ] && [ -x "$root/bin3/clerq-server" ]; then ok "it installs when the script arrives on stdin"; else bad "it installs when the script arrives on stdin" "$root/three.out"; fi
# shellcheck disable=SC2002 # as above
cat "$installer" | sh -s -- --help >"$root/help.out" 2>&1 && status=0 || status=$?
if [ "$status" -eq 0 ] && has "$root/help.out" "--systemd-user"; then ok "sh -s -- --help prints the usage"; else bad "sh -s -- --help prints the usage" "$root/help.out"; fi
run opt env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin3b" sh "$installer" --frobnicate
if [ "$status" -ne 0 ] && has "$root/opt.out" "unknown option"; then ok "an unknown option is refused"; else bad "an unknown option is refused" "$root/opt.out"; fi

# ---- 4. a tampered download is refused, and an install already there is left alone
run before env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin4" sh "$installer"
sum_before=$(cksum <"$root/bin4/clerq-server")
run tampered env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/tampered" CLERQ_INSTALL_DIR="$root/bin4" sh "$installer"
if [ "$status" -ne 0 ]; then ok "a tarball that does not match SHA256SUMS is refused"; else bad "a tarball that does not match SHA256SUMS is refused" "$root/tampered.out"; fi
check "and says it does not match" has "$root/tampered.out" "does not match SHA256SUMS"
check "and the installed clerq-server is the same file as before" same_file "$root/bin4/clerq-server" "$sum_before"
check "and nothing was written beside it" test "$(ls -A "$root/bin4" | tr '\n' ' ')" = "clerq clerq-calc clerq-server "
run tampered_new env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/tampered" CLERQ_INSTALL_DIR="$root/bin4b" sh "$installer"
if [ "$status" -ne 0 ] && [ ! -e "$root/bin4b" ]; then ok "a refused install into a new folder creates nothing"; else bad "a refused install into a new folder creates nothing" "$root/tampered_new.out"; fi
run nosum_v env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/nosums" CLERQ_INSTALL_DIR="$root/bin4c" CLERQ_VERSION="$version" sh "$installer"
if [ "$status" -ne 0 ] && has "$root/nosum_v.out" "no line for $file"; then ok "SHA256SUMS without a line for the file is refused"; else bad "SHA256SUMS without a line for the file is refused" "$root/nosum_v.out"; fi
run nosum env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/nosums" CLERQ_INSTALL_DIR="$root/bin4d" sh "$installer"
if [ "$status" -ne 0 ] && has "$root/nosum.out" "no server file for $platform"; then ok "a release with no server file for this platform says so"; else bad "a release with no server file for this platform says so" "$root/nosum.out"; fi
run nosums_at_all env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/empty" CLERQ_INSTALL_DIR="$root/bin4e" sh "$installer"
if [ "$status" -ne 0 ] && has "$root/nosums_at_all.out" "may not be uploaded yet"; then ok "a release with no SHA256SUMS explains the likely reason"; else bad "a release with no SHA256SUMS explains the likely reason" "$root/nosums_at_all.out"; fi

: >"$root/requests"
run evilsums env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/evil" CLERQ_INSTALL_DIR="$root/bin4f" sh "$installer"
if [ "$status" -ne 0 ] && has "$root/evilsums.out" "not a version number"; then ok "a version in SHA256SUMS that is really a path is refused"; else bad "a version in SHA256SUMS that is really a path is refused" "$root/evilsums.out"; fi
check "and nothing was asked for with it" lacks "$root/requests" "tar.gz"
check "and nothing was created" test ! -e "$root/bin4f"
run userinfo env HOME="$h" CLERQ_DOWNLOAD_BASE="http://127.0.0.1:1@evil.example/good" CLERQ_INSTALL_DIR="$root/bin4g" sh "$installer"
if [ "$status" -ne 0 ] && has "$root/userinfo.out" "no user name"; then ok "a download address with a user name (127.0.0.1:1@evil.example) is refused before any request"; else bad "a download address with a user name (127.0.0.1:1@evil.example) is refused before any request" "$root/userinfo.out"; fi
for odd in "http://127.0.0.1.evil.example/good" "http://localhost:80x/good" "https://example.com/a b" "https://example.com/a?b=c"; do
  run odd env HOME="$h" CLERQ_DOWNLOAD_BASE="$odd" CLERQ_INSTALL_DIR="$root/bin4g" sh "$installer"
  if [ "$status" -ne 0 ] && [ ! -e "$root/bin4g" ]; then ok "a download address of '$odd' is refused"; else bad "a download address of '$odd' is refused" "$root/odd.out"; fi
done
: >"$root/requests"
run redirect env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/redirect" CLERQ_INSTALL_DIR="$root/bin4h" sh "$installer"
if [ "$status" -ne 0 ] && [ ! -e "$root/bin4h" ]; then ok "a local http address that redirects is not followed"; else bad "a local http address that redirects is not followed" "$root/redirect.out"; fi
check "and only the first request was made" test "$(tr '\n' ' ' <"$root/requests")" = "GET /redirect/SHA256SUMS "

# ---- 5. no sha256sum or shasum: refuse, unless told otherwise
minpath="$root/minpath"
mkdir -p "$minpath"
for t in uname id mktemp tar gzip awk sed cmp tr head cp mv chmod rm mkdir curl cat ldd sysctl sleep env cksum; do
  if p=$(command -v "$t" 2>/dev/null) && [ -x "$p" ]; then ln -s "$p" "$minpath/$t"; fi
done
run nohash env PATH="$minpath" HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin5" /bin/sh "$installer"
if [ "$status" -ne 0 ] && has "$root/nohash.out" "neither sha256sum nor shasum" && [ ! -e "$root/bin5/clerq-server" ]; then ok "with no checksum tool it refuses and installs nothing"; else bad "with no checksum tool it refuses and installs nothing" "$root/nohash.out"; fi
run noverify env PATH="$minpath" HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin5" /bin/sh "$installer" --no-verify
if [ "$status" -eq 0 ] && [ -x "$root/bin5/clerq-server" ]; then ok "--no-verify installs without one"; else bad "--no-verify installs without one" "$root/noverify.out"; fi
check "and warns that nothing was checked" has "$root/noverify.out" "NOT checking the download"

nocurl="$root/nocurl"
mkdir -p "$nocurl"
for t in "$minpath"/*; do
  [ "$(basename "$t")" = curl ] || ln -s "$(readlink "$t")" "$nocurl/$(basename "$t")"
done
run nocurl env PATH="$nocurl" HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin5b" /bin/sh "$installer"
if [ "$status" -ne 0 ] && has "$root/nocurl.out" "curl is not installed" && [ ! -e "$root/bin5b" ]; then ok "with no curl it says so (wget is not a fallback: it cannot refuse an http redirect)"; else bad "with no curl it says so" "$root/nocurl.out"; fi

# ---- 6. systems it does not support
fake="$root/fakebin"
mkdir -p "$fake"
cat >"$fake/uname" <<'EOF'
#!/bin/sh
case "$1" in
  -s) echo "${FAKE_UNAME_S:-Linux}" ;;
  -m) echo "${FAKE_UNAME_M:-x86_64}" ;;
  *) echo "${FAKE_UNAME_S:-Linux}" ;;
esac
EOF
cat >"$fake/ldd" <<'EOF'
#!/bin/sh
echo "musl libc (x86_64)"
echo "Version 1.2.4"
EOF
chmod +x "$fake/uname" "$fake/ldd"
run bsd env PATH="$fake:$PATH" FAKE_UNAME_S=FreeBSD HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin6" sh "$installer"
if [ "$status" -ne 0 ] && has "$root/bsd.out" "not FreeBSD"; then ok "another operating system gets a plain message"; else bad "another operating system gets a plain message" "$root/bsd.out"; fi
run riscv env PATH="$fake:$PATH" FAKE_UNAME_M=riscv64 HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin6" sh "$installer"
if [ "$status" -ne 0 ] && has "$root/riscv.out" "riscv64"; then ok "another processor gets a plain message"; else bad "another processor gets a plain message" "$root/riscv.out"; fi
run musl env PATH="$fake:$PATH" HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin6" sh "$installer"
if [ "$status" -ne 0 ] && has "$root/musl.out" "musl"; then ok "a musl system is pointed to the container image"; else bad "a musl system is pointed to the container image" "$root/musl.out"; fi
check "none of them created anything" test ! -e "$root/bin6"

# ---- 7. --systemd-user writes the unit and prints the commands, and runs nothing
calls="$root/systemctl-calls"
for t in systemctl loginctl journalctl; do
  printf '#!/bin/sh\necho "%s $*" >>"%s"\n' "$t" "$calls" >"$fake/$t"
  chmod +x "$fake/$t"
done
h7=$(new_home home7)
if [ "$os" = linux ]; then
  # The fake ldd of case 6 says musl; this is a glibc system, so the real one is used here.
  rm -f "$fake/ldd"
  run unit env PATH="$fake:$PATH" FAKE_UNAME_S=Linux FAKE_UNAME_M="$(uname -m)" HOME="$h7" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$h7/.local/bin" sh "$installer" --systemd-user
  unit_file="$h7/.config/systemd/user/openclerq.service"
  if [ "$status" -eq 0 ] && [ -f "$unit_file" ]; then ok "--systemd-user installs the unit"; else bad "--systemd-user installs the unit" "$root/unit.out"; fi
  check "ExecStart points at the install folder through %h" has "$unit_file" "ExecStart=%h/.local/bin/clerq-server"
  check "it prints the systemctl commands" has "$root/unit.out" "systemctl --user enable --now openclerq"
  check "and ran none of systemctl, loginctl, journalctl" test ! -e "$calls"
  printf '# edited by hand\n' >>"$unit_file"
  run unit2 env PATH="$fake:$PATH" FAKE_UNAME_S=Linux FAKE_UNAME_M="$(uname -m)" HOME="$h7" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$h7/.local/bin" sh "$installer" --systemd-user
  check "a unit that was edited is left alone" last_line_is "$unit_file" "# edited by hand"
  check "and the new one is written beside it" test -f "$unit_file.new"
  check "and the installer says which is which" has "$root/unit2.out" "left as it is"
  run unit3 env PATH="$fake:$PATH" FAKE_UNAME_S=Linux FAKE_UNAME_M="$(uname -m)" HOME="$h7" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/elsewhere/bin" XDG_CONFIG_HOME="$h7/xdg" sh "$installer" --systemd-user
  check "a folder outside HOME is written as an absolute path, under XDG_CONFIG_HOME" has "$h7/xdg/systemd/user/openclerq.service" "ExecStart=$root/elsewhere/bin/clerq-server"
else
  run unit env HOME="$h7" CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/bin7" sh "$installer" --systemd-user
  if [ "$status" -ne 0 ] && has "$root/unit.out" "--systemd-user is for Linux"; then ok "--systemd-user on a Mac is refused with a reason"; else bad "--systemd-user on a Mac is refused with a reason" "$root/unit.out"; fi
  check "and creates nothing" test ! -e "$root/bin7"
fi

# ---- 8. the installed programs work together
port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
srvhome=$(new_home srvhome)
(
  cd "$root"
  exec env -i PATH="$PATH" HOME="$srvhome" CLERQ_PORT="$port" CLERQ_KEYCHAIN=off "$root/bin1/clerq-server" >"$root/server.log" 2>&1
) &
server_pid=$!
up=0
i=0
while [ "$i" -lt 300 ]; do
  if curl -fs "http://127.0.0.1:$port/v1/health" >/dev/null 2>&1; then up=1; break; fi
  kill -0 "$server_pid" 2>/dev/null || break
  i=$((i + 1))
  sleep 0.1
done
if [ "$up" -eq 1 ]; then ok "the installed clerq-server starts and answers /v1/health"; else bad "the installed clerq-server starts and answers /v1/health" "$root/server.log"; fi
check "it found the clerq-calc beside it" has "$root/server.log" "$root/bin1/clerq-calc"
check "and did not warn that the engine is missing" lacks "$root/server.log" "not found"
if [ "$up" -eq 1 ]; then
  token=$(cat "$srvhome/.clerq/gateway-token")
  chome=$(new_home clihome)
  run cli env -i PATH="$PATH" HOME="$chome" CLERQ_GATEWAY_TOKEN="$token" "$root/bin1/clerq" status --gateway "http://127.0.0.1:$port"
  if [ "$status" -eq 0 ]; then ok "the installed clerq reaches it and the token is accepted (clerq status)"; else bad "the installed clerq reaches it and the token is accepted (clerq status)" "$root/cli.out"; fi
  check "clerq did not print the token" lacks "$root/cli.out" "$token"
  kill -TERM "$server_pid"
  i=0
  while kill -0 "$server_pid" 2>/dev/null && [ "$i" -lt 150 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  if wait "$server_pid"; then stop=0; else stop=$?; fi
  server_pid=""
  if [ "$stop" -eq 0 ]; then ok "SIGTERM stops it with exit 0"; else bad "SIGTERM stops it with exit 0 (exit $stop)" "$root/server.log"; fi
fi

# ---- 9. root: only where CI says it may use sudo
if [ "${CLERQ_TEST_SUDO:-}" = 1 ]; then
  run asroot sudo -n env CLERQ_DOWNLOAD_BASE="$base/good" CLERQ_INSTALL_DIR="$root/rootbin" sh "$installer"
  if [ "$status" -ne 0 ] && has "$root/asroot.out" "do not run this as root"; then ok "run as root without --system it refuses"; else bad "run as root without --system it refuses" "$root/asroot.out"; fi
  check "and creates nothing" test ! -e "$root/rootbin"
  system_installed=1
  run system env HOME="$h" CLERQ_DOWNLOAD_BASE="$base/good" sh "$installer" --system
  if [ "$status" -eq 0 ] && [ -x /usr/local/bin/clerq-server ]; then ok "--system installs into /usr/local/bin with sudo for the copy"; else bad "--system installs into /usr/local/bin with sudo for the copy" "$root/system.out"; fi
  check "the files belong to root" test "$(ls -l /usr/local/bin/clerq-server | awk '{print $3}')" = root
  check "and run" says /usr/local/bin/clerq-server version "$version"
  check "HOME is still untouched" empty_dir "$h"
else
  echo "skip the root cases (set CLERQ_TEST_SUDO=1 where sudo needs no password)"
fi

# ---- 10. shellcheck
if command -v shellcheck >/dev/null 2>&1; then
  scripts="$installer $here/test-install.sh"
  [ -f "$here/test-image.sh" ] && scripts="$scripts $here/test-image.sh"
  # shellcheck disable=SC2086 # the paths have no spaces; splitting is the point
  if shellcheck -s sh $scripts >"$root/shellcheck.out" 2>&1; then ok "shellcheck is clean on the shell scripts"; else bad "shellcheck is clean on the shell scripts" "$root/shellcheck.out"; fi
elif [ "${CLERQ_TEST_REQUIRE_SHELLCHECK:-}" = 1 ]; then
  bad "shellcheck is installed (CLERQ_TEST_REQUIRE_SHELLCHECK=1 requires it)"
else
  echo "skip shellcheck (not installed)"
fi

echo
if [ "$failed" -eq 0 ]; then echo "install test passed"; else echo "install test FAILED"; fi
exit "$failed"

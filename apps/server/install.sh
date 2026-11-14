#!/bin/sh
# OpenClerq server installer: puts clerq-server, clerq and clerq-calc in one folder.
#
#   curl -fsSL https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh | sh
#
# To pass options through a pipe:  ... | sh -s -- --system
# Read it first if you like: it is one file, uploaded with every release.
#
# What it does: finds out which Linux or macOS machine this is, downloads the
# release's tarball and SHA256SUMS from GitHub, checks the tarball against the
# checksum (and refuses on a mismatch), unpacks it in a temporary folder and
# copies the three programs into the install folder. What it never does: run as
# root unless you pass --system, edit your shell's startup files, create a user
# or an account, or start a service.
#
# docs/SERVER.md has the same steps by hand, and how to check a download yourself.

set -eu

REPO_URL="https://github.com/paxamedia/OpenClerq"

usage() {
  cat <<'EOF'
OpenClerq server installer

Usage: install.sh [--system] [--systemd-user] [--no-verify] [--help]

  --system         Install to /usr/local/bin (needs root: uses sudo for the copy, only
                   when it is not already root). Without it, nothing needs root and
                   it refuses to run as root.
  --systemd-user   Linux: also put the example user unit in ~/.config/systemd/user/
                   and print the systemctl commands to start it. It starts nothing.
  --no-verify      Do not check the download against SHA256SUMS. Only for a machine
                   with no sha256sum or shasum, and only if you trust the connection.
  --help           This text.

Environment

  CLERQ_VERSION        Release to install, such as 1.0.0. Default: the latest release.
  CLERQ_INSTALL_DIR    Where the programs go. Default: ~/.local/bin (/usr/local/bin
                       with --system).
  CLERQ_DOWNLOAD_BASE  Fetch SHA256SUMS and the tarball from this address instead of
                       GitHub (a mirror, or a test). Must be https, or http on this
                       computer; no user name, query or redirect to elsewhere.

It needs curl, tar and sha256sum or shasum.

It installs clerq-server, clerq and clerq-calc, and runs `clerq-server version`
and `clerq --version` at the end to show they start.
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# Run a command as root when --system was asked for and this is not root already.
priv() {
  if [ -n "$sudo" ]; then sudo "$@"; else "$@"; fi
}

# curl is the only downloader: wget cannot be told to refuse a redirect to plain http
# (GNU wget's --https-only works only when it recurses, busybox wget has no such option).
fetch() { # url destination
  case $1 in
    https://*)
      curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 3 --connect-timeout 30 -o "$2" "$1"
      ;;
    *)
      # Only reached for a CLERQ_DOWNLOAD_BASE on this computer (checked in main): plain http,
      # and no redirect at all, so it cannot be sent anywhere else.
      curl --proto '=http' --max-redirs 0 -fsSL --connect-timeout 30 -o "$2" "$1"
      ;;
  esac
}

# Is this an http address on this computer (127.0.0.1, localhost or [::1], and a port that is
# only digits, if any)? Plain http is allowed nowhere else.
local_http() {
  rest=${1#http://}
  [ "$rest" != "$1" ] || return 1
  auth=${rest%%/*}
  case $auth in
    127.0.0.1 | localhost | '[::1]') return 0 ;;
    127.0.0.1:* | localhost:*) port=${auth#*:} ;;
    '[::1]':*) port=${auth#'[::1]:'} ;;
    *) return 1 ;;
  esac
  case $port in
    '' | *[!0-9]*) return 1 ;;
  esac
  return 0
}

# A version as the release names it: 1.0.0, 1.0.0-rc.1. Nothing that could be a path.
valid_version() {
  case $1 in
    [0-9]*) ;;
    *) return 1 ;;
  esac
  case $1 in
    *[!0-9A-Za-z.+-]*) return 1 ;;
  esac
  return 0
}

sha256_of() { # file: its SHA-256 in lower-case hex, or non-zero when there is no tool
  if have sha256sum; then
    sha256sum "$1" | awk '{ print tolower($1) }'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{ print tolower($1) }'
  else
    return 1
  fi
}

detect_platform() {
  os=$(uname -s)
  cpu=$(uname -m)
  case $os in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "this installer is for Linux and macOS, not $os. On Windows, use the desktop installer from $REPO_URL/releases." ;;
  esac
  case $cpu in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "there is no OpenClerq server for the $cpu processor (x86_64 and arm64 only)." ;;
  esac
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    arch=arm64 # a terminal running under Rosetta on an Apple Silicon Mac
  fi
  if [ "$os" = linux ]; then
    musl=0
    for f in /lib/ld-musl-*; do
      if [ -e "$f" ]; then musl=1; fi
    done
    case $(ldd --version 2>&1 || true) in *musl*) musl=1 ;; esac
    if [ "$musl" -eq 1 ]; then
      die "this looks like a musl system (Alpine). The server needs glibc; use the container image instead: docker run ghcr.io/paxamedia/openclerq:1 (see $REPO_URL/blob/main/docs/SERVER.md)."
    fi
  fi
  platform=$os-$arch
}

# Copy one file into a folder under its final name without ever writing into a file
# that may be running (and, on a Mac, without changing a signed file in place).
put() { # source folder name
  tmp="$2/.$3.new.$$"
  if priv cp "$1" "$tmp" && priv chmod 0755 "$tmp" && priv mv -f "$tmp" "$2/$3"; then
    return 0
  fi
  priv rm -f "$tmp" >/dev/null 2>&1 || true
  return 1
}

install_user_unit() {
  src="$top/systemd/openclerq-user.service"
  [ -f "$src" ] || die "the archive has no systemd/openclerq-user.service."
  case $dir in
    *[!A-Za-z0-9_./+@:-]*) die "--systemd-user needs an install folder whose name has only letters, digits and . _ / + @ : - (it is written into the unit)." ;;
  esac
  case $dir in
    "$HOME") exec_start='%h/clerq-server' ;;
    "$HOME"/*) exec_start="%h${dir#"$HOME"}/clerq-server" ;;
    *) exec_start="$dir/clerq-server" ;;
  esac
  unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  mkdir -p "$unit_dir" || die "could not create $unit_dir."
  sed "s|^ExecStart=.*|ExecStart=$exec_start|" "$src" >"$work/openclerq.service"
  unit="$unit_dir/openclerq.service"
  if [ -e "$unit" ] && ! cmp -s "$work/openclerq.service" "$unit"; then
    # Somebody has edited it, or an older release wrote it: leave it alone.
    cp "$work/openclerq.service" "$unit.new"
    unit_note="$unit already exists and differs, so it was left as it is. The new one is $unit.new; compare them."
  else
    cp "$work/openclerq.service" "$unit"
    unit_note="Installed the user unit: $unit"
  fi
}

main() {
  system=0
  systemd_user=0
  verify=1
  while [ $# -gt 0 ]; do
    case $1 in
      --system) system=1 ;;
      --systemd-user) systemd_user=1 ;;
      --no-verify) verify=0 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown option: $1 (try --help)." ;;
    esac
    shift
  done

  sudo=""
  if [ "$(id -u)" -eq 0 ]; then
    [ "$system" -eq 1 ] || die "do not run this as root: it installs for one user, in ~/.local/bin. For a system-wide install, run it as yourself with --system (it asks for sudo only for the copy)."
  elif [ "$system" -eq 1 ]; then
    have sudo || die "--system needs root, and sudo is not installed. Run this as root, or leave out --system."
    sudo="sudo"
  fi

  have curl || die "curl is not installed, and it is how this installer downloads (over TLS, refusing any step down to http). Install it with your package manager (for example: apt install curl, dnf install curl) and run this again."

  detect_platform
  if [ "$systemd_user" -eq 1 ] && [ "$os" != linux ]; then
    die "--systemd-user is for Linux; macOS has no systemd. Run clerq-server in a terminal, or use the desktop app."
  fi

  dir=${CLERQ_INSTALL_DIR:-}
  if [ -z "$dir" ]; then
    if [ "$system" -eq 1 ]; then
      dir=/usr/local/bin
    else
      [ -n "${HOME:-}" ] || die "HOME is not set; set CLERQ_INSTALL_DIR to say where to install."
      dir=$HOME/.local/bin
    fi
  fi
  case $dir in /*) ;; *) dir=$PWD/$dir ;; esac
  while [ "${#dir}" -gt 1 ] && [ "${dir%/}" != "$dir" ]; do dir=${dir%/}; done
  if [ "$systemd_user" -eq 1 ] && [ -z "${HOME:-}" ]; then die "HOME is not set."; fi

  version=${CLERQ_VERSION:-}
  version=${version#v}
  if [ -n "$version" ] && ! valid_version "$version"; then
    die "CLERQ_VERSION must look like 1.0.0."
  fi
  if [ -n "${CLERQ_DOWNLOAD_BASE:-}" ]; then
    base=${CLERQ_DOWNLOAD_BASE%/}
  elif [ -n "$version" ]; then
    base="$REPO_URL/releases/download/v$version"
  else
    base="$REPO_URL/releases/latest/download"
  fi
  # No user name or password (http://127.0.0.1:1@evil.example is a request to evil.example),
  # no query or fragment, nothing that is not plain.
  case $base in
    *[[:space:]]* | *@* | *\\* | *\?* | *\#*) die "the download address must have no user name, spaces, query or fragment: $base" ;;
  esac
  case $base in
    https://*) ;;
    *) local_http "$base" || die "the download address must start with https:// (or be an http address on this computer): $base" ;;
  esac

  work=$(mktemp -d "${TMPDIR:-/tmp}/openclerq-install.XXXXXX") || die "could not make a temporary folder."
  trap 'rm -rf "$work"' EXIT
  trap 'exit 1' INT TERM HUP

  # Which tarball: named for the version, so without CLERQ_VERSION the version comes
  # from SHA256SUMS of the latest release (no API call, and the same file we verify with).
  sums="$work/SHA256SUMS"
  if [ -z "$version" ] || [ "$verify" -eq 1 ]; then
    say "Downloading $base/SHA256SUMS"
    fetch "$base/SHA256SUMS" "$sums" || die "could not download SHA256SUMS from $base. If this is the newest release, its server files may not be uploaded yet (they follow the desktop installers by a few minutes); try again, or name a version with CLERQ_VERSION."
  fi
  if [ -z "$version" ]; then
    found=$(awk -v suffix="-$platform.tar.gz" '
      { n = $2; sub(/^\*/, "", n) }
      index(n, "openclerq-server-") == 1 && substr(n, length(n) - length(suffix) + 1) == suffix { print n }
    ' "$sums")
    case $found in
      '') die "this release has no server file for $platform." ;;
      *"
"*) die "SHA256SUMS lists more than one server file for $platform; name a version with CLERQ_VERSION." ;;
    esac
    file=$found
    version=${file#openclerq-server-}
    version=${version%-"$platform".tar.gz}
    valid_version "$version" || die "SHA256SUMS names a server file whose version is not a version number ($found); refusing to use it."
  else
    file="openclerq-server-$version-$platform.tar.gz"
  fi
  say "Installing OpenClerq server $version for $platform into $dir"

  say "Downloading $base/$file"
  fetch "$base/$file" "$work/$file" || die "could not download $file. Release $version may not have a server file for $platform."

  if [ "$verify" -eq 1 ]; then
    expected=$(awk -v f="$file" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1 }' "$sums" | tr 'A-F' 'a-f')
    case $expected in
      '') die "SHA256SUMS has no line for $file; refusing to install an unchecked file." ;;
      *"
"*) die "SHA256SUMS has more than one line for $file; refusing to install it." ;;
    esac
    actual=$(sha256_of "$work/$file") || die "neither sha256sum nor shasum is installed, so the download cannot be checked. Install one (coreutils, or perl's shasum), or run this again with --no-verify if you accept that."
    if [ "$actual" != "$expected" ]; then
      die "the download does not match SHA256SUMS (expected $expected, got $actual). Nothing was installed. Try again; if it persists, do not use this file."
    fi
    say "Checksum ok (sha256 $actual)."
  else
    warn "--no-verify: NOT checking the download against SHA256SUMS."
    warn "Anything that can alter what you download (a proxy, a mirror, a captured connection) can give you a program that is not OpenClerq."
  fi

  mkdir "$work/unpacked"
  tar -xzf "$work/$file" -C "$work/unpacked" || die "could not unpack $file."
  top="$work/unpacked/openclerq-server-$version-$platform"
  for f in clerq-server clerq clerq-calc; do
    [ -f "$top/$f" ] || die "the archive has no $f."
  done

  previous=""
  if [ -x "$dir/clerq-server" ]; then
    previous=$("$dir/clerq-server" version 2>/dev/null | head -n 1 || true)
  fi
  priv mkdir -p "$dir" || die "could not create $dir."
  # clerq-calc first: the server looks for it next to itself, so a server that is
  # replaced always finds one at least as new.
  for f in clerq-calc clerq clerq-server; do
    put "$top/$f" "$dir" "$f" || die "could not write $dir/$f."
  done

  unit_note=""
  if [ "$systemd_user" -eq 1 ]; then install_user_unit; fi

  say ""
  say "Installed in $dir:"
  if ! out=$("$dir/clerq-server" version 2>&1); then
    die "$dir/clerq-server was installed but does not start: $out"
  fi
  printf '%s\n' "$out" | sed 's/^/  /'
  if ! out=$("$dir/clerq" --version 2>&1); then
    die "$dir/clerq was installed but does not start: $out"
  fi
  printf '%s\n' "$out" | sed 's/^/  /'
  if [ -n "$previous" ]; then
    say ""
    say "This replaced: $previous. A server that is already running keeps running that"
    say "version until you restart it."
  fi

  run=""
  case ":$PATH:" in
    *":$dir:"*) ;;
    *)
      run="$dir/"
      say ""
      say "$dir is not on your PATH. To use the commands by name, add it in your shell's"
      say "startup file (this installer does not touch those files), for example:"
      say "  export PATH=\"$dir:\$PATH\""
      ;;
  esac

  say ""
  say "Next steps"
  say ""
  say "  1. Run the server in the foreground (Ctrl-C stops it). Its first lines say where"
  say "     the data lives (~/.clerq) and where the token is:"
  say "       ${run}clerq-server"
  say ""
  if [ "$systemd_user" -eq 1 ]; then
    say "  2. Or keep it running as a systemd user service. $unit_note"
    say "     These are the commands; nothing has been run:"
    say "       systemctl --user daemon-reload"
    say "       systemctl --user enable --now openclerq"
    say "       loginctl enable-linger \"\$USER\"      # keeps it running after you log out"
    say "       journalctl --user -u openclerq -f"
  elif [ "$os" = linux ]; then
    say "  2. Or keep it running under systemd: run this installer again with --systemd-user,"
    say "     or follow \"As a system service\" in docs/SERVER.md for a service with its own account."
  else
    say "  2. Or use the desktop app, which starts the same gateway for you."
  fi
  say ""
  say "  3. Use the command line. On this computer it needs no setup:"
  say "       ${run}clerq status"
  say "     For a server somewhere else:"
  say "       ${run}clerq login https://clerq.example.com"
  say ""
  say "Docs: $REPO_URL/blob/v$version/docs/SERVER.md"
}

main "$@"

#!/bin/sh
# Test the OpenClerq server image. Needs Docker, curl and a built image:
#
#   docker build -f apps/server/Dockerfile -t openclerq:test .
#   apps/server/scripts/test-image.sh openclerq:test
#
# It starts the image the way the docs say (port published on 127.0.0.1 only, a named
# volume on /data), waits for Docker's own health check to say healthy, and checks:
#   - the image's labels, its user, and that `docker run <image> version` works;
#   - /v1/health and /v1/version answer; a protected route gives 401 without the token
#     (and with a wrong one) and 200 with the token read through `docker exec`; the log
#     does not show the token;
#   - the server and tini run as uid 10001, tini is PID 1, and ps, git, ssh (which needs
#     a passwd entry for the uid), clerq-calc and the clerq command line work inside;
#   - /data is the account's own and private;
#   - a restart, and a new container on the same volume, keep the token and the files;
#   - CLERQ_GATEWAY_TOKEN sets the token;
#   - `docker stop` ends the server inside 15 s with exit code 0. That is the server's
#     own exit code, passed on by tini: the server handles SIGTERM, stops, and exits 0,
#     and tini exits with its child's status. (143 would mean tini or the server died
#     of the signal instead of handling it; 137, that it was killed after the timeout.)
# It removes what it made. Exits 0 when every check passed, else 1.
set -eu

image=${1:-}
if [ -z "$image" ]; then
  echo "usage: test-image.sh <image>" >&2
  exit 2
fi
for tool in docker curl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "test-image.sh needs $tool" >&2
    exit 2
  }
done

name="clerq-image-test-$$"
vol="$name-data"
work=$(mktemp -d "${TMPDIR:-/tmp}/clerq-test-image.XXXXXX")
# shellcheck disable=SC2317,SC2329 # called through trap
cleanup() {
  docker rm -f -v "$name" "$name-2" "$name-3" >/dev/null 2>&1 || true
  docker volume rm -f "$vol" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

failed=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { # description [text to show]
  printf 'FAIL %s\n' "$1"
  failed=1
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" | head -n 25 | sed 's/^/       /'; fi
}
expect() { # description, actual, expected
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected: $3
got:      $2"; fi
}
dx() { docker exec "$name" "$@"; }

# Start a container the way SERVER.md shows, with a quick health check for the test.
start() { # container-name [docker run options...]
  c=$1
  shift
  docker run -d --name "$c" --stop-timeout 15 \
    --health-interval 2s --health-start-period 40s --health-retries 5 \
    -p 127.0.0.1::18790 "$@" "$image" >/dev/null
}
wait_healthy() { # container-name
  i=0
  while [ "$i" -lt 120 ]; do
    state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1")
    case $state in
      "running healthy") return 0 ;;
      exited* | dead*) break ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  echo "$1 did not become healthy (state: $state). Its log:" >&2
  docker logs "$1" 2>&1 | tail -n 40 >&2
  return 1
}
host_port() { docker port "$1" 18790/tcp | head -n 1; } # 127.0.0.1:49153
status_of() { # url [token]: the HTTP status
  if [ -n "${2:-}" ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $2" "$1"
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1"
  fi
}

echo "Testing image $image"
echo

# ---- the image itself
label() { docker image inspect -f "{{index .Config.Labels \"$1\"}}" "$image"; }
expect "label: source" "$(label org.opencontainers.image.source)" "https://github.com/paxamedia/OpenClerq"
expect "label: licenses" "$(label org.opencontainers.image.licenses)" "MIT"
case $(label org.opencontainers.image.version) in
  '') bad "label: version is set" ;;
  *) ok "label: version is set ($(label org.opencontainers.image.version))" ;;
esac
case $(docker image inspect -f '{{.Config.User}}' "$image") in
  10001 | 10001:10001) ok "the image's user is 10001" ;;
  *) bad "the image's user is 10001" "$(docker image inspect -f '{{.Config.User}}' "$image")" ;;
esac
expect "the data volume and port are declared" \
  "$(docker image inspect -f '{{range $k, $v := .Config.Volumes}}{{$k}}{{end}} {{range $k, $v := .Config.ExposedPorts}}{{$k}}{{end}}' "$image")" \
  "/data 18790/tcp"
expect "the health check is clerq-server healthcheck" \
  "$(docker image inspect -f '{{join .Config.Healthcheck.Test " "}}' "$image")" \
  "CMD clerq-server healthcheck"
version_out=$(docker run --rm "$image" version 2>&1 || true)
case $version_out in
  "clerq-server "*) ok "docker run <image> version prints the release ($(printf '%s' "$version_out" | head -n 1))" ;;
  *) bad "docker run <image> version prints the release" "$version_out" ;;
esac

# ---- a running server
docker volume create "$vol" >/dev/null
start "$name" -v "$vol:/data"
if wait_healthy "$name"; then ok "Docker reports the container healthy (the image's own HEALTHCHECK)"; else
  bad "Docker reports the container healthy"
  exit 1
fi
addr=$(host_port "$name")
case $addr in
  127.0.0.1:*) ok "the port is published on 127.0.0.1 only ($addr)" ;;
  *) bad "the port is published on 127.0.0.1 only" "$addr" ;;
esac
url="http://$addr"

expect "/v1/health answers 200 without a token" "$(status_of "$url/v1/health")" 200
curl -s --max-time 10 "$url/v1/health" >"$work/health.json"
if grep -q '"status":"ok"' "$work/health.json"; then ok "/v1/health says ok"; else bad "/v1/health says ok" "$(cat "$work/health.json")"; fi
expect "/v1/version answers 200 without a token" "$(status_of "$url/v1/version")" 200
curl -s --max-time 10 "$url/v1/version" >"$work/version.json"
if grep -Eq '"schema":[0-9]+' "$work/version.json"; then ok "/v1/version shows the store open"; else bad "/v1/version shows the store open" "$(cat "$work/version.json")"; fi

token=$(dx cat /data/.clerq/gateway-token)
if [ "${#token}" -ge 32 ]; then ok "a token was generated in /data/.clerq/gateway-token"; else bad "a token was generated in /data/.clerq/gateway-token" "$token"; fi
expect "a protected route gives 401 without the token" "$(status_of "$url/v1/runs")" 401
expect "and 401 with a wrong one" "$(status_of "$url/v1/runs" not-the-token)" 401
expect "and 200 with the token" "$(status_of "$url/v1/runs" "$token")" 200
if docker logs "$name" 2>&1 | grep -qF "$token"; then bad "the log does not show the token"; else ok "the log does not show the token"; fi
if docker logs "$name" 2>&1 | grep -q "Calculation engine: /usr/local/bin/clerq-calc"; then ok "the server uses the clerq-calc beside it"; else bad "the server uses the clerq-calc beside it" "$(docker logs "$name" 2>&1 | grep -i 'calculation' || true)"; fi

# ---- who runs, and what is inside
expect "docker exec runs as uid 10001" "$(dx id -u)" 10001
expect "PID 1 is tini" "$(dx cat /proc/1/comm)" tini
expect "PID 1 runs as uid 10001" "$(dx ps -o uid= -p 1 | tr -d ' ')" 10001
procs=$(dx ps -eo uid=,args= | grep '[c]lerq-server' || true)
case $procs in
  '') bad "clerq-server is running" "$(dx ps -eo uid=,args=)" ;;
  *)
    if printf '%s\n' "$procs" | grep -qv '^ *10001 '; then bad "every clerq-server process runs as uid 10001" "$procs"; else ok "every clerq-server process runs as uid 10001"; fi
    ;;
esac
if dx ps -e >/dev/null 2>&1; then ok "ps works (start-up cleanup needs it)"; else bad "ps works (start-up cleanup needs it)"; fi
if dx git --version >/dev/null 2>&1; then ok "git works"; else bad "git works"; fi
if dx sh -c 'git init -q /tmp/probe && git -C /tmp/probe -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m probe && git -C /tmp/probe log --oneline' >/dev/null 2>&1; then ok "git can make a repository and a commit"; else bad "git can make a repository and a commit"; fi
if dx ssh -V >/dev/null 2>&1; then ok "ssh works"; else bad "ssh works"; fi
if dx ssh -G example.com >/dev/null 2>&1; then ok "ssh can read its configuration (the uid has a passwd entry)"; else bad "ssh can read its configuration (the uid has a passwd entry)" "$(dx ssh -G example.com 2>&1 || true)"; fi
expect "the uid's home is /data" "$(dx getent passwd 10001 | cut -d: -f6)" /data
expect "/data is owned by 10001 and private" "$(dx stat -c '%u %a' /data)" "10001 700"
expect "clerq-calc is next to clerq-server" "$(dx sh -c 'cd /usr/local/bin && ls clerq-calc clerq-server clerq | tr "\n" " "')" "clerq clerq-calc clerq-server "
if dx clerq --version | grep -q 'clerq '; then ok "clerq --version runs"; else bad "clerq --version runs"; fi
if dx clerq status >"$work/status.out" 2>&1; then ok "clerq status reaches the server inside the container with its own token"; else bad "clerq status reaches the server inside the container with its own token" "$(cat "$work/status.out")"; fi
if grep -qF "$token" "$work/status.out"; then bad "clerq status does not print the token"; else ok "clerq status does not print the token"; fi

# ---- a restart keeps /data
dx sh -c 'echo kept > /data/marker'
docker restart "$name" >/dev/null
if wait_healthy "$name"; then ok "healthy again after docker restart"; else bad "healthy again after docker restart"; fi
url="http://$(host_port "$name")"
expect "the token is the same after a restart" "$(dx cat /data/.clerq/gateway-token)" "$token"
expect "a file in /data is still there" "$(dx cat /data/marker)" kept
expect "the old token still works" "$(status_of "$url/v1/runs" "$token")" 200
curl -s --max-time 10 "$url/v1/version" >"$work/version2.json"
if grep -Eq '"schema":[0-9]+' "$work/version2.json"; then ok "the store opened again"; else bad "the store opened again" "$(cat "$work/version2.json")"; fi

# ---- docker stop: how long, and with what exit code
started=$(date +%s)
docker stop "$name" >/dev/null
elapsed=$(($(date +%s) - started))
code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
expect "docker stop ends the container with exit code 0 (not 143 or 137)" "$code" 0
if [ "$elapsed" -lt 15 ]; then ok "and does it inside 15 s (took ${elapsed}s)"; else bad "and does it inside 15 s" "took ${elapsed}s"; fi
if docker logs "$name" 2>&1 | grep -q 'Received SIGTERM; stopping'; then ok "the server saw SIGTERM (tini passed it on)"; else bad "the server saw SIGTERM (tini passed it on)" "$(docker logs "$name" 2>&1 | tail -n 8)"; fi
if docker logs "$name" 2>&1 | grep -q 'Stopped'; then ok "and logged that it stopped cleanly"; else bad "and logged that it stopped cleanly"; fi

# ---- a new container on the same volume
docker rm "$name" >/dev/null
start "$name-2" -v "$vol:/data"
if wait_healthy "$name-2"; then ok "a new container on the same volume starts healthy"; else bad "a new container on the same volume starts healthy"; fi
name2="$name-2"
expect "it has the same token" "$(docker exec "$name2" cat /data/.clerq/gateway-token)" "$token"
expect "and the same files" "$(docker exec "$name2" cat /data/marker)" kept
if docker exec "$name2" test -f /data/.clerq/clerq.db; then ok "and the database"; else bad "and the database"; fi

# ---- the token from the environment
fixed=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
start "$name-3" -e "CLERQ_GATEWAY_TOKEN=$fixed"
if wait_healthy "$name-3"; then ok "a container with CLERQ_GATEWAY_TOKEN starts healthy"; else bad "a container with CLERQ_GATEWAY_TOKEN starts healthy"; fi
url3="http://$(host_port "$name-3")"
expect "that token is accepted" "$(status_of "$url3/v1/runs" "$fixed")" 200
expect "the generated one is not" "$(status_of "$url3/v1/runs" "$token")" 401

echo
if [ "$failed" -eq 0 ]; then echo "image test passed"; else echo "image test FAILED"; fi
exit "$failed"

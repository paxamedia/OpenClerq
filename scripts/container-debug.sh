#!/bin/sh
# What a container engine holds after the container-profile tests, written to be read from a CI
# log: the engine, every container and network that carries the label `clerq.run` (in any state,
# so a proxy that crashed shows up), each one's state and logs (the egress proxy's among them),
# and the command lines the tests' runtime wrapper recorded (arguments only, never the
# environment). The tests call it when one fails, and CI runs it after a failed job.
#
# Usage: scripts/container-debug.sh <runtime> [<file of recorded runtime calls> [<byte to start at>]]
#
# Everything here is read-only and best effort: a command that fails prints its error and the
# next one runs.

runtime="${1:-docker}"
calls="${2:-}"
from="${3:-0}"

section() {
  printf '\n=== %s\n' "$1"
}

section "$runtime version"
"$runtime" version 2>&1 | head -n 40

section "containers labelled clerq.run, in any state"
"$runtime" ps -a --filter label=clerq.run --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Label "clerq.run"}}' 2>&1

section "containers named clerq-*, in any state (a container the label missed)"
"$runtime" ps -a --filter name=clerq- --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>&1

section "networks"
"$runtime" network ls 2>&1

section "networks labelled clerq.run"
"$runtime" network ls --filter label=clerq.run --format 'table {{.Name}}\t{{.Driver}}\t{{.Label "clerq.run"}}' 2>&1

for name in $("$runtime" ps -a --filter label=clerq.run --format '{{.Names}}' 2>/dev/null); do
  section "state of $name"
  "$runtime" inspect --format '{{json .State}}' "$name" 2>&1
  section "logs of $name (last 80 lines; an egress proxy logs what it allowed and refused)"
  "$runtime" logs --tail 80 "$name" 2>&1
done

for name in $("$runtime" network ls --filter label=clerq.run --format '{{.Name}}' 2>/dev/null); do
  section "network $name"
  "$runtime" network inspect --format 'internal={{.Internal}} containers:{{range .Containers}} {{.Name}}{{end}}' "$name" 2>&1
done

section "images"
"$runtime" images 2>&1 | head -n 30

if [ -n "$calls" ] && [ -f "$calls" ]; then
  if [ "$from" -gt 0 ] 2>/dev/null; then
    section "runtime calls the failed test made (time, shell pid, arguments)"
    tail -c "+$((from + 1))" "$calls" | tail -n 300
  else
    section "runtime calls the tests made (time, shell pid, arguments; last 300)"
    tail -n 300 "$calls"
  fi
fi

exit 0

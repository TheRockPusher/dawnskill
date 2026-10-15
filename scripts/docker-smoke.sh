#!/usr/bin/env bash
# Smoke-test a built dawnskill image.
# Usage: scripts/docker-smoke.sh <image>
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <image>" >&2
  exit 2
fi

image=$1
name="dawnskill-smoke-$$-${RANDOM}"
volume="${name}-data"
healthy_timeout_s=30

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    echo "--- container logs ---" >&2
    docker logs "$name" >&2 2>&1 || true
  fi
  docker rm --force --volumes "$name" >/dev/null 2>&1 || true
  docker volume rm --force "$volume" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

now_ms() { date +%s%3N; }

# --- start ---------------------------------------------------------------------
docker volume create "$volume" >/dev/null
start_ms=$(now_ms)
# Host port 0 → Docker picks a free port; read it back below.
docker run --detach --name "$name" \
  --volume "${volume}:/data" \
  --publish "127.0.0.1::3000" \
  "$image" >/dev/null

port=$(docker port "$name" 3000/tcp | head -n 1 | sed 's/.*://')
[[ -n $port ]] || fail "could not determine published host port"
base_url="http://127.0.0.1:${port}"
echo "container ${name} on ${base_url}"

# --- wait for /healthz -----------------------------------------------------------
deadline_ms=$((start_ms + healthy_timeout_s * 1000))
until body=$(curl --silent --fail --max-time 2 "${base_url}/healthz" 2>/dev/null) &&
  [[ $body =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]; do
  if [[ $(docker inspect --format '{{.State.Running}}' "$name") != "true" ]]; then
    fail "container exited before becoming healthy"
  fi
  if (($(now_ms) > deadline_ms)); then
    fail "/healthz did not return ok:true within ${healthy_timeout_s}s"
  fi
  sleep 0.2
done
healthy_ms=$(($(now_ms) - start_ms))
echo "ok   GET /healthz → ${body}"

# --- HTTP checks -----------------------------------------------------------------
# Helpers first; add API checks after the existing ones below.

# http_get <path> → prints the response body; fails on non-2xx.
http_get() {
  curl --silent --show-error --fail --max-time 5 "${base_url}$1" ||
    fail "GET $1 failed"
}

# expect_contains <label> <haystack> <needle>
expect_contains() {
  [[ $2 == *"$3"* ]] || fail "$1: response does not contain '$3'"
  echo "ok   $1"
}

index_html=$(http_get /)
expect_contains "GET / serves the SPA" "$index_html" "Dawnskill"

# --- container checks ------------------------------------------------------------
uid=$(docker exec "$name" id -u)
[[ $uid != "0" ]] || fail "container runs as root"
echo "ok   runs as non-root (uid ${uid})"

# --- report ----------------------------------------------------------------------
size_bytes=$(docker image inspect --format '{{.Size}}' "$image")
echo "image size:      $((size_bytes / 1024 / 1024)) MiB (${size_bytes} bytes)"
echo "time to healthy: ${healthy_ms} ms"
echo "smoke test passed"

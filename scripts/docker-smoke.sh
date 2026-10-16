#!/usr/bin/env bash
# Smoke-test a built dawnskill image.
# Usage: scripts/docker-smoke.sh <image>
#        SMOKE_BASE_URL=http://127.0.0.1:3977 scripts/docker-smoke.sh
#          → runs only the HTTP checks against an already running server
#            (fresh data dir, no LLM configured); container checks and the
#            restart/persistence check are skipped.
set -euo pipefail

SMOKE_BASE_URL=${SMOKE_BASE_URL:-}
base_url=$SMOKE_BASE_URL
if [[ -z $base_url && $# -ne 1 ]]; then
  echo "usage: $0 <image>   (or SMOKE_BASE_URL=<url> $0)" >&2
  exit 2
fi

image=${1:-}
name="dawnskill-smoke-$$-${RANDOM}"
volume="${name}-data"
healthy_timeout_s=30
tmp_body=$(mktemp)

cleanup() {
  local status=$?
  rm -f "$tmp_body"
  if [[ -z ${SMOKE_BASE_URL:-} ]]; then
    if [[ $status -ne 0 ]]; then
      echo "--- container logs ---" >&2
      docker logs "$name" >&2 2>&1 || true
    fi
    docker rm --force --volumes "$name" >/dev/null 2>&1 || true
    docker volume rm --force "$volume" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

now_ms() { date +%s%3N; }

# wait_healthy → sets $body to the /healthz response; fails after the timeout.
wait_healthy() {
  local deadline_ms=$(($(now_ms) + healthy_timeout_s * 1000))
  until body=$(curl --silent --fail --max-time 2 "${base_url}/healthz" 2>/dev/null) &&
    [[ $body =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]; do
    if [[ -z ${SMOKE_BASE_URL:-} && $(docker inspect --format '{{.State.Running}}' "$name") != "true" ]]; then
      fail "container exited before becoming healthy"
    fi
    if (($(now_ms) > deadline_ms)); then
      fail "/healthz did not return ok:true within ${healthy_timeout_s}s"
    fi
    sleep 0.2
  done
}

# --- start ---------------------------------------------------------------------
start_ms=$(now_ms)
# resolve_base_url → sets $base_url from the container's published host port.
resolve_base_url() {
  local port
  port=$(docker port "$name" 3000/tcp | head -n 1 | sed 's/.*://')
  [[ -n $port ]] || fail "could not determine published host port"
  base_url="http://127.0.0.1:${port}"
}

if [[ -z $SMOKE_BASE_URL ]]; then
  docker volume create "$volume" >/dev/null
  # Host port 0 → Docker picks a free port; read it back below.
  docker run --detach --name "$name" \
    --volume "${volume}:/data" \
    --publish "127.0.0.1::3000" \
    "$image" >/dev/null

  resolve_base_url
  echo "container ${name} on ${base_url}"
else
  echo "external server on ${base_url} (docker steps skipped)"
fi

# --- wait for /healthz -----------------------------------------------------------
wait_healthy
healthy_ms=$(($(now_ms) - start_ms))
echo "ok   GET /healthz → ${body}"

# --- HTTP checks -----------------------------------------------------------------

# http_get <path> → prints the response body; fails on non-2xx.
http_get() {
  curl --silent --show-error --fail --max-time 5 "${base_url}$1" ||
    fail "GET $1 failed"
}

# expect_contains <label> <haystack> <needle>
expect_contains() {
  [[ $2 == *"$3"* ]] || fail "$1: response does not contain '$3'"$'\n'"$2"
  echo "ok   $1"
}

# expect_status <label> <expected> <method> <path> [json-body]
# Sets $resp to the response body; fails with the body on a status mismatch.
expect_status() {
  local label=$1 expected=$2 method=$3 path=$4 data=${5:-}
  local args=(--silent --show-error --max-time 10 --output "$tmp_body" --write-out '%{http_code}'
    --request "$method")
  [[ -n $data ]] && args+=(--header 'content-type: application/json' --data "$data")
  local code
  code=$(curl "${args[@]}" "${base_url}${path}") || fail "${method} ${path}: request failed"
  resp=$(<"$tmp_body")
  [[ $code == "$expected" ]] ||
    fail "${label}: expected HTTP ${expected}, got ${code}"$'\n'"${resp}"
  echo "ok   ${label}"
}

# json_seq <json> → prints the top-level "seq" number.
json_seq() {
  local seq
  seq=$(grep -oE '"seq"[[:space:]]*:[[:space:]]*[0-9]+' <<<"$1" | head -n 1 | grep -oE '[0-9]+$') ||
    fail "no seq in view"$'\n'"$1"
  echo "$seq"
}

index_html=$(http_get /)
expect_contains "GET / serves the SPA" "$index_html" "Dawnskill"

# Offline end-to-end flow: no LLM configured, so plans are posted as user events.
config=$(http_get /api/config)
[[ $config =~ \"llm\"[[:space:]]*:[[:space:]]*\{[^}]*\"configured\"[[:space:]]*:[[:space:]]*false ]] ||
  fail "GET /api/config: llm.configured is not false"$'\n'"$config"
echo "ok   GET /api/config → llm.configured false"

expect_status "POST /api/plan → 503 without LLM" 503 POST /api/plan \
  '{"goal":"Learn something"}'

draft='{"goal":"Ship the smoke feature","summary":"One skill, one task.","skills":[{"key":"smoke-skill","name":"Smoke skill","description":"Enough to ship the smoke feature.","concepts":["first concept","second concept"],"prerequisites":[],"resources":[],"retrievalPrompts":["Explain the first concept."],"practiceMinutes":30}],"tasks":[{"ref":"ship","title":"Ship the smoke feature","notes":"","doneWhen":"The feature is live.","category":"build","estimateMinutes":60,"importance":4,"urgency":3,"requires":[{"skill":"smoke-skill","level":2}],"after":[]}]}'
expect_status "POST PlanProposed → 200" 200 POST /api/events \
  "{\"type\":\"PlanProposed\",\"draft\":${draft},\"supersedes\":null}"
expect_status "POST PlanApproved P1 → 200" 200 POST /api/events \
  '{"type":"PlanApproved","proposalId":"P1","ratings":{"smoke-skill":0}}'

view=$(http_get /api/view)
expect_contains "view has worked-examples learning task" "$view" '"activity":"worked-examples"'
expect_contains "view has guided-practice learning task" "$view" '"activity":"guided-practice"'
[[ $view =~ \"focus\"[[:space:]]*:[[:space:]]*\{[^}]*\"learning\"[[:space:]]*:[[:space:]]*\[[[:space:]]*\"T ]] ||
  fail "view: focus.learning is empty"$'\n'"$view"
echo "ok   view focus.learning non-empty"
seq_before=$(json_seq "$view")

# Ids come from one shared counter, so look up the work task by its title.
work_id=$(grep -oE '"id":"T[0-9]+","goalId":"G[0-9]+","title":"Ship the smoke feature"' <<<"$view" |
  grep -oE 'T[0-9]+' | head -n 1) || fail "view: work task not found"$'\n'"$view"
[[ -n $work_id ]] || fail "view: work task not found"$'\n'"$view"
expect_status "TaskStarted on blocked work task ${work_id} → 409" 409 POST /api/events \
  "{\"type\":\"TaskStarted\",\"taskId\":\"${work_id}\"}"

if [[ -z $SMOKE_BASE_URL ]]; then
  docker restart "$name" >/dev/null
  # Docker assigns a new random host port on restart; re-read it.
  resolve_base_url
  echo "restarted ${name} on ${base_url}"
  wait_healthy
  seq_after=$(json_seq "$(http_get /api/view)")
  [[ $seq_after == "$seq_before" ]] ||
    fail "after restart: view seq ${seq_after} != ${seq_before}"
  echo "ok   restart keeps view (seq ${seq_after})"
fi

export_body=$(http_get /api/export)
expect_contains "GET /api/export format" "$export_body" '"format":"dawnskill-events"'

if [[ -n $SMOKE_BASE_URL ]]; then
  echo "smoke test passed (HTTP only)"
  exit 0
fi

# --- container checks ------------------------------------------------------------
uid=$(docker exec "$name" id -u)
[[ $uid != "0" ]] || fail "container runs as root"
echo "ok   runs as non-root (uid ${uid})"

# --- report ----------------------------------------------------------------------
size_bytes=$(docker image inspect --format '{{.Size}}' "$image")
echo "image size:      $((size_bytes / 1024 / 1024)) MiB (${size_bytes} bytes)"
echo "time to healthy: ${healthy_ms} ms"
echo "smoke test passed"

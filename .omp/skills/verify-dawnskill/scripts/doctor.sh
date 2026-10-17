#!/usr/bin/env bash
# Read-only health check for one verification run. Exits non-zero unless the instance is up, is this
# run's process (PID, cwd, env), listens on this run's port, reports the expected version, and stores
# its data in scratch. Usage: doctor.sh <RUN_ENV>
set -uo pipefail

RUN_ENV="${1:?usage: doctor.sh <RUN_ENV>}"
fail() {
	echo "doctor: FAIL $*" >&2
	exit 1
}
[[ -r "$RUN_ENV" ]] || fail "no run.env at $RUN_ENV (scratch removed or never created)"
# shellcheck disable=SC1090
source "$RUN_ENV"

[[ -s "$SERVER_PID_FILE" ]] || fail "no PID file $SERVER_PID_FILE (service not started)"
PID="$(<"$SERVER_PID_FILE")"
[[ -d "/proc/$PID" ]] || fail "PID $PID not running; log: $SERVER_LOG"
[[ "$(readlink "/proc/$PID/cwd")" == "$REPO" ]] || fail "PID $PID cwd is not $REPO"
ENVIRON="$(tr '\0' '\n' <"/proc/$PID/environ")"
grep -qx "VERIFY_DAWNSKILL_RUN_ID=$RUN_ID" <<<"$ENVIRON" || fail "PID $PID does not belong to run $RUN_ID"
grep -qx "DATA_DIR=$DATA_DIR" <<<"$ENVIRON" || fail "PID $PID DATA_DIR is not $DATA_DIR"
grep -qx "HOME=$SCRATCH_HOME" <<<"$ENVIRON" || fail "PID $PID HOME is not $SCRATCH_HOME"
grep -q '^DAWNSKILL_LLM_' <<<"$ENVIRON" && fail "PID $PID inherited DAWNSKILL_LLM_* variables"

LISTENER="$(ss -Hltnp "sport = :$PORT" 2>/dev/null)"
grep -q "pid=$PID," <<<"$LISTENER" || fail "port $PORT is not held by PID $PID: ${LISTENER:-nothing listening}"

HEALTH="$(curl -fsS --max-time 5 "$BASE_URL/healthz")" || fail "GET $BASE_URL/healthz failed"
VERSION="$(node -e 'const h=JSON.parse(process.argv[1]);if(h.ok!==true)process.exit(1);console.log(h.version)' "$HEALTH")" ||
	fail "unexpected /healthz body: $HEALTH"
[[ "$VERSION" == "$EXPECTED_VERSION" ]] || fail "version $VERSION, expected $EXPECTED_VERSION"

[[ -f "$DATA_DIR/dawnskill.db" ]] || fail "no database at $DATA_DIR/dawnskill.db"
[[ -f "$WEB_DIR/index.html" ]] || fail "no built UI at $WEB_DIR/index.html"
curl -fsS --max-time 5 "$BASE_URL/" | grep -q '<div id="app"' || fail "GET / does not serve the built UI"

echo "doctor: OK run=$RUN_ID pid=$PID version=$VERSION url=$BASE_URL db=$DATA_DIR/dawnskill.db evidence=$EVIDENCE"

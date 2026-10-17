#!/usr/bin/env bash
# GET a path on this run's instance (a read-only second view). Prints the HTTP status line and body;
# with EVIDENCE_NAME also writes request, status and body to $EVIDENCE/EVIDENCE_NAME.
# Exits non-zero when the request fails or the status is not 2xx.
# Usage: api.sh <RUN_ENV> <PATH> [EVIDENCE_NAME]      e.g. api.sh "$RUN_ENV" /api/config model-settings/config.http
set -euo pipefail

RUN_ENV="${1:?usage: api.sh <RUN_ENV> <PATH> [EVIDENCE_NAME]}"
REQ_PATH="${2:?usage: api.sh <RUN_ENV> <PATH> [EVIDENCE_NAME]}"
OUT="${3:-}"
# shellcheck disable=SC1090
source "$RUN_ENV"

BODY_FILE="$(mktemp "$SCRATCH/api.XXXXXX")"
trap 'rm -f "$BODY_FILE"' EXIT
STATUS="$(curl -sS --compressed --max-time 10 -o "$BODY_FILE" -w '%{http_code}' "$BASE_URL$REQ_PATH")"
BODY="$(<"$BODY_FILE")"

echo "HTTP $STATUS"
printf '%s\n' "$BODY"
if [[ -n "$OUT" ]]; then
	mkdir -p "$(dirname "$EVIDENCE/$OUT")"
	printf 'GET %s\nHTTP %s\n\n%s\n' "$BASE_URL$REQ_PATH" "$STATUS" "$BODY" >"$EVIDENCE/$OUT"
fi
[[ "$STATUS" == 2* ]]

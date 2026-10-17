#!/usr/bin/env bash
# Read-only SQL against this run's SQLite file (the second view of every mutation). Prints one JSON
# object per row; with EVIDENCE_NAME also writes the query and rows to $EVIDENCE/EVIDENCE_NAME.
# Usage: db.sh <RUN_ENV> "<SELECT …>" [EVIDENCE_NAME]
# Tables: kernel_events (seq, at, actor, type, body) is the source of truth; goals, tasks, skills,
# assessments, proposals, completions, reviews, dependencies, task_requirements are its projection.
set -euo pipefail

RUN_ENV="${1:?usage: db.sh <RUN_ENV> <SQL> [EVIDENCE_NAME]}"
SQL="${2:?usage: db.sh <RUN_ENV> <SQL> [EVIDENCE_NAME]}"
OUT="${3:-}"
# shellcheck disable=SC1090
source "$RUN_ENV"
DB="$DATA_DIR/dawnskill.db"
[[ -f "$DB" ]] || {
	echo "db: no database at $DB" >&2
	exit 1
}

ROWS="$(node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
for (const row of db.prepare(process.argv[2]).all()) console.log(JSON.stringify(row));
' "$DB" "$SQL")"

printf '%s\n' "$ROWS"
if [[ -n "$OUT" ]]; then
	mkdir -p "$(dirname "$EVIDENCE/$OUT")"
	printf -- '-- %s\n%s\n' "$SQL" "$ROWS" >"$EVIDENCE/$OUT"
fi

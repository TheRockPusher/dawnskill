#!/usr/bin/env bash
# Allocate one isolated verification run: run ID, scratch dir, free port, scratch DATA_DIR and HOME,
# a web UI built from the current working tree into scratch, and the evidence dir.
# Prints RUN_ENV=<path>; every other script takes that path as its only argument.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO"

RUN_ID="$(date -u +%Y%m%dt%H%M%Sz)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/verify-dawnskill.XXXXXX")"
PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
EVIDENCE="$REPO/.omp/evidence/verify-dawnskill/$RUN_ID"
VERSION="$(node -p 'require("./package.json").version')"

mkdir -p "$SCRATCH/data" "$SCRATCH/home" "$EVIDENCE"

# Build the UI from the current source into scratch, so packages/web/dist (the user's build) is untouched.
pnpm --silent --filter @dawnskill/web exec vite build --outDir "$SCRATCH/web" --emptyOutDir --logLevel warn >"$SCRATCH/build.log" 2>&1 || {
	cat "$SCRATCH/build.log" >&2
	echo "new-run: web build failed; scratch kept at $SCRATCH (remove with cleanup.sh $SCRATCH/run.env)" >&2
	exit 1
}

# HOME is stored as SCRATCH_HOME so sourcing run.env in an agent shell never redirects that shell's HOME;
# serve.sh exports it as HOME for the server only.
cat >"$SCRATCH/run.env" <<EOF
export VERIFY_DAWNSKILL_RUN_ID=$RUN_ID
export RUN_ID=$RUN_ID
export REPO=$REPO
export SCRATCH=$SCRATCH
export HOST=127.0.0.1
export PORT=$PORT
export BASE_URL=http://127.0.0.1:$PORT
export DATA_DIR=$SCRATCH/data
export WEB_DIR=$SCRATCH/web
export SCRATCH_HOME=$SCRATCH/home
export EVIDENCE=$EVIDENCE
export EXPECTED_VERSION=$VERSION
export SERVER_PID_FILE=$SCRATCH/server.pid
export SERVER_LOG=$SCRATCH/server.log
EOF

echo "RUN_ID=$RUN_ID"
echo "PORT=$PORT"
echo "BASE_URL=http://127.0.0.1:$PORT"
echo "EVIDENCE=$EVIDENCE"
echo "SERVICE=verify-dawnskill-$RUN_ID"
echo "RUN_ENV=$SCRATCH/run.env"
echo "SERVE_COMMAND=.omp/skills/verify-dawnskill/scripts/serve.sh $SCRATCH/run.env"
echo "export RUN_ENV=$SCRATCH/run.env"
echo "globalThis.RUN_ENV = \"$SCRATCH/run.env\";"

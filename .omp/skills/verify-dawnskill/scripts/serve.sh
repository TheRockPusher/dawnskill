#!/usr/bin/env bash
# Run the Dawnskill host for one verification run in the foreground (start it as an OMP named service).
# Usage: serve.sh <RUN_ENV>
set -euo pipefail

RUN_ENV="${1:?usage: serve.sh <RUN_ENV>}"
# shellcheck disable=SC1090
source "$RUN_ENV"
cd "$REPO"

# No model from the caller's environment: the run starts with "no model configured" unless a recipe saves one.
unset DAWNSKILL_LLM_BASE_URL DAWNSKILL_LLM_API_KEY DAWNSKILL_LLM_MODEL DAWNSKILL_LLM_TIMEOUT_MS DAWNSKILL_LLM_MAX_TOKENS
export HOME="$SCRATCH_HOME"

echo "$$" >"$SERVER_PID_FILE"
# exec keeps the PID: the recorded PID is the node process itself. Log goes to the terminal and $SERVER_LOG.
exec node packages/host/src/main.ts > >(tee -a "$SERVER_LOG") 2>&1

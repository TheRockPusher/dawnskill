#!/usr/bin/env bash
# Stop only this run's host process (if the named service did not already), remove the run's scratch
# dir, keep and list its evidence. Safe to run twice and after a failed launch.
# Usage: cleanup.sh <RUN_ENV>
set -uo pipefail

RUN_ENV="${1:?usage: cleanup.sh <RUN_ENV>}"
SCRATCH="$(dirname "$RUN_ENV")"
case "$SCRATCH" in
"${TMPDIR:-/tmp}"/verify-dawnskill.*) ;;
*)
	echo "cleanup: refusing: $SCRATCH is not a verify-dawnskill scratch dir" >&2
	exit 1
	;;
esac

if [[ ! -d "$SCRATCH" ]]; then
	echo "cleanup: $SCRATCH already removed"
	exit 0
fi

EVIDENCE=""
if [[ -r "$RUN_ENV" ]]; then
	# shellcheck disable=SC1090
	source "$RUN_ENV"
	# Our own children must not carry the run ID, or the leftover scan below would find them.
	export -n VERIFY_DAWNSKILL_RUN_ID
	if [[ -s "$SERVER_PID_FILE" ]]; then
		PID="$(<"$SERVER_PID_FILE")"
		# Kill only when the PID still carries this run's ID; a recycled PID is left alone.
		if [[ -r "/proc/$PID/environ" ]] && tr '\0' '\n' <"/proc/$PID/environ" | grep -qx "VERIFY_DAWNSKILL_RUN_ID=$RUN_ID"; then
			kill -TERM "$PID" 2>/dev/null
			for _ in $(seq 50); do
				[[ -d "/proc/$PID" ]] || break
				sleep 0.2
			done
			if [[ -d "/proc/$PID" ]]; then
				echo "cleanup: PID $PID ignored SIGTERM for 10s; sending SIGKILL" >&2
				kill -KILL "$PID" 2>/dev/null
			fi
			echo "cleanup: stopped PID $PID"
		else
			echo "cleanup: PID $PID is not running for run $RUN_ID; nothing to stop"
		fi
	fi
	# Any process still carrying this run's ID (e.g. the log tee) is ours; report it instead of guessing.
	sleep 0.5
	LEFT=""
	for f in /proc/[0-9]*/environ; do
		# Other users' processes are unreadable and cannot be ours.
		[[ -r "$f" ]] || continue
		if tr '\0' '\n' 2>/dev/null <"$f" | grep -qx "VERIFY_DAWNSKILL_RUN_ID=$RUN_ID"; then
			pid="${f#/proc/}"
			LEFT+=" ${pid%/environ}"
		fi
	done
	if [[ -n "$LEFT" ]]; then
		echo "cleanup: processes of run $RUN_ID still running:$LEFT (stop the named service, then rerun)" >&2
		exit 1
	fi
	echo "cleanup: no process of run $RUN_ID left"
fi

rm -rf -- "$SCRATCH"
echo "cleanup: removed $SCRATCH"

if [[ -n "$EVIDENCE" && -d "$EVIDENCE" ]]; then
	echo "cleanup: evidence kept at $EVIDENCE:"
	find "$EVIDENCE" -type f | sort
fi

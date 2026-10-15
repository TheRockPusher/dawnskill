import type { ProposalStatus, TaskStatus } from "./types.ts";

/**
 * Task lifecycle. The reducer, the generated SQLite triggers and the web UI all read this table;
 * a status pair absent here is illegal everywhere.
 */
export const TASK_TRANSITIONS = {
	TaskStarted: { from: ["open"], to: "doing" },
	TaskPaused: { from: ["doing"], to: "open" },
	TaskCompleted: { from: ["open", "doing"], to: "done" },
	TaskCancelled: { from: ["open", "doing"], to: "cancelled" },
	TaskReopened: { from: ["done", "cancelled"], to: "open" },
} as const satisfies Record<string, { readonly from: readonly TaskStatus[]; readonly to: TaskStatus }>;

/** Proposal lifecycle: the only path from agent output to a state change. */
export const PROPOSAL_TRANSITIONS = {
	PlanApproved: { from: ["pending"], to: "accepted" },
	LevelConfirmed: { from: ["pending"], to: "accepted" },
	ProposalRejected: { from: ["pending"], to: "rejected" },
	/** A newer draft, a self-rating, or a confirmed level replaced it. */
	Superseded: { from: ["pending"], to: "superseded" },
} as const satisfies Record<string, { readonly from: readonly ProposalStatus[]; readonly to: ProposalStatus }>;

export type TaskTransition = keyof typeof TASK_TRANSITIONS;
export type ProposalTransition = keyof typeof PROPOSAL_TRANSITIONS;

export const TASK_STATUSES = ["open", "doing", "done", "cancelled"] as const satisfies readonly TaskStatus[];
export const PROPOSAL_STATUSES = [
	"pending",
	"accepted",
	"rejected",
	"superseded",
] as const satisfies readonly ProposalStatus[];

function edges<S extends string>(
	table: Record<string, { readonly from: readonly S[]; readonly to: S }>,
): ReadonlyArray<readonly [S, S]> {
	const seen = new Set<string>();
	const out: Array<readonly [S, S]> = [];
	for (const { from, to } of Object.values(table)) {
		for (const f of from) {
			const key = `${f}>${to}`;
			if (!seen.has(key)) {
				seen.add(key);
				out.push([f, to]);
			}
		}
	}
	return out;
}

/** Distinct (from, to) status pairs; input for trigger generation and trigger tests. */
export const TASK_STATUS_EDGES = edges<TaskStatus>(TASK_TRANSITIONS);
export const PROPOSAL_STATUS_EDGES = edges<ProposalStatus>(PROPOSAL_TRANSITIONS);

/** Statuses from which `transition` is legal. */
export function canTaskTransition(status: TaskStatus, transition: TaskTransition): boolean {
	return (TASK_TRANSITIONS[transition].from as readonly TaskStatus[]).includes(status);
}

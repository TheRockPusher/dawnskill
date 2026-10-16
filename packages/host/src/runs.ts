// Background planner runs: model output only ever becomes a pending PlanProposed (agents propose, K6).
import type { ProposalId } from "@dawnskill/core";
import { type ChatProvider, PlannerError, planGoal } from "@dawnskill/agents";
import type { Store } from "./db/store.ts";

type RunStatus = "running" | "done" | "failed";

export interface PlanRun {
	readonly id: string;
	readonly goal: string;
	readonly status: RunStatus;
	/** Model attempts (first answer plus repairs); 0 when the provider failed before any answer. */
	readonly attempts: number;
	readonly error: string | null;
	/** Validation errors of the last attempt when the planner gave up. */
	readonly errors: readonly string[];
	readonly proposalId: ProposalId | null;
	readonly startedAt: string;
	readonly finishedAt: string | null;
}

interface PlanInput {
	readonly goal: string;
	readonly context: string;
	readonly supersedes: ProposalId | null;
}

export interface PlanRuns {
	/** Starts a run against `provider` in the background; null while another run is still in progress. */
	start(input: PlanInput, provider: ChatProvider): PlanRun | null;
	/** Newest first, at most the last 20 runs. */
	list(): readonly PlanRun[];
	/** Resolves once no run is in progress. Never rejects. */
	idle(): Promise<void>;
	/** Called with the new run object on every status change. */
	subscribe(listener: (run: PlanRun) => void): () => void;
	/** Aborts the run in progress, if any; it then finishes as failed. */
	abort(): void;
}

const KEEP = 20;

export function createPlanRuns(store: Store, clock: () => string): PlanRuns {
	let runs: readonly PlanRun[] = [];
	let counter = 0;
	let active: { readonly promise: Promise<void>; readonly controller: AbortController } | null = null;
	const listeners = new Set<(run: PlanRun) => void>();

	function publish(run: PlanRun): void {
		const others = runs.filter((r) => r.id !== run.id);
		runs = run.status === "running" ? [run, ...others].slice(0, KEEP) : runs.map((r) => (r.id === run.id ? run : r));
		for (const listener of listeners) {
			try {
				listener(run);
			} catch (error) {
				console.error("plan run listener failed", error);
			}
		}
	}

	async function execute(run: PlanRun, input: PlanInput, provider: ChatProvider, signal: AbortSignal): Promise<void> {
		let finished: PlanRun;
		try {
			const result = await planGoal(provider, store.state, { goal: input.goal, context: input.context }, { signal });
			const before = store.state.proposals;
			const applied = store.apply({
				type: "PlanProposed",
				draft: result.draft,
				supersedes: input.supersedes,
				actor: "agent",
				at: clock(),
			});
			finished = applied.ok
				? {
						...run,
						status: "done",
						attempts: result.attempts,
						proposalId: Object.keys(applied.state.proposals).find((id) => !Object.hasOwn(before, id)) ?? null,
						finishedAt: clock(),
					}
				: {
						...run,
						status: "failed",
						attempts: result.attempts,
						error: `${applied.code}: ${applied.message}`,
						finishedAt: clock(),
					};
		} catch (error) {
			finished = {
				...run,
				status: "failed",
				attempts: error instanceof PlannerError ? error.attempts : 0,
				error: error instanceof Error ? error.message : String(error),
				errors: error instanceof PlannerError ? error.errors : [],
				finishedAt: clock(),
			};
		}
		active = null;
		publish(finished);
	}

	return {
		start(input, provider) {
			if (active !== null) return null;
			counter += 1;
			const run: PlanRun = {
				id: `R${counter}`,
				goal: input.goal,
				status: "running",
				attempts: 0,
				error: null,
				errors: [],
				proposalId: null,
				startedAt: clock(),
				finishedAt: null,
			};
			publish(run);
			const controller = new AbortController();
			active = { controller, promise: execute(run, input, provider, controller.signal) };
			return run;
		},
		list: () => runs,
		idle: () => active?.promise ?? Promise.resolve(),
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		abort() {
			active?.controller.abort();
		},
	};
}

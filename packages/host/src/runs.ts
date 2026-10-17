// Background planner runs: model output only ever becomes a pending PlanProposed (agents propose, K6).
// Runs are queued and execute one at a time, oldest first, so a single local model is never asked twice at once.
import type { ProposalId } from "@dawnskill/core";
import { type ChatProvider, PlannerError, planGoal } from "@dawnskill/agents";
import type { Store } from "./db/store.ts";

type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

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
	readonly queuedAt: string;
	/** Null while the run waits behind earlier runs. */
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
}

interface PlanInput {
	readonly goal: string;
	readonly context: string;
	readonly supersedes: ProposalId | null;
}

export interface PlanRuns {
	/**
	 * Queues a run against `provider`; it starts once every earlier run has finished. Null when
	 * `MAX_PENDING` runs are already queued or running.
	 */
	start(input: PlanInput, provider: ChatProvider): PlanRun | null;
	/** Newest first, at most the last 20 runs; queued and running runs are always listed. */
	list(): readonly PlanRun[];
	/** Resolves once no run is queued or in progress. Never rejects. */
	idle(): Promise<void>;
	/** Called with the new run object on every status change. */
	subscribe(listener: (run: PlanRun) => void): () => void;
	/**
	 * Cancels a queued or running run: it is published as `cancelled` at once and never proposes. A running
	 * run's model request is aborted; the next queued run starts once that request has unwound.
	 */
	cancel(id: string): CancelResult;
	/** Cancels every queued and running run (shutdown). */
	cancelAll(): void;
}

type CancelResult =
	| { readonly ok: true; readonly run: PlanRun }
	| { readonly ok: false; readonly code: "not-found" | "finished" };

const KEEP = 20;
/** Queued plus running runs. Below KEEP, so `list()` never trims a run that has not finished. */
export const MAX_PENDING = 10;

interface Job {
	readonly run: PlanRun;
	readonly input: PlanInput;
	readonly provider: ChatProvider;
}

export function createPlanRuns(store: Store, clock: () => string): PlanRuns {
	let runs: readonly PlanRun[] = [];
	let counter = 0;
	const queue: Job[] = [];
	/** The running run and its controller; null between runs. Stays set while a cancelled run unwinds. */
	let current: { readonly run: PlanRun; readonly controller: AbortController } | null = null;
	/** The loop draining `queue`; null when nothing is queued or running. */
	let worker: Promise<void> | null = null;
	const listeners = new Set<(run: PlanRun) => void>();

	function publish(run: PlanRun): void {
		runs = runs.some((r) => r.id === run.id)
			? runs.map((r) => (r.id === run.id ? run : r))
			: [run, ...runs].slice(0, KEEP);
		for (const listener of listeners) {
			try {
				listener(run);
			} catch (error) {
				console.error("plan run listener failed", error);
			}
		}
	}

	async function execute(
		run: PlanRun,
		input: PlanInput,
		provider: ChatProvider,
		signal: AbortSignal,
	): Promise<PlanRun> {
		let finished: PlanRun;
		try {
			const result = await planGoal(provider, store.state, { goal: input.goal, context: input.context }, { signal });
			// A provider may finish despite the abort; a cancelled run must never propose.
			signal.throwIfAborted();
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
		return finished;
	}

	/** Runs queued jobs one by one until the queue is empty; `start` calls during a run append to it. */
	async function drain(): Promise<void> {
		for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
			const controller = new AbortController();
			const run: PlanRun = { ...job.run, status: "running", startedAt: clock() };
			current = { run, controller };
			publish(run);
			const finished = await execute(run, job.input, job.provider, controller.signal);
			current = null;
			// Cancelled: `cancel` already published the final record.
			if (!controller.signal.aborted) publish(finished);
		}
		worker = null;
	}

	function cancelled(run: PlanRun): PlanRun {
		const final: PlanRun = { ...run, status: "cancelled", finishedAt: clock() };
		publish(final);
		return final;
	}

	return {
		start(input, provider) {
			if (queue.length + (current === null ? 0 : 1) >= MAX_PENDING) return null;
			counter += 1;
			const run: PlanRun = {
				id: `R${counter}`,
				goal: input.goal,
				status: "queued",
				attempts: 0,
				error: null,
				errors: [],
				proposalId: null,
				queuedAt: clock(),
				startedAt: null,
				finishedAt: null,
			};
			queue.push({ run, input, provider });
			publish(run);
			worker ??= drain();
			return run;
		},
		list: () => runs,
		idle: () => worker ?? Promise.resolve(),
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		cancel(id) {
			const index = queue.findIndex((job) => job.run.id === id);
			if (index !== -1) {
				const [job] = queue.splice(index, 1);
				if (job !== undefined) return { ok: true, run: cancelled(job.run) };
			}
			if (current !== null && current.run.id === id && !current.controller.signal.aborted) {
				current.controller.abort();
				return { ok: true, run: cancelled(current.run) };
			}
			return { ok: false, code: runs.some((r) => r.id === id) ? "finished" : "not-found" };
		},
		cancelAll() {
			for (const job of queue.splice(0)) cancelled(job.run);
			if (current !== null && !current.controller.signal.aborted) {
				current.controller.abort();
				cancelled(current.run);
			}
		},
	};
}

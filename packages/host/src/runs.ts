// Background planner runs: model output only ever becomes a pending PlanProposed (agents propose, K6).
// Runs are queued and execute one at a time, oldest first, so a single local model is never asked twice at once.
import type { ProposalId } from "@dawnskill/core";
import {
	type ChatProvider,
	PlannerError,
	type PlannerSource,
	type PlannerStage,
	type PlannerStreamEvent,
	planGoal,
} from "@dawnskill/agents";
import type { Store } from "./db/store.ts";
import { fetchSources } from "./sources.ts";

type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** Live view of the run's page reads and model calls; `tokens` counts streamed chunks (≈ tokens). */
export interface RunProgress {
	/** `fetch` while a source page is read, before the first model request. */
	readonly stage: PlannerStage | "fetch";
	/** Model requests started in this run (stages, repairs and dedupe checks). */
	readonly requests: number;
	/** Tail of the current request's thinking, at most 4000 chars. */
	readonly reasoning: string;
	/** Tail of the current request's answer text, at most 2000 chars; while fetching, the URL being read. */
	readonly output: string;
	/** Chunks streamed in the current request (≈ tokens). */
	readonly tokens: number;
	/** Chunks streamed over the whole run. */
	readonly totalTokens: number;
	/** (tokens − 1) / seconds between the current request's first and last chunk; null below 2 chunks or zero elapsed time. */
	readonly tokensPerSecond: number | null;
}

export interface PlanRun {
	readonly id: string;
	readonly goal: string;
	/** Pages read before planning: the request's list, then links found in the goal and context. */
	readonly sources: readonly string[];
	/** The planner may cover a provided curriculum in full: no task or minute cap. */
	readonly uncapped: boolean;
	readonly status: RunStatus;
	/** Model attempts (first answer plus repairs); 0 when no answer arrived (unreadable page, provider failure). */
	readonly attempts: number;
	/** Why the run failed; a page that could not be read fails it with `could not read <url>: <reason>`. */
	readonly error: string | null;
	/** Validation errors of the last attempt when the planner gave up. */
	readonly errors: readonly string[];
	readonly proposalId: ProposalId | null;
	readonly queuedAt: string;
	/** Null while the run waits behind earlier runs. */
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
	/** Null until the first page read or model request; the finished run keeps its last state. */
	readonly progress: RunProgress | null;
}

interface PlanInput {
	readonly goal: string;
	readonly context: string;
	readonly sources: readonly string[];
	readonly uncapped: boolean;
	readonly supersedes: ProposalId | null;
}

/** Reads source pages in order; rejects with a `SourceError` on the first unreadable page, or when `signal` aborts. */
export type SourceLoader = (urls: readonly string[], signal: AbortSignal) => Promise<readonly PlannerSource[]>;

interface PlanRunsOptions {
	/** Monotonic milliseconds for the token rate and the progress throttle. */
	readonly now?: () => number;
	/** Default: `fetchSources` over the network; tests pass a fake. */
	readonly loadSources?: SourceLoader;
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
	 * run's page read or model request is aborted; the next queued run starts once that has unwound.
	 */
	cancel(id: string): CancelResult;
	/** Cancels every queued and running run (shutdown). */
	cancelAll(): void;
	/**
	 * Called before each source page is read, on every new model request and at most every 250 ms while chunks
	 * stream; never on status changes.
	 */
	subscribeProgress(listener: (id: string, progress: RunProgress) => void): () => void;
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
/** Minimum gap between progress publications of one run while chunks stream. */
const PROGRESS_MS = 250;
const REASONING_TAIL = 4000;
const OUTPUT_TAIL = 2000;

export function createPlanRuns(
	store: Store,
	clock: () => string,
	{
		now = () => performance.now(),
		loadSources = (urls, signal) => fetchSources(urls, { signal }),
	}: PlanRunsOptions = {},
): PlanRuns {
	let runs: readonly PlanRun[] = [];
	let counter = 0;
	const queue: Job[] = [];
	/** The running run and its controller; null between runs. Stays set while a cancelled run unwinds. */
	let current: { readonly run: PlanRun; readonly controller: AbortController } | null = null;
	/** The loop draining `queue`; null when nothing is queued or running. */
	let worker: Promise<void> | null = null;
	const listeners = new Set<(run: PlanRun) => void>();
	const progressListeners = new Set<(id: string, progress: RunProgress) => void>();

	function notify<A extends unknown[]>(targets: ReadonlySet<(...args: A) => void>, ...args: A): void {
		for (const listener of targets) {
			try {
				listener(...args);
			} catch (error) {
				console.error("plan run listener failed", error);
			}
		}
	}

	function publish(run: PlanRun): void {
		runs = runs.some((r) => r.id === run.id)
			? runs.map((r) => (r.id === run.id ? run : r))
			: [run, ...runs].slice(0, KEEP);
		notify(listeners, run);
	}

	function publishProgress(id: string, progress: RunProgress): void {
		runs = runs.map((r) => (r.id === id ? { ...r, progress } : r));
		notify(progressListeners, id, progress);
	}

	/** Folds page reads and the planner's stream events into the run's progress; ignored after `settle()` or a cancel. */
	function track(id: string, signal: AbortSignal) {
		let progress: RunProgress | null = null;
		let first = 0;
		let lastPublished = Number.NEGATIVE_INFINITY;
		let settled = false;
		const send = (at: number): void => {
			if (progress === null) return;
			lastPublished = at;
			publishProgress(id, progress);
		};
		return {
			progress: () => progress,
			settle: () => {
				settled = true;
			},
			fetching: (url: string): void => {
				if (settled || signal.aborted) return;
				progress = {
					stage: "fetch",
					requests: 0,
					reasoning: "",
					output: url,
					tokens: 0,
					totalTokens: 0,
					tokensPerSecond: null,
				};
				send(now());
			},
			onStream: (event: PlannerStreamEvent): void => {
				if (settled || signal.aborted) return;
				if (event.type === "request") {
					progress = {
						stage: event.stage,
						requests: (progress?.requests ?? 0) + 1,
						reasoning: "",
						output: "",
						tokens: 0,
						totalTokens: progress?.totalTokens ?? 0,
						tokensPerSecond: null,
					};
					send(now());
					return;
				}
				if (progress === null) return;
				const at = now();
				if (progress.tokens === 0) first = at;
				const tokens = progress.tokens + 1;
				progress = {
					...progress,
					reasoning: (progress.reasoning + event.reasoning).slice(-REASONING_TAIL),
					output: (progress.output + event.content).slice(-OUTPUT_TAIL),
					tokens,
					totalTokens: progress.totalTokens + 1,
					tokensPerSecond: tokens < 2 || at === first ? null : ((tokens - 1) * 1000) / (at - first),
				};
				// The first chunk of a request shows at once; later ones at most every PROGRESS_MS.
				if (tokens === 1 || at - lastPublished >= PROGRESS_MS) send(at);
			},
		};
	}

	async function execute(
		run: PlanRun,
		input: PlanInput,
		provider: ChatProvider,
		signal: AbortSignal,
	): Promise<PlanRun> {
		const tracker = track(run.id, signal);
		let finished: PlanRun;
		try {
			// One page per call, so progress names the page being read.
			const sources: PlannerSource[] = [];
			for (const url of input.sources) {
				tracker.fetching(url);
				sources.push(...(await loadSources([url], signal)));
				// A loader may finish despite the abort; a cancelled run reads no further and never reaches the model.
				signal.throwIfAborted();
			}
			const result = await planGoal(
				provider,
				store.state,
				{ goal: input.goal, context: input.context, sources, uncapped: input.uncapped },
				{ signal, onStream: tracker.onStream },
			);
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
		tracker.settle();
		return { ...finished, progress: tracker.progress() };
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
		// The listed record carries the latest progress; `run` is the snapshot taken when it was queued or started.
		const latest = runs.find((r) => r.id === run.id) ?? run;
		const final: PlanRun = { ...latest, status: "cancelled", finishedAt: clock() };
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
				progress: null,
				sources: input.sources,
				uncapped: input.uncapped,
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
		subscribeProgress(listener) {
			progressListeners.add(listener);
			return () => {
				progressListeners.delete(listener);
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

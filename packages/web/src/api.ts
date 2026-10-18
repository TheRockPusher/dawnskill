import type { EventBody, IllegalCode, View } from "@dawnskill/core";
import { useEffect, useState } from "preact/hooks";

/** Mirrors the host's live planner progress (SSE `progress`, and the latest copy on each run). */
export interface RunProgress {
	/** "fetch" while the source pages are read, before the first model request. */
	readonly stage: "fetch" | "extract" | "tasks" | "skills" | "dedupe";
	/** Model requests started in this run (stages, repairs and dedupe checks). */
	readonly requests: number;
	/** Tail of the current request's thinking. */
	readonly reasoning: string;
	/** Tail of the current request's answer text. */
	readonly output: string;
	/** Chunks streamed in the current request (≈ tokens). */
	readonly tokens: number;
	/** Chunks streamed over the whole run. */
	readonly totalTokens: number;
	/** Streaming rate of the current request; null below 2 chunks. */
	readonly tokensPerSecond: number | null;
}

/** Mirrors the host's planner run record (GET /api/plan/runs, SSE `run`). */
export interface PlanRun {
	readonly id: string;
	readonly goal: string;
	/** Pages the run reads before planning (the request's `sources` plus URLs found in goal and context). */
	readonly sources: readonly string[];
	/** True when the user asked for the whole curriculum: no task or minute cap. */
	readonly uncapped: boolean;
	readonly status: "queued" | "running" | "done" | "failed" | "cancelled";
	readonly attempts: number;
	readonly error: string | null;
	readonly errors: readonly string[];
	readonly proposalId: string | null;
	readonly queuedAt: string;
	/** Null while the run waits behind earlier runs. */
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
	/** Null until the first model request; kept on the finished run. */
	readonly progress: RunProgress | null;
}

/** Mirrors the host's `GET /api/config` → `llm`; the API key never leaves the host. */
export interface LlmStatus {
	readonly configured: boolean;
	/** `app`: saved in Settings; `env`: DAWNSKILL_LLM_* variables on the host. */
	readonly source: "app" | "env" | null;
	readonly model: string | null;
	/** Set only for settings saved in the app. */
	readonly baseUrl: string | null;
	readonly hasApiKey: boolean;
	/** Effective `max_tokens` cap and request timeout (ms): saved in the app, else the host's environment or default. */
	readonly maxTokens: number;
	readonly timeoutMs: number;
}

interface AppConfig {
	readonly version: string;
	readonly llm: LlmStatus;
}

export type EventResult =
	| { readonly ok: true; readonly seq: number }
	| { readonly ok: false; readonly code: IllegalCode | "bad-request" | "network"; readonly message: string };

interface Snapshot {
	readonly view: View | null;
	readonly runs: readonly PlanRun[];
	readonly config: AppConfig | null;
	readonly error: string | null;
}

let snapshot: Snapshot = { view: null, runs: [], config: null, error: null };
const listeners = new Set<() => void>();
let etag: string | null = null;
let started = false;

function publish(patch: Partial<Snapshot>): void {
	snapshot = { ...snapshot, ...patch };
	for (const listener of listeners) listener();
}

async function loadView(): Promise<void> {
	try {
		const response = await fetch("/api/view", { headers: etag ? { "If-None-Match": etag } : {} });
		if (response.status === 304) return;
		if (!response.ok) throw new Error(`GET /api/view ${response.status}`);
		etag = response.headers.get("ETag");
		publish({ view: (await response.json()) as View, error: null });
	} catch (error) {
		publish({ error: error instanceof Error ? error.message : String(error) });
	}
}

async function loadRuns(): Promise<void> {
	const response = await fetch("/api/plan/runs");
	if (response.ok) publish({ runs: (await response.json()) as PlanRun[] });
}

async function loadConfig(): Promise<void> {
	const response = await fetch("/api/config");
	if (response.ok) publish({ config: (await response.json()) as AppConfig });
}

function start(): void {
	if (started) return;
	started = true;
	void loadView();
	void loadRuns();
	void loadConfig();
	const stream = new EventSource("/api/stream");
	stream.addEventListener("change", () => void loadView());
	stream.addEventListener("run", () => void Promise.all([loadRuns(), loadView()]));
	// Progress patches its run in place; refetching on every chunk would flood the host.
	stream.addEventListener("progress", (event) => {
		let data: { readonly id?: unknown; readonly progress?: RunProgress };
		try {
			data = JSON.parse(event.data as string) as typeof data;
		} catch {
			return;
		}
		const { id, progress } = data;
		if (!progress || !snapshot.runs.some((r) => r.id === id)) return;
		publish({ runs: snapshot.runs.map((r) => (r.id === id ? { ...r, progress } : r)) });
	});
	// Age and review due dates advance with time even without events.
	setInterval(() => void loadView(), 60_000);
}

/** Live application state: view model, planner runs and config, refreshed over SSE. */
export function useApp(): Snapshot {
	const [, rerender] = useState(0);
	useEffect(() => {
		start();
		const listener = () => rerender((n) => n + 1);
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, []);
	return snapshot;
}

/** Union of the JSON bodies the host returns from write endpoints. */
interface ApiBody {
	readonly seq?: number;
	readonly runId?: string;
	readonly code?: string;
	readonly message?: string;
	readonly error?: string;
}

/** Send a user event to the kernel. Illegal events come back with the kernel's message. */
export async function sendEvent(body: EventBody): Promise<EventResult> {
	try {
		const response = await fetch("/api/events", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const json = (await response.json()) as ApiBody;
		if (response.ok) {
			await loadView();
			return { ok: true, seq: json.seq ?? 0 };
		}
		if (response.status === 409) {
			return { ok: false, code: (json.code ?? "invalid") as IllegalCode, message: json.message ?? "" };
		}
		return { ok: false, code: "bad-request", message: json.error ?? response.statusText };
	} catch (error) {
		return { ok: false, code: "network", message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Ask the planner agent for a draft; resolves once the run is accepted (202), not when it finishes.
 * `sources` are page URLs the host reads first; `uncapped` plans a provided curriculum in full.
 */
export async function startPlan(
	goal: string,
	context: string,
	supersedes: string | null,
	options: { readonly sources?: readonly string[]; readonly uncapped?: boolean } = {},
): Promise<{ ok: true; runId: string } | { ok: false; message: string }> {
	const body: Record<string, unknown> = { goal, context };
	if (supersedes) body.supersedes = supersedes;
	if (options.sources !== undefined && options.sources.length > 0) body.sources = options.sources;
	if (options.uncapped) body.uncapped = true;
	const response = await fetch("/api/plan", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = (await response.json()) as ApiBody;
	if (response.status === 202) {
		await loadRuns();
		return { ok: true, runId: json.runId ?? "" };
	}
	return { ok: false, message: json.error ?? json.message ?? response.statusText };
}

/** Cancel a queued or running planner run; a running run's model request is aborted and it never proposes. */
export async function cancelPlan(runId: string): Promise<{ ok: true } | { ok: false; message: string }> {
	const response = await fetch(`/api/plan/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
	const json = (await response.json()) as ApiBody;
	if (response.ok) {
		await loadRuns();
		return { ok: true };
	}
	return { ok: false, message: json.error ?? json.message ?? response.statusText };
}

/**
 * Save the planner's model connection on the host. `apiKey` undefined keeps the saved key (only
 * allowed while the base URL is unchanged); null removes it. `maxTokens` and `timeoutMs` override the
 * host's DAWNSKILL_LLM_MAX_TOKENS and DAWNSKILL_LLM_TIMEOUT_MS.
 */
export function saveLlmSettings(settings: {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey?: string | null;
	readonly maxTokens: number;
	readonly timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; message: string }> {
	return updateLlm("PUT", JSON.stringify(settings));
}

/** Delete the settings saved in the app; the host's environment variables apply again. */
export function removeLlmSettings(): Promise<{ ok: true } | { ok: false; message: string }> {
	return updateLlm("DELETE", undefined);
}

async function updateLlm(
	method: "PUT" | "DELETE",
	body: string | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
	try {
		const response = await fetch("/api/settings/llm", {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
		});
		const json = (await response.json()) as ApiBody & { readonly llm?: LlmStatus };
		if (!response.ok || json.llm === undefined) return { ok: false, message: json.error ?? response.statusText };
		if (snapshot.config !== null) publish({ config: { ...snapshot.config, llm: json.llm } });
		return { ok: true };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

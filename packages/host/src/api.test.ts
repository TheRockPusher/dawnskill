import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatProvider, LlmConfig, ReplyDelta } from "@dawnskill/agents";
import { extractResponse, planResponses, scriptedProvider } from "@dawnskill/agents/testing";
import { AGENT_EVENTS, type EventType, type PlanDraft, type View } from "@dawnskill/core";
import { afterEach, describe, expect, it } from "vitest";
import { type Store, openStore } from "./db/store.ts";
import { createLlm } from "./llm.ts";
import { MAX_PENDING, type PlanRun, type RunProgress, type SourceLoader, createPlanRuns } from "./runs.ts";
import { type App, createApp } from "./server.ts";
import { fetchSources } from "./sources.ts";

const NOW = "2026-10-16T09:00:00.000Z";

const draft = (goal: string): PlanDraft => ({
	goal,
	summary: "Learn ownership first, then build the CLI.",
	skills: [
		{
			key: "rust-ownership",
			name: "Rust ownership and borrowing",
			description: "Moves, borrows and lifetimes.",
			concepts: ["move semantics", "borrow checker"],
			prerequisites: [],
			resources: [
				{ title: "The Rust Book, ch. 4", url: "https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html" },
			],
			retrievalPrompts: ["When does a value move?", "What does the borrow checker forbid?"],
			practiceMinutes: 120,
		},
	],
	tasks: [
		{
			ref: "t1",
			title: "Build the todo CLI",
			notes: "",
			doneWhen: "cargo run lists todos",
			category: "coding",
			estimateMinutes: 240,
			importance: 4,
			urgency: 3,
			requires: [{ skill: "rust-ownership", level: 2 }],
			after: [],
		},
		{
			ref: "t2",
			title: "Add persistence",
			notes: "",
			doneWhen: "todos survive a restart",
			category: "coding",
			estimateMinutes: 120,
			importance: 3,
			urgency: 3,
			requires: [],
			after: ["t1"],
		},
		{
			ref: "t3",
			title: "Publish the release",
			notes: "",
			doneWhen: "binary attached to a GitHub release",
			category: "release",
			estimateMinutes: 60,
			importance: 3,
			urgency: 2,
			requires: [],
			after: ["t2"],
		},
	],
});

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dawnskill-api-"));
	dirs.push(dir);
	return dir;
}

const LIMITS = { timeoutMs: 1000, maxTokens: 4096 };
/** What DAWNSKILL_LLM_* would configure; `env: false` starts without it. */
const ENV: LlmConfig = { baseUrl: "http://127.0.0.1:8080/v1", apiKey: null, model: "scripted", ...LIMITS };

/**
 * `model`: scripted replies, a hand-written provider, or null for no provider. Every configured model
 * (environment or saved settings) connects to it. `dir` holds the saved model settings. `loadSources`
 * reads plan source pages; by default any page read fails, so no test reaches the network.
 */
function setup(
	model: ReadonlyArray<string> | ChatProvider | null,
	clock: () => string = () => NOW,
	{
		env = model !== null,
		dir = tempDir(),
		loadSources = async (urls) => {
			throw new Error(`setup: no pages for ${urls.join(", ")}`);
		},
	}: { readonly env?: boolean; readonly dir?: string; readonly loadSources?: SourceLoader } = {},
) {
	const store = openStore(":memory:");
	stores.push(store);
	const custom = model === null || "completeJson" in model;
	const provider = model === null || "completeJson" in model ? null : scriptedProvider(model);
	const planner = custom ? model : provider;
	/** Configs the app connected to, oldest first: one per plan run. */
	const connected: LlmConfig[] = [];
	const llm = createLlm({
		file: join(dir, "llm-settings.json"),
		env: env ? ENV : null,
		limits: LIMITS,
		connect: (config) => {
			if (planner === null) throw new Error("setup(null) has no provider to connect");
			connected.push(config);
			return planner;
		},
	});
	const app: App = createApp({
		store,
		llm,
		clock,
		webDir: "/nonexistent",
		version: "1.2.3",
		loadSources,
	});
	const request = (method: string, path: string, body?: unknown): Promise<Response> =>
		Promise.resolve(
			app.app.request(path, {
				method,
				...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
			}),
		);
	const json = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
		const response = await request(method, path, body);
		return { status: response.status, body: (await response.json()) as T };
	};
	/** Starts a plan run and waits until it settles. */
	const plan = async (body: object): Promise<PlanRun> => {
		const started = await json<{ runId: string }>("POST", "/api/plan", body);
		expect(started.status).toBe(202);
		await app.runs.idle();
		const runs = await json<PlanRun[]>("GET", "/api/plan/runs");
		const run = runs.body.find((r) => r.id === started.body.runId);
		if (run === undefined) throw new Error(`run ${started.body.runId} not listed`);
		return run;
	};
	const view = async (): Promise<View> => (await json<View>("GET", "/api/view")).body;
	/** The config the next plan run would connect with. */
	const nextConfig = (): LlmConfig | undefined => (llm.provider() === null ? undefined : connected.at(-1));
	return { store, provider, app, request, json, plan, view, connected, nextConfig };
}

/** Reads `GET /api/stream`; `until` resolves once the text received so far contains `text`. */
async function openStream(app: App) {
	const response = await app.app.request("/api/stream");
	expect(response.headers.get("Content-Type")).toBe("text/event-stream");
	const reader = response.body?.getReader();
	if (reader === undefined) throw new Error("no stream body");
	const decoder = new TextDecoder();
	let buffer = "";
	return {
		received: () => buffer,
		async until(text: string): Promise<void> {
			while (!buffer.includes(text)) {
				const { value, done } = await reader.read();
				if (done) throw new Error(`stream ended before ${text}`);
				buffer += decoder.decode(value, { stream: true });
			}
		},
		cancel: () => reader.cancel(),
	};
}

/** Replays `replies`, first streaming the chunks `chunks(call)` yields for that call (0-based) to `onDelta`. */
function streamingProvider(
	replies: readonly string[],
	chunks: (call: number, onDelta: (delta: ReplyDelta) => void) => void,
): ChatProvider {
	let call = 0;
	return {
		model: "streaming",
		completeJson: async (_request, _signal, onDelta) => {
			const index = call++;
			if (onDelta !== undefined) chunks(index, onDelta);
			return replies[index] ?? "";
		},
	};
}

describe("goal intake", () => {
	it("plans, waits for approval with self-ratings, then puts learning before the work", async () => {
		const { provider, json, plan, view } = setup(planResponses(draft("Ship a Rust CLI")));

		const run = await plan({ goal: "Ship a Rust CLI", context: "I know Python." });
		expect(run).toMatchObject({ status: "done", attempts: 2, error: null, errors: [], finishedAt: NOW });
		expect(run.proposalId).not.toBeNull();
		provider?.assertDone();

		const pending = await view();
		expect(pending.focus.drafts).toEqual([run.proposalId]);
		expect(pending.tasks).toEqual([]);

		const approved = await json<{ seq: number }>("POST", "/api/events", {
			type: "PlanApproved",
			proposalId: run.proposalId,
			ratings: { "rust-ownership": 0 },
		});
		expect(approved.status).toBe(200);
		expect(approved.body.seq).toBe(2);

		const after = await view();
		expect(after.focus.drafts).toEqual([]);
		const work = after.tasks.filter((t) => t.task.learning === null);
		expect(work.map((t) => t.task.title).sort()).toEqual([
			"Add persistence",
			"Build the todo CLI",
			"Publish the release",
		]);
		expect(work.every((t) => !t.ready && t.blockedBy.length > 0)).toBe(true);
		expect(after.focus.next).toEqual([]);
		expect(after.focus.learning.length).toBeGreaterThan(0);
		for (const id of after.focus.learning) {
			const learning = after.tasks.find((t) => t.task.id === id);
			expect(learning?.task.learning?.skill).toBe("rust-ownership");
			expect(learning?.ready).toBe(true);
		}
	});
});

describe("approval required", () => {
	it("agent output only ever becomes a pending proposal", async () => {
		const { store, json, plan } = setup(planResponses(draft("Ship a Rust CLI")));

		// The plan route accepts no approval fields.
		const sneaky = await json<{ error: string }>("POST", "/api/plan", { goal: "x", approve: true });
		expect(sneaky.status).toBe(400);
		expect(sneaky.body.error).toContain("approve");

		const run = await plan({ goal: "Ship a Rust CLI" });
		expect(run.status).toBe("done");
		const proposal = run.proposalId === null ? undefined : store.state.proposals[run.proposalId];
		expect(proposal).toMatchObject({ status: "pending", actor: "agent" });
		expect(Object.keys(store.state.tasks)).toEqual([]);
		expect(Object.keys(store.state.goals)).toEqual([]);
		const agentTypes = store.events().flatMap((e) => (e.actor === "agent" ? [e.body.type] : []));
		expect(agentTypes).toEqual(["PlanProposed"]);
		expect(agentTypes.every((type) => (AGENT_EVENTS as readonly EventType[]).includes(type))).toBe(true);
	});

	it("rejects approving a superseded proposal", async () => {
		const { json } = setup(null);
		const a = await json("POST", "/api/events", { type: "PlanProposed", draft: draft("A"), supersedes: null });
		expect(a.status).toBe(200);
		const b = await json("POST", "/api/events", { type: "PlanProposed", draft: draft("B"), supersedes: "P1" });
		expect(b.status).toBe(200);
		const approve = await json<{ code: string; message: string }>("POST", "/api/events", {
			type: "PlanApproved",
			proposalId: "P1",
			ratings: { "rust-ownership": 1 },
		});
		expect(approve.status).toBe(409);
		expect(approve.body.message).toContain("superseded");
	});
});

describe("plan superseded", () => {
	it("only the replacement can be approved", async () => {
		const { json, plan, view } = setup([...planResponses(draft("Plan A")), ...planResponses(draft("Plan B"))]);
		const a = await plan({ goal: "Plan A" });
		expect(a.status).toBe("done");
		const b = await plan({ goal: "Plan B", supersedes: a.proposalId });
		expect(b.status).toBe("done");
		expect((await view()).focus.drafts).toEqual([b.proposalId]);

		const ratings = { "rust-ownership": 1 };
		const approveA = await json("POST", "/api/events", { type: "PlanApproved", proposalId: a.proposalId, ratings });
		expect(approveA.status).toBe(409);
		const approveB = await json("POST", "/api/events", { type: "PlanApproved", proposalId: b.proposalId, ratings });
		expect(approveB.status).toBe(200);
	});

	it("refuses to start a run that supersedes a non-pending proposal", async () => {
		const { json } = setup([]);
		const response = await json<{ code: string }>("POST", "/api/plan", { goal: "Plan B", supersedes: "P9" });
		expect(response).toEqual({ status: 409, body: expect.objectContaining({ code: "invalid" }) });
	});
});

describe("plan queue", () => {
	/**
	 * Holds every request until `release()`, then answers from the script of the plan being drafted (runs are
	 * sequential, so a request belongs to the goal of the last `plan_tasks` request). Rejects on abort unless
	 * `ignoreAbort`. Records each plan's goal and the peak number of concurrent requests.
	 */
	function gatedProvider(
		script: Readonly<Record<string, readonly string[]>>,
		{ ignoreAbort = false }: { readonly ignoreAbort?: boolean } = {},
	) {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const goals: string[] = [];
		const used: Record<string, number> = {};
		let inFlight = 0;
		let peak = 0;
		const provider: ChatProvider = {
			model: "gated",
			completeJson: async (request, signal) => {
				if (request.schemaName === "plan_tasks") {
					goals.push(Object.keys(script).find((goal) => request.user.includes(goal)) ?? "unscripted");
				}
				const goal = goals.at(-1) ?? "unscripted";
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				try {
					await new Promise<void>((resolve, reject) => {
						void gate.then(resolve);
						if (!ignoreAbort) signal?.addEventListener("abort", () => reject(new Error("aborted")));
					});
				} finally {
					inFlight -= 1;
				}
				const n = used[goal] ?? 0;
				used[goal] = n + 1;
				return script[goal]?.[n] ?? "";
			},
		};
		return { provider, release, goals, peak: () => peak };
	}

	const goalsOf = (store: Store): (string | false)[] =>
		Object.values(store.state.proposals).map((p) => p.payload.kind === "plan" && p.payload.draft.goal);

	it("queues a run submitted while another is in progress and runs them in order, one at a time", async () => {
		const gated = gatedProvider({ "Plan A": planResponses(draft("Plan A")), "Plan B": planResponses(draft("Plan B")) });
		const { app, json, store } = setup(gated.provider);
		const a = await json<{ runId: string }>("POST", "/api/plan", { goal: "Plan A" });
		const b = await json<{ runId: string }>("POST", "/api/plan", { goal: "Plan B" });
		expect([a.status, b.status]).toEqual([202, 202]);
		const waiting = await json<PlanRun[]>("GET", "/api/plan/runs");
		expect(waiting.body.map((run) => [run.id, run.status, run.startedAt])).toEqual([
			[b.body.runId, "queued", null],
			[a.body.runId, "running", NOW],
		]);
		expect(gated.goals).toEqual(["Plan A"]);
		gated.release();
		await app.runs.idle();
		expect(gated.goals).toEqual(["Plan A", "Plan B"]);
		expect(gated.peak()).toBe(1);
		const done = app.runs.list();
		expect(done.map((run) => run.status)).toEqual(["done", "done"]);
		const proposals = done.map((run) => (run.proposalId === null ? undefined : store.state.proposals[run.proposalId]));
		expect(proposals.map((p) => p?.payload.kind === "plan" && p.payload.draft.goal)).toEqual(["Plan B", "Plan A"]);
	});

	it("refuses a run once the queue is full", async () => {
		const gated = gatedProvider({});
		const { app, json } = setup(gated.provider);
		for (let i = 0; i < MAX_PENDING; i++) {
			expect((await json("POST", "/api/plan", { goal: `Plan ${i}` })).status).toBe(202);
		}
		const full = await json<{ code: string }>("POST", "/api/plan", { goal: "One too many" });
		expect(full).toEqual({ status: 409, body: expect.objectContaining({ code: "busy" }) });
		app.runs.cancelAll();
		await app.runs.idle();
	});

	it("cancelling a queued run drops it without sending it to the model", async () => {
		const gated = gatedProvider({ "Plan A": planResponses(draft("Plan A")), "Plan B": planResponses(draft("Plan B")) });
		const { app, json, store } = setup(gated.provider);
		await json("POST", "/api/plan", { goal: "Plan A" });
		const b = await json<{ runId: string }>("POST", "/api/plan", { goal: "Plan B" });
		const cancel = await json<PlanRun>("POST", `/api/plan/runs/${b.body.runId}/cancel`);
		expect(cancel).toEqual({
			status: 200,
			body: expect.objectContaining({ id: b.body.runId, status: "cancelled", startedAt: null, finishedAt: NOW }),
		});
		gated.release();
		await app.runs.idle();
		expect(gated.goals).toEqual(["Plan A"]);
		expect(app.runs.list().map((run) => [run.goal, run.status])).toEqual([
			["Plan B", "cancelled"],
			["Plan A", "done"],
		]);
		expect(goalsOf(store)).toEqual(["Plan A"]);
	});

	it("cancelling the running run never proposes, even if the model still answers, and the next run starts", async () => {
		const gated = gatedProvider(
			{ "Plan A": planResponses(draft("Plan A")), "Plan B": planResponses(draft("Plan B")) },
			{ ignoreAbort: true },
		);
		const { app, json, store } = setup(gated.provider);
		const a = await json<{ runId: string }>("POST", "/api/plan", { goal: "Plan A" });
		await json("POST", "/api/plan", { goal: "Plan B" });
		const cancel = await json<PlanRun>("POST", `/api/plan/runs/${a.body.runId}/cancel`);
		expect(cancel.body).toMatchObject({ status: "cancelled", startedAt: NOW, finishedAt: NOW });
		gated.release();
		await app.runs.idle();
		expect(gated.goals).toEqual(["Plan A", "Plan B"]);
		expect(gated.peak()).toBe(1);
		expect(app.runs.list().map((run) => [run.goal, run.status])).toEqual([
			["Plan B", "done"],
			["Plan A", "cancelled"],
		]);
		expect(goalsOf(store)).toEqual(["Plan B"]);
	});

	it("cancel answers 409 for a finished run and 404 for an unknown one", async () => {
		const { json, plan } = setup(planResponses(draft("Plan A")));
		const run = await plan({ goal: "Plan A" });
		const finished = await json<{ code: string }>("POST", `/api/plan/runs/${run.id}/cancel`);
		expect(finished).toEqual({ status: 409, body: expect.objectContaining({ code: "finished" }) });
		expect((await json("POST", "/api/plan/runs/R99/cancel")).status).toBe(404);
	});

	it("shutdown cancels queued runs without sending them to the model and aborts the running one", async () => {
		const gated = gatedProvider({});
		const { app, json } = setup(gated.provider);
		await json("POST", "/api/plan", { goal: "Plan A" });
		await json("POST", "/api/plan", { goal: "Plan B" });
		app.runs.cancelAll();
		await app.runs.idle();
		expect(gated.goals).toEqual(["unscripted"]);
		expect(app.runs.list().map((run) => [run.goal, run.status, run.startedAt])).toEqual([
			["Plan B", "cancelled", null],
			["Plan A", "cancelled", NOW],
		]);
	});
});

describe("events", () => {
	it("400 names the invalid field", async () => {
		const { json } = setup(null);
		const response = await json<{ error: string; details: string[] }>("POST", "/api/events", {
			type: "TaskCancelled",
			taskId: "T1",
			reason: 42,
		});
		expect(response.status).toBe(400);
		expect(response.body.error).toContain("/reason");
		expect(response.body.details.some((d) => d.startsWith("/reason"))).toBe(true);
	});

	it("400 on unknown fields, unknown types and malformed JSON", async () => {
		const { json, request } = setup(null);
		const extra = await json<{ details: string[] }>("POST", "/api/events", { type: "TaskStarted", taskId: "T1", x: 1 });
		expect(extra.status).toBe(400);
		expect(extra.body.details).toContain("/: unknown field(s) x");
		expect((await json("POST", "/api/events", { type: "TaskExploded" })).status).toBe(400);
		const malformed = await request("POST", "/api/events");
		expect(malformed.status).toBe(400);
	});

	it("409 carries the kernel message for an illegal transition", async () => {
		const { json } = setup(null);
		const created = await json<{ seq: number }>("POST", "/api/events", {
			type: "TaskCreated",
			task: {
				goalId: null,
				title: "Write notes",
				notes: "",
				doneWhen: "notes exist",
				category: "writing",
				estimateMinutes: 30,
				importance: 3,
				urgency: 3,
				requirements: [],
			},
		});
		expect(created).toEqual({ status: 200, body: { seq: 1 } });
		const taskId = (await json<View>("GET", "/api/view")).body.tasks[0]?.task.id;
		expect((await json("POST", "/api/events", { type: "TaskCancelled", taskId, reason: "dropped" })).status).toBe(200);
		const paused = await json<{ code: string; message: string }>("POST", "/api/events", { type: "TaskPaused", taskId });
		expect(paused.status).toBe(409);
		expect(paused.body.code).toBe("illegal-transition");
		expect(paused.body.message).toContain("TaskPaused");
	});
});

describe("planner failure", () => {
	it("marks the run failed with the validation errors and proposes nothing", async () => {
		const { store, provider, plan } = setup(["not json", "{}", JSON.stringify({ goal: "x" })]);
		const run = await plan({ goal: "Ship a Rust CLI" });
		expect(run).toMatchObject({ status: "failed", attempts: 3, proposalId: null, finishedAt: NOW });
		expect(run.error).not.toBeNull();
		expect(run.errors.length).toBeGreaterThan(0);
		expect(store.state.proposals).toEqual({});
		expect(store.events()).toEqual([]);
		provider?.assertDone();
	});
});

describe("source pages", () => {
	const SITE = "https://www.susanrigetti.com";
	const PHYSICS_HTML =
		"<html><head><title>Physics</title></head><body><h1>Physics</h1>" +
		"<ul><li>Classical Mechanics by John Taylor</li></ul></body></html>";

	/** The real `fetchSources` over a fake network: `pages` maps a URL to its HTML; any other URL answers 404. */
	function pageLoader(pages: Readonly<Record<string, string>>): SourceLoader {
		const fetch = async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const html = Object.hasOwn(pages, url) ? pages[url] : undefined;
			return html === undefined
				? new Response("missing", { status: 404 })
				: new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
		};
		return (urls, signal) => fetchSources(urls, { signal, fetch });
	}

	/** Records every page read and holds it until `release()`; it ignores aborts, so a cancelled read still finishes. */
	function gatedLoader() {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read: string[] = [];
		const load: SourceLoader = async (urls) => {
			read.push(...urls);
			await gate;
			return urls.map((url) => ({ url, title: "Physics", text: "- Classical Mechanics by John Taylor" }));
		};
		return { load, release, read };
	}

	it("reads a page linked in the context and gives its text to the planner", async () => {
		const replies = [
			extractResponse([{ title: "Classical Mechanics", creator: "John Taylor" }]),
			...planResponses(draft("Learn physics")),
		];
		const { provider, plan } = setup(replies, undefined, {
			loadSources: pageLoader({ [`${SITE}/physics`]: PHYSICS_HTML }),
		});
		const run = await plan({ goal: "Learn physics", context: `Work through ${SITE}/physics.` });
		expect(run).toMatchObject({ status: "done", sources: [`${SITE}/physics`], error: null });
		expect(provider?.calls[0]?.user).toContain("Classical Mechanics by John Taylor");
		provider?.assertDone();
	});

	it("reads listed pages first, then new links from the goal and context, and refuses more than 10", async () => {
		const gated = gatedLoader();
		const { app, json } = setup([], undefined, { loadSources: gated.load });
		const listed = Array.from({ length: 8 }, (_, i) => `${SITE}/page-${i}`);
		// Ten distinct pages: the context repeats a listed one.
		const accepted = await json("POST", "/api/plan", {
			goal: "Learn math and philosophy",
			context: `Also ${SITE}/math, ${SITE}/page-3 and ${SITE}/philosophy.`,
			sources: listed,
		});
		expect(accepted.status).toBe(202);
		const over = await json<{ error: string; details: string[] }>("POST", "/api/plan", {
			goal: `Learn physics from ${SITE}/physics`,
			context: `Then ${SITE}/math and ${SITE}/philosophy.`,
			sources: listed,
		});
		expect(over.status).toBe(400);
		expect(over.body.error).toContain("/sources");
		const runs = await json<PlanRun[]>("GET", "/api/plan/runs");
		expect(runs.body.map((run) => run.sources)).toEqual([[...listed, `${SITE}/math`, `${SITE}/philosophy`]]);
		app.runs.cancelAll();
		gated.release();
		await app.runs.idle();
	});

	it("fails the run, naming the page, when a page cannot be read, and never asks the model", async () => {
		const { store, provider, plan } = setup([], undefined, {
			loadSources: pageLoader({ [`${SITE}/physics`]: PHYSICS_HTML }),
		});
		const run = await plan({ goal: "Learn math and physics", sources: [`${SITE}/physics`, `${SITE}/math`] });
		expect(run).toMatchObject({ status: "failed", attempts: 0, errors: [], proposalId: null, finishedAt: NOW });
		expect(run.error).toContain(`could not read ${SITE}/math`);
		expect(provider?.calls).toEqual([]);
		expect(store.events()).toEqual([]);
	});

	it("cancelling a run while it reads a page never asks the model, and the next run starts", async () => {
		const gated = gatedLoader();
		const { app, json, provider, store } = setup(planResponses(draft("Plan B")), undefined, {
			loadSources: gated.load,
		});
		const a = await json<{ runId: string }>("POST", "/api/plan", { goal: "Plan A", context: `See ${SITE}/physics` });
		await json("POST", "/api/plan", { goal: "Plan B" });
		const cancel = await json<PlanRun>("POST", `/api/plan/runs/${a.body.runId}/cancel`);
		expect(cancel.body).toMatchObject({
			status: "cancelled",
			progress: { stage: "fetch", requests: 0, output: `${SITE}/physics`, totalTokens: 0 },
		});
		gated.release();
		await app.runs.idle();
		expect(gated.read).toEqual([`${SITE}/physics`]);
		expect(app.runs.list().map((run) => [run.goal, run.status])).toEqual([
			["Plan B", "done"],
			["Plan A", "cancelled"],
		]);
		const goals = Object.values(store.state.proposals).map((p) => p.payload.kind === "plan" && p.payload.draft.goal);
		expect(goals).toEqual(["Plan B"]);
		provider?.assertDone();
	});
});

describe("whole-curriculum plans", () => {
	it("plans past the usual task cap when uncapped", async () => {
		const books: PlanDraft = {
			...draft("Read the whole list"),
			tasks: Array.from({ length: 15 }, (_, i) => ({
				ref: `t${i + 1}`,
				title: `Read book ${i + 1} and solve its exercises`,
				notes: "",
				doneWhen: `every exercise of book ${i + 1} attempted`,
				category: "reading",
				estimateMinutes: 120,
				importance: 3,
				urgency: 2,
				requires: i === 0 ? [{ skill: "rust-ownership", level: 2 }] : [],
				after: [],
			})),
		};
		// Uncapped skills requests cover 8 tasks each: the only skill link (task 0) is in the first batch.
		const [tasksReply, skillsReply] = planResponses(books);
		const { store, provider, plan } = setup([tasksReply, skillsReply, JSON.stringify({ skills: [] })]);
		const run = await plan({ goal: "Read the whole list", uncapped: true });
		expect(run).toMatchObject({ status: "done", uncapped: true });
		const proposal = run.proposalId === null ? undefined : store.state.proposals[run.proposalId];
		const tasks = proposal?.payload.kind === "plan" ? proposal.payload.draft.tasks : [];
		expect(tasks).toHaveLength(15);
		provider?.assertDone();
	});

	it("accepts 150 study tasks that develop skills, and approval keeps develops without inserting learning", async () => {
		const { json, view } = setup(null);
		const books = Array.from({ length: 150 }, (_, i) => i + 1);
		const curriculum: PlanDraft = {
			goal: "Learn physics",
			summary: "Work through the curriculum in order.",
			skills: books.map((n) => ({
				key: `physics-${n}`,
				name: `Physics topic ${n}`,
				description: "",
				concepts: [`idea ${n}a`, `idea ${n}b`],
				prerequisites: [],
				resources: [],
				retrievalPrompts: [`Explain topic ${n}.`, `Apply topic ${n}.`],
				practiceMinutes: 60,
			})),
			tasks: books.map((n) => ({
				ref: `t${n}`,
				title: `Read Book ${n} and solve its exercises`,
				notes: "",
				doneWhen: `every exercise of Book ${n} attempted`,
				category: "reading",
				estimateMinutes: 600,
				importance: 3,
				urgency: 2,
				requires: [],
				develops: [{ skill: `physics-${n}`, level: 2 }],
				after: n === 1 ? [] : [`t${n - 1}`],
			})),
		};
		const proposed = await json("POST", "/api/events", { type: "PlanProposed", draft: curriculum, supersedes: null });
		expect(proposed.status).toBe(200);
		const ratings = Object.fromEntries(books.map((n) => [`physics-${n}`, 0]));
		expect((await json("POST", "/api/events", { type: "PlanApproved", proposalId: "P1", ratings })).status).toBe(200);
		const { tasks } = await view();
		expect(tasks).toHaveLength(150);
		const first = tasks.find((t) => t.task.title === "Read Book 1 and solve its exercises");
		expect(first).toMatchObject({
			ready: true,
			task: { learning: null, develops: [{ skill: "physics-1", level: 2 }] },
		});
	});
});

describe("view caching", () => {
	it("answers 304 for a matching ETag and changes it on the next event", async () => {
		const { app, json } = setup(null);
		const first = await app.app.request("/api/view");
		const etag = first.headers.get("ETag") ?? "";
		expect(etag).toMatch(/^"0-\d+"$/);
		const cached = await app.app.request("/api/view", { headers: { "If-None-Match": etag } });
		expect(cached.status).toBe(304);
		expect(cached.headers.get("ETag")).toBe(etag);
		const criteriaRank = ["urgency", "importance", "unblocks", "effort", "age"];
		expect((await json("POST", "/api/events", { type: "PreferencesSet", criteriaRank })).status).toBe(200);
		const changed = await app.app.request("/api/view", { headers: { "If-None-Match": etag } });
		expect(changed.status).toBe(200);
		expect(changed.headers.get("ETag")).toMatch(/^"1-\d+"$/);
	});

	it("recomputes an unchanged view once it is a minute old", async () => {
		let now = NOW;
		const { app } = setup(null, () => now);
		const etag = (await app.app.request("/api/view")).headers.get("ETag") ?? "";
		now = "2026-10-16T09:00:59.000Z";
		expect((await app.app.request("/api/view", { headers: { "If-None-Match": etag } })).status).toBe(304);
		now = "2026-10-16T09:01:00.000Z";
		const fresh = await app.app.request("/api/view", { headers: { "If-None-Match": etag } });
		expect(fresh.status).toBe(200);
		expect(((await fresh.json()) as View).now).toBe(now);
	});
});

describe("without a model", () => {
	it("503 on planning and reports the missing model", async () => {
		const { json } = setup(null);
		const response = await json<{ error: string }>("POST", "/api/plan", { goal: "Ship a Rust CLI" });
		expect(response.status).toBe(503);
		expect(response.body.error).toContain("DAWNSKILL_LLM_BASE_URL");
		expect((await json("GET", "/api/config")).body).toEqual({
			version: "1.2.3",
			llm: { configured: false, source: null, model: null, baseUrl: null, hasApiKey: false, ...LIMITS },
		});
		expect((await json("GET", "/api/plan/runs")).body).toEqual([]);
	});
});

describe("model settings", () => {
	const SETTINGS = { baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "sk-secret" };
	const APP_STATUS = {
		configured: true,
		source: "app",
		model: "gpt-x",
		baseUrl: SETTINGS.baseUrl,
		hasApiKey: true,
		...LIMITS,
	};
	const ENV_STATUS = { configured: true, source: "env", model: "scripted", baseUrl: null, hasApiKey: false, ...LIMITS };

	it("reports an environment model without its URL", async () => {
		const { json } = setup([]);
		expect((await json("GET", "/api/config")).body).toEqual({ version: "1.2.3", llm: ENV_STATUS });
	});

	it("enables planning without environment variables and never returns the key", async () => {
		const { json, plan, connected } = setup(planResponses(draft("Plan A")), undefined, { env: false });
		expect((await json("POST", "/api/plan", { goal: "Plan A" })).status).toBe(503);
		expect(await json("PUT", "/api/settings/llm", SETTINGS)).toEqual({ status: 200, body: { llm: APP_STATUS } });
		expect(JSON.stringify((await json("GET", "/api/config")).body)).not.toContain("sk-secret");
		expect((await plan({ goal: "Plan A" })).status).toBe("done");
		expect(connected).toEqual([{ ...SETTINGS, ...LIMITS }]);
	});

	it("persists across restarts and overrides the environment until removed", async () => {
		const dir = tempDir();
		await setup([], undefined, { dir }).json("PUT", "/api/settings/llm", SETTINGS);
		expect(statSync(join(dir, "llm-settings.json")).mode & 0o777).toBe(0o600);
		const restarted = setup([], undefined, { dir });
		expect((await restarted.json("GET", "/api/config")).body).toMatchObject({ llm: APP_STATUS });
		expect(restarted.nextConfig()).toEqual({ ...SETTINGS, ...LIMITS });
		expect((await restarted.json("DELETE", "/api/settings/llm")).body).toEqual({ llm: ENV_STATUS });
		expect((await setup([], undefined, { dir }).json("GET", "/api/config")).body).toMatchObject({
			llm: { source: "env" },
		});
	});

	it("keeps the saved key only for the URL it was entered for", async () => {
		const { json, nextConfig } = setup([], undefined, { env: false });
		await json("PUT", "/api/settings/llm", SETTINGS);
		const kept = await json("PUT", "/api/settings/llm", { baseUrl: SETTINGS.baseUrl, model: "gpt-y" });
		expect(kept.body).toEqual({ llm: { ...APP_STATUS, model: "gpt-y" } });
		const moved = await json<{ error: string }>("PUT", "/api/settings/llm", { baseUrl: "https://other.example/v1" });
		expect(moved.status).toBe(400);
		expect(moved.body.error).toContain("apiKey: required when baseUrl changes");
		expect(nextConfig()).toEqual({ ...SETTINGS, model: "gpt-y", ...LIMITS });
		const cleared = await json("PUT", "/api/settings/llm", { baseUrl: SETTINGS.baseUrl, apiKey: " " });
		expect(cleared.body).toEqual({ llm: { ...APP_STATUS, model: "default", hasApiKey: false } });
	});

	it("rejects a base URL that is not http(s) and keeps the current settings", async () => {
		const { json } = setup([], undefined, { env: false });
		for (const baseUrl of ["ftp://example.com/v1", "localhost:8080/v1", ""]) {
			const response = await json<{ error: string }>("PUT", "/api/settings/llm", { baseUrl });
			expect(response.status).toBe(400);
			expect(response.body.error).toContain("invalid model settings");
		}
		expect((await json("GET", "/api/config")).body).toMatchObject({ llm: { configured: false } });
	});

	it("saved reply budget and timeout override the environment's and drive the next run", async () => {
		const dir = tempDir();
		const { json, plan, connected } = setup(planResponses(draft("Plan A")), undefined, { dir });
		const limits = { maxTokens: 32_768, timeoutMs: 300_000 };
		const saved = await json("PUT", "/api/settings/llm", { ...SETTINGS, ...limits });
		expect(saved).toEqual({ status: 200, body: { llm: { ...APP_STATUS, ...limits } } });
		expect((await json("GET", "/api/config")).body).toMatchObject({ llm: limits });
		expect((await plan({ goal: "Plan A" })).status).toBe("done");
		expect(connected).toEqual([{ ...SETTINGS, ...limits }]);
		expect(setup([], undefined, { dir }).nextConfig()).toEqual({ ...SETTINGS, ...limits });
		// Saving without them hands the limits back to the environment.
		const plain = await json("PUT", "/api/settings/llm", { baseUrl: SETTINGS.baseUrl, model: "gpt-x" });
		expect(plain.body).toEqual({ llm: APP_STATUS });
	});

	it("rejects a reply budget or timeout out of range and keeps the current settings", async () => {
		const { json } = setup([], undefined, { env: false });
		const illegal = [
			{ maxTokens: 255 },
			{ maxTokens: 262_145 },
			{ maxTokens: 4096.5 },
			{ timeoutMs: 999 },
			{ timeoutMs: 3_600_001 },
			{ timeoutMs: "300000" },
		];
		for (const limit of illegal) {
			const response = await json<{ error: string; details: string[] }>("PUT", "/api/settings/llm", {
				...SETTINGS,
				...limit,
			});
			expect(response.status).toBe(400);
			expect(response.body.error).toContain("invalid model settings");
			expect(response.body.details.join("\n")).toContain(`/${Object.keys(limit)[0]}`);
		}
		expect((await json("GET", "/api/config")).body).toMatchObject({ llm: { configured: false } });
	});

	it("loads a settings file saved before reply budget and timeout existed with the environment's", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "llm-settings.json"), JSON.stringify({ ...SETTINGS }), { mode: 0o600 });
		const { json, nextConfig } = setup([], undefined, { dir });
		expect((await json("GET", "/api/config")).body).toMatchObject({ llm: APP_STATUS });
		expect(nextConfig()).toEqual({ ...SETTINGS, ...LIMITS });
	});
});

describe("other routes", () => {
	it("exports every stored event as an attachment", async () => {
		const { app, json } = setup(null);
		const criteriaRank = ["urgency", "importance", "unblocks", "effort", "age"];
		await json("POST", "/api/events", { type: "PreferencesSet", criteriaRank });
		const response = await app.app.request("/api/export");
		expect(response.headers.get("Content-Disposition")).toBe("attachment; filename=dawnskill-export.json");
		const body = (await response.json()) as { events: Array<{ seq: number; actor: string; body: unknown }> };
		expect(body).toMatchObject({ format: "dawnskill-events", version: "1.2.3", exportedAt: NOW });
		expect(body.events).toMatchObject([{ seq: 1, actor: "user", body: { type: "PreferencesSet", criteriaRank } }]);
	});

	it("answers unknown API paths with JSON 404", async () => {
		const { json } = setup(null);
		expect(await json("GET", "/api/nope")).toEqual({ status: 404, body: { error: "not_found" } });
	});

	it("streams store changes and run updates", async () => {
		const { app, json } = setup(planResponses(draft("Plan A")));
		const stream = await openStream(app);
		await stream.until('event: change\ndata: {"seq":0}\n\n');
		expect((await json("POST", "/api/plan", { goal: "Plan A" })).status).toBe(202);
		await app.runs.idle();
		await stream.until('event: change\ndata: {"seq":1}\n\n');
		await stream.until('"status":"done"');
		expect(stream.received()).toContain('event: run\ndata: {"id":"R1","goal":"Plan A","status":"running"');
		await stream.cancel();
	});
});

describe("plan progress", () => {
	/** Runs without the HTTP layer so the monotonic clock can be driven by the test. */
	function directRuns(now: () => number) {
		const store = openStore(":memory:");
		stores.push(store);
		const runs = createPlanRuns(store, () => NOW, { now });
		const published: Array<{ id: string; progress: RunProgress }> = [];
		runs.subscribeProgress((id, progress) => published.push({ id, progress }));
		const statuses: string[] = [];
		runs.subscribe((run) => statuses.push(run.status));
		const plan = async (provider: ChatProvider): Promise<PlanRun> => {
			const started = runs.start(
				{ goal: "Plan A", context: "", sources: [], uncapped: false, supersedes: null },
				provider,
			);
			if (started === null) throw new Error("busy");
			await runs.idle();
			const run = runs.list().find((r) => r.id === started.id);
			if (run === undefined) throw new Error(`run ${started.id} not listed`);
			return run;
		};
		return { published, statuses, plan };
	}

	it("streams the model's thinking as progress events, never as run events", async () => {
		const provider = streamingProvider(planResponses(draft("Plan A")), (call, onDelta) => {
			if (call === 0) onDelta({ reasoning: "Ownership comes before the CLI.", content: "" });
		});
		const { app, json } = setup(provider);
		const stream = await openStream(app);
		await stream.until('event: change\ndata: {"seq":0}\n\n');
		expect((await json("POST", "/api/plan", { goal: "Plan A" })).status).toBe(202);
		await app.runs.idle();
		await stream.until('"status":"done"');
		expect(stream.received()).toContain(
			'event: progress\ndata: {"id":"R1","progress":{"stage":"tasks","requests":1,"reasoning":"Ownership comes before the CLI."',
		);
		// queued, running, done: progress never adds a run event.
		expect(stream.received().match(/event: run\n/g)).toHaveLength(3);
		const listed = await json<PlanRun[]>("GET", "/api/plan/runs");
		expect(listed.body[0]?.progress).toMatchObject({ stage: "skills", requests: 2, totalTokens: 1 });
		await stream.cancel();
	});

	it("throttles progress to every 250 ms and rates tokens between the first and last chunk", async () => {
		let clock = 1000;
		const { published, statuses, plan } = directRuns(() => clock);
		const provider = streamingProvider(planResponses(draft("Plan A")), (call, onDelta) => {
			// Tasks stage: 10 chunks within 180 ms. Skills stage: 5 chunks 100 ms apart, after a 2 s pause.
			const [count, gap] = call === 0 ? [10, 20] : [5, 100];
			clock += call === 0 ? 0 : 2000;
			for (let i = 0; i < count; i++) {
				if (i > 0) clock += gap;
				onDelta({ reasoning: "", content: "x" });
			}
		});
		const run = await plan(provider);
		expect(run.status).toBe("done");
		expect(statuses).toEqual(["queued", "running", "done"]);
		expect(published.map(({ progress }) => [progress.stage, progress.tokens])).toEqual([
			["tasks", 0],
			["tasks", 1],
			["skills", 0],
			["skills", 1],
			["skills", 4],
		]);
		expect(published.every(({ id }) => id === run.id)).toBe(true);
		// The finished run includes the chunk the throttle held back.
		expect(run.progress).toEqual({
			stage: "skills",
			requests: 2,
			reasoning: "",
			output: "xxxxx",
			tokens: 5,
			totalTokens: 15,
			tokensPerSecond: 10,
		});
	});

	it("keeps only the tail of long thinking and answers", async () => {
		let clock = 0;
		const { plan } = directRuns(() => clock);
		const provider = streamingProvider(planResponses(draft("Plan A")), (_call, onDelta) => {
			for (const letter of "abcde") {
				clock += 10;
				onDelta({ reasoning: letter.repeat(1000), content: letter.repeat(600) });
			}
		});
		const run = await plan(provider);
		expect(run.progress?.reasoning).toBe(
			`${"b".repeat(1000)}${"c".repeat(1000)}${"d".repeat(1000)}${"e".repeat(1000)}`,
		);
		expect(run.progress?.output).toBe(`${"b".repeat(200)}${"c".repeat(600)}${"d".repeat(600)}${"e".repeat(600)}`);
	});
});

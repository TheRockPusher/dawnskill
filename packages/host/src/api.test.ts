import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatProvider, LlmConfig } from "@dawnskill/agents";
import { planResponses, scriptedProvider } from "@dawnskill/agents/testing";
import { AGENT_EVENTS, type EventType, type PlanDraft, type View } from "@dawnskill/core";
import { afterEach, describe, expect, it } from "vitest";
import { type Store, openStore } from "./db/store.ts";
import { createLlm } from "./llm.ts";
import type { PlanRun } from "./runs.ts";
import { type App, createApp } from "./server.ts";

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
 * (environment or saved settings) connects to it. `dir` holds the saved model settings.
 */
function setup(
	model: ReadonlyArray<string> | ChatProvider | null,
	clock: () => string = () => NOW,
	{ env = model !== null, dir = tempDir() }: { readonly env?: boolean; readonly dir?: string } = {},
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

	it("allows one run at a time", async () => {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const replies = planResponses(draft("Plan A"));
		let call = 0;
		const blocked: ChatProvider = {
			model: "gated",
			completeJson: async () => {
				await gate;
				return replies[call++] ?? "";
			},
		};
		const { app, json } = setup(blocked);
		expect((await json("POST", "/api/plan", { goal: "Plan A" })).status).toBe(202);
		const second = await json<{ code: string }>("POST", "/api/plan", { goal: "Plan B" });
		expect(second).toEqual({ status: 409, body: expect.objectContaining({ code: "busy" }) });
		release();
		await app.runs.idle();
		expect(app.runs.list().map((run) => run.status)).toEqual(["done"]);
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
			llm: { configured: false, source: null, model: null, baseUrl: null, hasApiKey: false },
		});
		expect((await json("GET", "/api/plan/runs")).body).toEqual([]);
	});
});

describe("model settings", () => {
	const SETTINGS = { baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "sk-secret" };
	const APP_STATUS = { configured: true, source: "app", model: "gpt-x", baseUrl: SETTINGS.baseUrl, hasApiKey: true };

	it("reports an environment model without its URL", async () => {
		const { json } = setup([]);
		expect((await json("GET", "/api/config")).body).toEqual({
			version: "1.2.3",
			llm: { configured: true, source: "env", model: "scripted", baseUrl: null, hasApiKey: false },
		});
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
		expect((await restarted.json("DELETE", "/api/settings/llm")).body).toEqual({
			llm: { configured: true, source: "env", model: "scripted", baseUrl: null, hasApiKey: false },
		});
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
		const response = await app.app.request("/api/stream");
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		const reader = response.body?.getReader();
		if (reader === undefined) throw new Error("no stream body");
		const decoder = new TextDecoder();
		let buffer = "";
		const until = async (text: string): Promise<void> => {
			while (!buffer.includes(text)) {
				const { value, done } = await reader.read();
				if (done) throw new Error(`stream ended before ${text}`);
				buffer += decoder.decode(value, { stream: true });
			}
		};
		await until('event: change\ndata: {"seq":0}\n\n');
		expect((await json("POST", "/api/plan", { goal: "Plan A" })).status).toBe(202);
		await app.runs.idle();
		await until('event: change\ndata: {"seq":1}\n\n');
		await until('"status":"done"');
		expect(buffer).toContain('event: run\ndata: {"id":"R1","goal":"Plan A","status":"running"');
		await reader.cancel();
	});
});

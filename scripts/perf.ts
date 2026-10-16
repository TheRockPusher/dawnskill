// Performance measurements on deterministic synthetic data built through the real kernel. Prints a
// Markdown table; `--check` exits 1 when a budget fails. Needs `pnpm build` (web bundle sizes).
// See docs/performance.md for what each number means.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { type Server, get } from "node:http";
import { createRequire } from "node:module";
import { type AddressInfo, createServer } from "node:net";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type {
	ApplyResult,
	DraftSkill,
	DraftTask,
	EventBody,
	KernelEvent,
	KernelState,
	Level,
	Likert,
	TargetLevel,
} from "../packages/core/src/index.ts";
import { apply, deriveView, initialState } from "../packages/core/src/index.ts";
import { userEvent } from "../packages/core/src/user.ts";
import { openStore } from "../packages/host/src/db/store.ts";
import { createApp } from "../packages/host/src/server.ts";

// @hono/node-server is a host dependency, not a root one: resolve it from the host package.
const { serve } = createRequire(new URL("../packages/host/package.json", import.meta.url))("@hono/node-server") as {
	serve: (
		options: { fetch: (request: Request) => Response | Promise<Response>; port: number; hostname: string },
		listening: (info: AddressInfo) => void,
	) => Server;
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const webDir = join(repoRoot, "packages/web/dist");
const assetsDir = join(webDir, "assets");
const check = process.argv.includes("--check");
/** What a browser sends; undici's fetch decompresses the reply transparently. */
const BROWSER_ENCODINGS = "gzip, deflate, br, zstd";

if (!existsSync(assetsDir)) {
	console.error(`${assetsDir} not found: run \`pnpm build\` first.`);
	process.exit(1);
}

// ── Synthetic data ───────────────────────────────────────────────────────────

const EPOCH = Date.parse("2026-01-05T09:00:00.000Z");
const at = (tick: number): string => new Date(EPOCH + tick * 60_000).toISOString();

/** mulberry32: a fixed seed gives every run the same data. */
function random(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** An event log grown through the kernel: only legal events are kept. */
class Log {
	readonly events: KernelEvent[] = [];
	state: KernelState = initialState();
	readonly rand: () => number;

	constructor(seed: number) {
		this.rand = random(seed);
	}

	int(min: number, max: number): number {
		return min + Math.floor(this.rand() * (max - min + 1));
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.rand() * items.length)] as T;
	}

	/** Applies a user event; keeps it when legal. */
	emit(body: EventBody): ApplyResult {
		const event = userEvent(body, at(this.events.length));
		const result = apply(this.state, event);
		if (result.ok) {
			this.state = result.state;
			this.events.push(event);
		}
		return result;
	}

	must(body: EventBody): void {
		const result = this.emit(body);
		if (!result.ok) throw new Error(`perf data: ${body.type} rejected: ${result.message}`);
	}

	/** Approved plans of 30 tasks (5 new skills, ~2 `after` edges per task) until `target` tasks exist, then progress. */
	plans(target: number): this {
		for (let p = 0; Object.keys(this.state.tasks).length < target; p++) {
			const skills: DraftSkill[] = Array.from({ length: 5 }, (_, j) => ({
				key: `p${p}-skill-${j}`,
				name: `Skill ${j} of plan ${p}`,
				description: "Synthetic skill for performance measurement.",
				concepts: ["first concept", "second concept", "third concept"],
				prerequisites: j % 2 === 1 ? [`p${p}-skill-${j - 1}`] : [],
				resources: [{ title: "Reference", url: `https://example.com/p${p}/skill-${j}` }],
				retrievalPrompts: ["Explain the core idea.", "When does it not apply?"],
				practiceMinutes: 60,
			}));
			const tasks: DraftTask[] = Array.from({ length: 30 }, (_, i) => {
				const earlier = Array.from({ length: i }, (_, k) => `t${k}`);
				const after = new Set<string>();
				while (after.size < Math.min(2, i)) after.add(this.pick(earlier));
				return {
					ref: `t${i}`,
					title: `Task ${i} of plan ${p}`,
					notes: "Synthetic task with a realistic amount of text in its notes field.",
					doneWhen: "The change is merged and verified.",
					category: this.pick(["build", "ops", "docs", "design"]),
					estimateMinutes: this.int(15, 240),
					importance: this.int(1, 5) as Likert,
					urgency: this.int(1, 5) as Likert,
					requires: this.rand() < 0.5 ? [{ skill: this.pick(skills).key, level: this.int(1, 3) as TargetLevel }] : [],
					after: [...after],
				};
			});
			const proposalId = `P${this.state.nextId}`;
			this.must({
				type: "PlanProposed",
				draft: { goal: `Goal ${p}`, summary: "Synthetic plan.", skills, tasks },
				supersedes: null,
			});
			const ratings = Object.fromEntries(skills.map((s) => [s.key, this.int(0, 3) as Level]));
			this.must({ type: "PlanApproved", proposalId, ratings });
		}
		// Two passes in id order: learning steps close gaps on the first, unblocking work tasks on the second.
		for (let pass = 0; pass < 2; pass++) {
			for (const task of Object.values(this.state.tasks)) {
				if (task.status !== "open" || this.rand() >= 0.35) continue;
				if (!this.emit({ type: "TaskStarted", taskId: task.id }).ok) continue;
				const proposalId = `P${this.state.nextId}`;
				this.must({
					type: "TaskCompleted",
					taskId: task.id,
					actualMinutes: Math.max(1, Math.round(task.estimateMinutes * (0.7 + this.rand()))),
					outcome: "Did it; notes on what was learned.",
					evidenceUrl: null,
				});
				const step = task.learning;
				if (step === null || !Object.hasOwn(this.state.proposals, proposalId)) continue;
				if (this.rand() < 0.7) {
					this.must({ type: "LevelConfirmed", proposalId, evidence: "Checked the deliverable." });
				} else {
					this.must({ type: "SkillSelfRated", skill: step.skill, level: step.targetLevel, evidence: "Self-assessed." });
				}
				if (this.rand() < 0.5) this.must({ type: "ReviewRecorded", skill: step.skill, recalled: this.rand() < 0.8 });
			}
		}
		return this;
	}

	/** Everyday traffic until the log holds `total` events: note edits, start/pause, self-ratings, reviews. */
	churn(total: number): this {
		const skills = Object.keys(this.state.skills);
		while (this.events.length < total) {
			const active = Object.values(this.state.tasks).filter((t) => t.status === "open" || t.status === "doing");
			const task = this.pick(active);
			const r = this.rand();
			if (r < 0.55) {
				this.must({
					type: "TaskEdited",
					taskId: task.id,
					patch: { notes: `Edited notes, revision ${this.events.length}.` },
				});
			} else if (r < 0.8) {
				this.emit({ type: task.status === "doing" ? "TaskPaused" : "TaskStarted", taskId: task.id });
			} else if (r < 0.9) {
				this.must({
					type: "SkillSelfRated",
					skill: this.pick(skills),
					level: this.int(0, 4) as Level,
					evidence: "Re-rated.",
				});
			} else {
				this.must({ type: "ReviewRecorded", skill: this.pick(skills), recalled: this.rand() < 0.8 });
			}
		}
		return this;
	}
}

function describe(state: KernelState): string {
	const tasks = Object.values(state.tasks);
	const edges = Object.values(state.blockers).reduce((n, b) => n + b.length, 0);
	const learning = tasks.filter((t) => t.learning !== null).length;
	return `${tasks.length} tasks (${learning} learning), ${edges} edges, ${Object.keys(state.skills).length} skills, seq ${state.seq}`;
}

// ── Statistics ───────────────────────────────────────────────────────────────

/** Nearest-rank percentile. */
const percentile = (xs: readonly number[], p: number): number => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number;
};
const median = (xs: readonly number[]): number => percentile(xs, 50);

function time(fn: () => void): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

// ── Results ──────────────────────────────────────────────────────────────────

interface Row {
	readonly metric: string;
	readonly value: string;
	readonly budget: string;
	/** null: informational, no budget. */
	readonly pass: boolean | null;
}

const rows: Row[] = [];
const fmt = (n: number, digits = 2): string => n.toFixed(digits);
const rate = (n: number): string => `${Math.round(n).toLocaleString("en-US")} events/s`;
const kib = (bytes: number): string => `${fmt(bytes / 1024, 1)} KiB`;

function row(metric: string, value: string, budget?: { text: string; pass: boolean }): void {
	rows.push({ metric, value, budget: budget?.text ?? "–", pass: budget?.pass ?? null });
}

// ── Kernel ───────────────────────────────────────────────────────────────────

const base = new Log(1).plans(300);
const workload = new Log(1).plans(300).churn(5000);
const churnEvents = workload.events.slice(base.events.length);
const scenarios = [`S300: ${describe(base.state)}`];

{
	const replayChurn = (): void => {
		let state = base.state;
		for (const event of churnEvents) {
			const result = apply(state, event);
			if (!result.ok) throw new Error(`perf: churn replay rejected ${event.type}: ${result.message}`);
			state = result.state;
		}
	};
	replayChurn();
	const runs = Array.from({ length: 7 }, () => churnEvents.length / (time(replayChurn) / 1000));
	const value = median(runs);
	row(`kernel apply, S300 (${churnEvents.length} churn events)`, rate(value), {
		text: "> 2,000 events/s",
		pass: value > 2000,
	});
}

for (const target of [100, 1000]) {
	const { state, events } = new Log(2).plans(target);
	scenarios.push(`S${target}: ${describe(state)}`);
	const now = at(events.length + 60);
	for (let i = 0; i < 5; i++) deriveView(state, now);
	const ms = median(Array.from({ length: 20 }, () => time(() => deriveView(state, now))));
	const tasks = Object.keys(state.tasks).length;
	row(
		`deriveView, S${target} (${tasks} tasks, median of 20)`,
		`${fmt(ms)} ms`,
		target === 1000 ? { text: "< 75 ms", pass: ms < 75 } : undefined,
	);
}

// ── Store ────────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "dawnskill-perf-"));
try {
	const writes: number[] = [];
	const replays: number[] = [];
	for (let run = 0; run < 3; run++) {
		const path = join(tmp, `store-${run}.db`);
		const store = openStore(path);
		writes.push(
			workload.events.length /
				(time(() => {
					for (const event of workload.events) {
						const result = store.apply(event);
						if (!result.ok) throw new Error(`perf: store rejected ${event.type}: ${result.message}`);
					}
				}) /
					1000),
		);
		store.close();
		replays.push(time(() => openStore(path).close()));
	}
	const write = median(writes);
	row(`store apply, SQLite WAL file (${workload.events.length} events, median of 3)`, rate(write), {
		text: "> 300 events/s",
		pass: write > 300,
	});
	row(`store reopen + replay + hash check (${workload.events.length} events)`, `${fmt(median(replays), 0)} ms`);

	// ── HTTP ─────────────────────────────────────────────────────────────────
	await http(join(tmp, "http.db"));

	// ── Startup ──────────────────────────────────────────────────────────────
	const startups: number[] = [];
	for (let run = 0; run < 3; run++) startups.push(await startup(join(tmp, `startup-${run}`)));
	const startMs = median(startups);
	row("cold startup, `node packages/host/src/main.ts` → /healthz ok (median of 3)", `${fmt(startMs, 0)} ms`, {
		text: "< 2,000 ms",
		pass: startMs < 2000,
	});
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

async function http(path: string): Promise<void> {
	const store = openStore(path);
	for (const event of base.events) store.apply(event);
	const { app } = createApp({ store, planner: null, clock: () => new Date().toISOString(), webDir, version: "perf" });
	const listening = Promise.withResolvers<void>();
	const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${port}`;
	try {
		const view = (headers?: Record<string, string>): Promise<Response> =>
			fetch(`${url}/api/view`, { headers: { "Accept-Encoding": BROWSER_ENCODINGS, ...headers } });
		const editable = Object.values(store.state.tasks)
			.filter((t) => t.status === "open")
			.map((t) => t.id);
		const post = (i: number): Promise<Response> =>
			fetch(`${url}/api/events`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Accept-Encoding": BROWSER_ENCODINGS },
				body: JSON.stringify({
					type: "TaskEdited",
					taskId: editable[i % editable.length],
					patch: { notes: `HTTP edit ${i}` },
				}),
			});

		const identity = await wireBytes(`${url}/api/view`, "identity");
		const gzip = await wireBytes(`${url}/api/view`, BROWSER_ENCODINGS);
		row("GET /api/view body on the wire, S300 (identity / gzip)", `${kib(identity)} / ${kib(gzip)}`);

		// Identity encoding is the budgeted GET: the server's own cost. The gzip rows add the in-process client's
		// gunzip of the whole view on the server's thread, so they are informational.
		const plain = await load(200, 1, () => view({ "Accept-Encoding": "identity" }));
		latencyRow("GET /api/view, no ETag, identity encoding, concurrency 1", plain, 25);

		for (const concurrency of [1, 10]) {
			const budgeted = concurrency === 1;
			const cold = await load(200, concurrency, () => view());
			// A write makes the next GET compute a fresh view and ETag, valid for the whole 304 run.
			await (await post(0)).arrayBuffer();
			const fresh = await view();
			await fresh.arrayBuffer();
			const etag = fresh.headers.get("ETag") ?? "";
			const cached = await load(304, concurrency, () => view({ "If-None-Match": etag }));
			const posts = await load(200, concurrency, post);
			latencyRow(`GET /api/view, no ETag, gzip, concurrency ${concurrency}`, cold, null);
			latencyRow(`GET /api/view, matching ETag (304), concurrency ${concurrency}`, cached, budgeted ? 5 : null);
			latencyRow(`POST /api/events (TaskEdited notes), concurrency ${concurrency}`, posts, budgeted ? 25 : null);
		}
	} finally {
		server.closeAllConnections();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
		store.close();
	}
}

/** Bytes of the response body as transferred (no decompression). */
async function wireBytes(url: string, acceptEncoding: string): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	get(url, { headers: { "Accept-Encoding": acceptEncoding } }, (response) => {
		let bytes = 0;
		response.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
		});
		response.on("end", () => resolve(bytes));
	}).on("error", reject);
	return promise;
}

/**
 * 200 warm-up requests, then 2000 timed with `concurrency` in flight. Each latency includes reading
 * (and decompressing) the body; client and server share one thread.
 */
async function load(status: number, concurrency: number, request: (i: number) => Promise<Response>): Promise<number[]> {
	let next = 0;
	const run = async (count: number): Promise<number[]> => {
		const latencies: number[] = [];
		const end = next + count;
		const worker = async (): Promise<void> => {
			while (next < end) {
				const i = next++;
				const start = performance.now();
				const response = await request(i);
				await response.arrayBuffer();
				latencies.push(performance.now() - start);
				if (response.status !== status) throw new Error(`perf: expected HTTP ${status}, got ${response.status}`);
			}
		};
		await Promise.all(Array.from({ length: concurrency }, worker));
		return latencies;
	};
	await run(200);
	return run(2000);
}

/** `p95Budget` null: informational row. */
function latencyRow(metric: string, latencies: readonly number[], p95Budget: number | null): void {
	const p95 = percentile(latencies, 95);
	row(
		`${metric}, p50 / p95 / p99`,
		`${fmt(percentile(latencies, 50))} / ${fmt(p95)} / ${fmt(percentile(latencies, 99))} ms`,
		p95Budget === null ? undefined : { text: `p95 < ${p95Budget} ms`, pass: p95 < p95Budget },
	);
}

async function freePort(): Promise<number> {
	const server = createServer().listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	server.close();
	await once(server, "close");
	return port;
}

/** Milliseconds from spawn until `/healthz` answers ok, with an empty DATA_DIR and no model configured. */
async function startup(dataDir: string): Promise<number> {
	const port = await freePort();
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAWNSKILL_")));
	const start = performance.now();
	const child = spawn(process.execPath, ["packages/host/src/main.ts"], {
		cwd: repoRoot,
		env: { ...env, DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1" },
		stdio: "ignore",
	});
	const exited = once(child, "exit");
	try {
		while (performance.now() - start < 10_000) {
			if (child.exitCode !== null) throw new Error(`perf: host exited with code ${child.exitCode} during startup`);
			try {
				const response = await fetch(`http://127.0.0.1:${port}/healthz`);
				if (response.ok) return performance.now() - start;
			} catch {
				// Not listening yet.
			}
			await sleep(5);
		}
		throw new Error("perf: host did not answer /healthz within 10 s");
	} finally {
		child.kill("SIGTERM");
		await exited;
	}
}

// ── Web bundle ───────────────────────────────────────────────────────────────

{
	let jsGzip = 0;
	for (const file of readdirSync(assetsDir).sort()) {
		const bytes = readFileSync(join(assetsDir, file));
		const gzip = gzipSync(bytes).byteLength;
		if (file.endsWith(".js")) jsGzip += gzip;
		row(`web asset \`${file}\` (raw / gzip)`, `${kib(bytes.byteLength)} / ${kib(gzip)}`);
	}
	row("web JS total, gzip", kib(jsGzip), { text: "< 80 KiB", pass: jsGzip < 80 * 1024 });
}

// ── Report ───────────────────────────────────────────────────────────────────

const cpu = cpus();
console.log(
	`Node ${process.version}, ${process.platform}/${process.arch}, ${cpu.length} × ${cpu[0]?.model.trim() ?? "unknown CPU"}`,
);
for (const line of scenarios) console.log(`- ${line}`);
console.log("");
console.log("| metric | value | budget | pass |");
console.log("| --- | --- | --- | --- |");
for (const r of rows)
	console.log(`| ${r.metric} | ${r.value} | ${r.budget} | ${r.pass === null ? "–" : r.pass ? "yes" : "**NO**"} |`);

const failed = rows.filter((r) => r.pass === false);
if (check && failed.length > 0) {
	console.error(`\n${failed.length} performance budget(s) failed: ${failed.map((r) => r.metric).join("; ")}`);
	process.exitCode = 1;
}

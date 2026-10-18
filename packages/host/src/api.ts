// JSON API under /api. The events handler is the user's only write path and the one importer of
// `@dawnskill/core/user`; planner output only reaches the store as a pending proposal (runs.ts).
import { promisify } from "node:util";
import { gzip as gzipCallback, gzipSync } from "node:zlib";
import { deriveView } from "@dawnskill/core";
import { userEvent } from "@dawnskill/core/user";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Store } from "./db/store.ts";
import type { Llm } from "./llm.ts";
import { MAX_PENDING, type PlanRun, type PlanRuns } from "./runs.ts";
import { MAX_SOURCES, parseEventBody, parseLlmUpdate, parsePlanRequest } from "./schemas.ts";
import { findUrls } from "./sources.ts";

interface ApiOptions {
	readonly store: Store;
	readonly runs: PlanRuns;
	/** Planning answers 503 while it has no provider. */
	readonly llm: Llm;
	readonly clock: () => string;
	readonly version: string;
}

/** A cached view is reused for the same seq until it is this old, so ages and due reviews still advance. */
const VIEW_TTL_MS = 60_000;
const PING_MS = 25_000;
const MAX_BODY = 1024 * 1024;
/** JSON bodies below this size are sent uncompressed: gzip would barely shrink them. */
const GZIP_MIN_BYTES = 1024;
const gzip = promisify(gzipCallback);

/** The view serialized and gzipped once per (seq, refresh); every GET until then serves these bytes. */
interface CachedView {
	readonly seq: number;
	readonly etag: string;
	readonly computedAt: number;
	readonly json: string;
	readonly gzipped: Uint8Array<ArrayBuffer>;
}

export function createApi({ store, runs, llm, clock, version }: ApiOptions): Hono {
	const api = new Hono();
	let cached: CachedView | null = null;

	function currentView(): CachedView {
		const now = clock();
		const nowMs = Date.parse(now);
		const { seq } = store.state;
		if (cached === null || cached.seq !== seq || nowMs - cached.computedAt >= VIEW_TTL_MS) {
			const json = JSON.stringify(deriveView(store.state, now));
			cached = { seq, etag: `"${seq}-${nowMs}"`, computedAt: nowMs, json, gzipped: new Uint8Array(gzipSync(json)) };
		}
		return cached;
	}

	api.use("*", bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "request body too large" }, 413) }));

	// gzip the other JSON replies (export above all); /view sends its cached buffer, /stream is not JSON.
	api.use("*", async (c, next) => {
		await next();
		const { res } = c;
		if (
			res.headers.has("Content-Encoding") ||
			!res.headers.get("Content-Type")?.startsWith("application/json") ||
			!acceptsGzip(c.req.header("Accept-Encoding"))
		) {
			return;
		}
		const body = new Uint8Array(await res.arrayBuffer());
		if (body.byteLength < GZIP_MIN_BYTES) {
			c.res = new Response(body, res);
			return;
		}
		const headers = new Headers(res.headers);
		headers.set("Content-Encoding", "gzip");
		headers.append("Vary", "Accept-Encoding");
		c.res = new Response(await gzip(body), { status: res.status, statusText: res.statusText, headers });
	});

	api.get("/view", (c) => {
		const { etag, json, gzipped } = currentView();
		c.header("ETag", etag);
		c.header("Cache-Control", "no-cache");
		c.header("Vary", "Accept-Encoding");
		if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
		c.header("Content-Type", "application/json");
		if (json.length < GZIP_MIN_BYTES || !acceptsGzip(c.req.header("Accept-Encoding"))) return c.body(json);
		c.header("Content-Encoding", "gzip");
		return c.body(gzipped);
	});

	api.post("/events", async (c) => {
		const json = await readJson(c.req.raw);
		if (!json.ok) return c.json({ error: "invalid JSON body", details: [] }, 400);
		const parsed = parseEventBody(json.value);
		if (!parsed.ok) return c.json({ error: parsed.error, details: parsed.details }, 400);
		const result = store.apply(userEvent(parsed.value, clock()));
		if (!result.ok) return c.json({ code: result.code, message: result.message }, 409);
		return c.json({ seq: result.state.seq });
	});

	api.post("/plan", async (c) => {
		const provider = llm.provider();
		if (provider === null) {
			return c.json({ error: "No model configured: add one in Settings or set DAWNSKILL_LLM_BASE_URL" }, 503);
		}
		const json = await readJson(c.req.raw);
		if (!json.ok) return c.json({ error: "invalid JSON body", details: [] }, 400);
		const parsed = parsePlanRequest(json.value);
		if (!parsed.ok) return c.json({ error: parsed.error, details: parsed.details }, 400);
		const { goal, context = "", supersedes = null, sources: listed = [], uncapped = false } = parsed.value;
		// Links pasted into the goal or context are read as well, after the listed ones.
		const sources = [...new Set([...listed, ...findUrls(`${goal}\n${context}`)])];
		if (sources.length > MAX_SOURCES) {
			const detail = `/sources = ${sources.length} URLs (with goal and context links); legal: at most ${MAX_SOURCES}`;
			return c.json({ error: `invalid plan request: ${detail}`, details: [detail] }, 400);
		}
		// Fail fast before spending model time; the kernel re-checks when the run proposes.
		if (supersedes !== null) {
			const old = Object.hasOwn(store.state.proposals, supersedes) ? store.state.proposals[supersedes] : undefined;
			if (old === undefined || old.payload.kind !== "plan" || old.status !== "pending") {
				const message = `supersedes = ${supersedes}; legal: a pending plan proposal`;
				return c.json({ code: "invalid", message }, 409);
			}
		}
		const run = runs.start({ goal, context, sources, uncapped, supersedes }, provider);
		if (run === null) {
			return c.json({ code: "busy", message: `the plan queue is full (${MAX_PENDING} runs queued or running)` }, 409);
		}
		return c.json({ runId: run.id }, 202);
	});

	api.get("/plan/runs", (c) => c.json(runs.list()));

	api.post("/plan/runs/:id/cancel", (c) => {
		const id = c.req.param("id");
		const result = runs.cancel(id);
		if (result.ok) return c.json(result.run);
		if (result.code === "not-found") return c.json({ error: `unknown plan run ${id}` }, 404);
		return c.json({ code: "finished", message: `plan run ${id} has already finished` }, 409);
	});

	api.get("/stream", (c) =>
		streamSSE(c, async (stream) => {
			const send = (event: "change" | "run" | "progress", data: unknown): void => {
				stream.writeSSE({ event, data: JSON.stringify(data) }).catch((error: unknown) => {
					console.error("SSE write failed", error);
				});
			};
			const unsubscribeStore = store.subscribe((seq) => send("change", { seq }));
			const unsubscribeRuns = runs.subscribe((run: PlanRun) => send("run", run));
			const unsubscribeProgress = runs.subscribeProgress((id, progress) => send("progress", { id, progress }));
			const ping = setInterval(() => {
				stream.write(": ping\n\n").catch(() => {});
			}, PING_MS);
			send("change", { seq: store.state.seq });
			if (!stream.aborted) await new Promise<void>((resolve) => stream.onAbort(resolve));
			clearInterval(ping);
			unsubscribeStore();
			unsubscribeRuns();
			unsubscribeProgress();
		}),
	);

	api.get("/export", (c) => {
		c.header("Content-Disposition", "attachment; filename=dawnskill-export.json");
		return c.json({ format: "dawnskill-events", version, exportedAt: clock(), events: store.events() });
	});

	api.get("/config", (c) => c.json({ version, llm: llm.status() }));

	api.put("/settings/llm", async (c) => {
		const json = await readJson(c.req.raw);
		if (!json.ok) return c.json({ error: "invalid JSON body", details: [] }, 400);
		const parsed = parseLlmUpdate(json.value);
		if (!parsed.ok) return c.json({ error: parsed.error, details: parsed.details }, 400);
		const error = llm.save(parsed.value);
		if (error !== null) return c.json({ error: `invalid model settings: ${error}`, details: [error] }, 400);
		return c.json({ llm: llm.status() });
	});

	api.delete("/settings/llm", (c) => {
		llm.clear();
		return c.json({ llm: llm.status() });
	});

	api.all("*", (c) => c.json({ error: "not_found" }, 404));

	return api;
}

async function readJson(
	request: Request,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
	try {
		const value: unknown = await request.json();
		return { ok: true, value };
	} catch {
		return { ok: false };
	}
}

/** True when `Accept-Encoding` lists gzip without `q=0`. */
function acceptsGzip(header: string | undefined): boolean {
	return (header ?? "").split(",").some((entry) => {
		const [name, ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
		return name === "gzip" && !params.some((param) => /^q=0(?:\.0*)?$/.test(param));
	});
}

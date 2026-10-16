// JSON API under /api. The events handler is the user's only write path and the one importer of
// `@dawnskill/core/user`; planner output only reaches the store as a pending proposal (runs.ts).
import { type View, deriveView } from "@dawnskill/core";
import { userEvent } from "@dawnskill/core/user";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Store } from "./db/store.ts";
import type { PlanRun, PlanRuns } from "./runs.ts";
import { parseEventBody, parsePlanRequest } from "./schemas.ts";

interface ApiOptions {
	readonly store: Store;
	/** Null when no model is configured: planning answers 503. */
	readonly runs: PlanRuns | null;
	readonly model: string | null;
	readonly clock: () => string;
	readonly version: string;
}

/** A cached view is reused for the same seq until it is this old, so ages and due reviews still advance. */
const VIEW_TTL_MS = 60_000;
const PING_MS = 25_000;
const MAX_BODY = 1024 * 1024;

export function createApi({ store, runs, model, clock, version }: ApiOptions): Hono {
	const api = new Hono();
	let cached: { readonly view: View; readonly etag: string; readonly computedAt: number } | null = null;

	function currentView(): { readonly view: View; readonly etag: string } {
		const now = clock();
		const nowMs = Date.parse(now);
		const { seq } = store.state;
		if (cached === null || cached.view.seq !== seq || nowMs - cached.computedAt >= VIEW_TTL_MS) {
			cached = { view: deriveView(store.state, now), etag: `"${seq}-${nowMs}"`, computedAt: nowMs };
		}
		return cached;
	}

	api.use("*", bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "request body too large" }, 413) }));

	api.get("/view", (c) => {
		const { view, etag } = currentView();
		c.header("ETag", etag);
		c.header("Cache-Control", "no-cache");
		if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
		return c.json(view);
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
		if (runs === null) {
			return c.json({ error: "No model configured: set DAWNSKILL_LLM_BASE_URL to enable planning" }, 503);
		}
		const json = await readJson(c.req.raw);
		if (!json.ok) return c.json({ error: "invalid JSON body", details: [] }, 400);
		const parsed = parsePlanRequest(json.value);
		if (!parsed.ok) return c.json({ error: parsed.error, details: parsed.details }, 400);
		const { goal, context = "", supersedes = null } = parsed.value;
		// Fail fast before spending model time; the kernel re-checks when the run proposes.
		if (supersedes !== null) {
			const old = Object.hasOwn(store.state.proposals, supersedes) ? store.state.proposals[supersedes] : undefined;
			if (old === undefined || old.payload.kind !== "plan" || old.status !== "pending") {
				const message = `supersedes = ${supersedes}; legal: a pending plan proposal`;
				return c.json({ code: "invalid", message }, 409);
			}
		}
		const run = runs.start({ goal, context, supersedes });
		if (run === null) return c.json({ code: "busy", message: "a plan run is already in progress" }, 409);
		return c.json({ runId: run.id }, 202);
	});

	api.get("/plan/runs", (c) => c.json(runs?.list() ?? []));

	api.get("/stream", (c) =>
		streamSSE(c, async (stream) => {
			const send = (event: "change" | "run", data: unknown): void => {
				stream.writeSSE({ event, data: JSON.stringify(data) }).catch((error: unknown) => {
					console.error("SSE write failed", error);
				});
			};
			const unsubscribeStore = store.subscribe((seq) => send("change", { seq }));
			const unsubscribeRuns = runs?.subscribe((run: PlanRun) => send("run", run));
			const ping = setInterval(() => {
				stream.write(": ping\n\n").catch(() => {});
			}, PING_MS);
			send("change", { seq: store.state.seq });
			if (!stream.aborted) await new Promise<void>((resolve) => stream.onAbort(resolve));
			clearInterval(ping);
			unsubscribeStore();
			unsubscribeRuns?.();
		}),
	);

	api.get("/export", (c) => {
		c.header("Content-Disposition", "attachment; filename=dawnskill-export.json");
		return c.json({ format: "dawnskill-events", version, exportedAt: clock(), events: store.events() });
	});

	api.get("/config", (c) => c.json({ version, llm: { configured: runs !== null, model } }));

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

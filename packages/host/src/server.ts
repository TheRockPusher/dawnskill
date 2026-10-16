import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatProvider } from "@dawnskill/agents";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApi } from "./api.ts";
import type { Store } from "./db/store.ts";
import { type PlanRuns, createPlanRuns } from "./runs.ts";

export interface AppOptions {
	readonly store: Store;
	/** Null when no model is configured: `POST /api/plan` answers 503. */
	readonly planner: { readonly provider: ChatProvider } | null;
	/** ISO-8601 UTC timestamps for events and views; injected so tests are deterministic. */
	readonly clock: () => string;
	/** Absolute path of the built web UI (`packages/web/dist`). */
	readonly webDir: string;
	/** Version reported by `GET /healthz`, `/api/config` and exports. */
	readonly version: string;
}

export interface App {
	readonly app: Hono;
	/** Background planner runs; null without a model. Callers await `idle()` (tests, shutdown). */
	readonly runs: PlanRuns | null;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

export function createApp(options: AppOptions): App {
	const { store, planner, clock, webDir, version } = options;
	const runs = planner === null ? null : createPlanRuns(store, planner.provider, clock);
	const app = new Hono();

	app.onError((error, c) => {
		console.error(error);
		return c.json({ error: "internal error" }, 500);
	});

	app.get("/healthz", (c) => c.json({ ok: true, version }));

	app.route("/api", createApi({ store, runs, model: planner?.provider.model ?? null, clock, version }));

	// A missing WEB_DIR (web UI not built yet) only disables static assets; the API keeps working.
	if (existsSync(webDir)) {
		// Vite content-hashes every file under /assets/, so its URL never serves different bytes. Everything
		// else (index.html above all) must be revalidated: a stale index.html points at old asset hashes.
		app.use("*", async (c, next) => {
			c.header("Cache-Control", c.req.path.startsWith("/assets/") ? IMMUTABLE : "no-cache");
			await next();
		});
		app.use("*", serveStatic({ root: webDir }));
	}

	// SPA fallback: client-side routes (and missing assets) get index.html, which is never cached.
	app.get("*", async (c) => {
		c.header("Cache-Control", "no-cache");
		try {
			return c.html(await readFile(join(webDir, "index.html"), "utf8"));
		} catch {
			return c.text("Web UI not built. Run `pnpm build`.", 404);
		}
	});

	return { app, runs };
}

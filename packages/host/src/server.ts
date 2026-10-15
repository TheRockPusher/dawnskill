import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

export interface AppOptions {
	/** Version reported by `GET /healthz`. */
	readonly version: string;
	/** Absolute path of the built web UI (`packages/web/dist`). */
	readonly webDir: string;
}

export function createApp(options: AppOptions): Hono {
	const app = new Hono();

	app.get("/healthz", (c) => c.json({ ok: true, version: options.version }));

	app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

	// A missing WEB_DIR (web UI not built yet) only disables static assets; the API keeps working.
	if (existsSync(options.webDir)) {
		app.use("*", serveStatic({ root: options.webDir }));
	}

	// SPA fallback: client-side routes get index.html.
	app.get("*", async (c) => {
		try {
			return c.html(await readFile(join(options.webDir, "index.html"), "utf8"));
		} catch {
			return c.text("Web UI not built. Run `pnpm build`.", 404);
		}
	});

	return app;
}

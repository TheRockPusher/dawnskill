import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llmConfigFromEnv, llmLimitsFromEnv, openAiCompatibleProvider } from "@dawnskill/agents";
import { serve } from "@hono/node-server";
import { openStore } from "./db/store.ts";
import { createLlm } from "./llm.ts";
import { createApp } from "./server.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as { version: string };

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const webDir = process.env.WEB_DIR ? resolve(process.env.WEB_DIR) : resolve(repoRoot, "packages/web/dist");

if (!Number.isInteger(port) || port < 0 || port > 65535) {
	throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

mkdirSync(dataDir, { recursive: true });
const store = openStore(join(dataDir, "dawnskill.db"));
const llm = createLlm({
	file: join(dataDir, "llm-settings.json"),
	env: llmConfigFromEnv(process.env),
	limits: llmLimitsFromEnv(process.env),
	connect: (config) => openAiCompatibleProvider(config, { userAgent: `dawnskill/${version}` }),
});
const { app, runs } = createApp({
	store,
	llm,
	clock: () => new Date().toISOString(),
	webDir,
	version,
});

const server = serve({ fetch: app.fetch, port, hostname }, () => {
	const { model, source } = llm.status();
	const status = model === null ? "no model configured (add one in Settings)" : `model ${model} (from ${source})`;
	console.log(`dawnskill ${version} listening on http://${hostname}:${port}, ${status}`);
});

function shutdown(): void {
	server.close((error) => {
		if (error) {
			console.error(error);
			process.exitCode = 1;
		}
	});
	// Cancel queued runs and abort an in-flight planner call; the worker settles before the store
	// closes. Every committed event is already durable, so closing does not wait for open event streams.
	runs.cancelAll();
	runs
		.idle()
		.then(() => store.close())
		.catch((error: unknown) => {
			console.error(error);
			process.exitCode = 1;
		});
	// Keep-alive connections and open event streams can hold close() open; do not wait forever.
	setTimeout(() => process.exit(), 10_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

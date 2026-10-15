import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
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

// The SQLite file lives here from the next phase on.
mkdirSync(dataDir, { recursive: true });

const server = serve({ fetch: createApp({ version, webDir }).fetch, port, hostname }, () => {
	console.log(`dawnskill listening on http://${hostname}:${port}`);
});

function shutdown(): void {
	server.close((error) => {
		if (error) {
			console.error(error);
			process.exitCode = 1;
		}
	});
	// Keep-alive connections can hold close() open; do not wait for them forever.
	setTimeout(() => process.exit(), 10_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

---
name: verify-dawnskill
description: "Launch an isolated Dawnskill instance (Preact web UI over the Hono JSON API and one SQLite file) and drive it in a real browser to prove a change to planning, tasks, learning steps, skill levels or model settings in a running instance."
---

# Verify Dawnskill

Use before claiming any change to Dawnskill works. Launch, run Doctor, then follow recipes in `features/` (index: `features/README.md`). The primary surface is the web UI (hash routes `#/`, `#/plan`, `#/tasks`, `#/skills`, `#/learning`, `#/settings`). Secondary surfaces: the JSON API under `/api` (used here as a read-only second view) and the Docker image (CI smoke-tests it with `scripts/docker-smoke.sh`; not covered here).

All paths below are relative to the repo root. Each run gets its own scratch dir (data, HOME, built UI), port and evidence dir; nothing touches `./data`, `packages/web/dist`, port 3000 or your HOME.

## Launch

Requires the repo's `node_modules` (`pnpm install` once) and Node ≥ 24.

1. Allocate the run (builds the UI from the current working tree into scratch, about 1 s):

   ```sh
   .omp/skills/verify-dawnskill/scripts/new-run.sh
   ```

   It prints `RUN_ID=…`, `PORT=…`, `BASE_URL=…`, `EVIDENCE=…`, `SERVICE=verify-dawnskill-…`, `RUN_ENV=/tmp/verify-dawnskill.…/run.env`, `SERVE_COMMAND=…`, and two paste-ready lines: `export RUN_ENV=…` (bash) and `globalThis.RUN_ENV = "…";` (eval). Every later step uses those printed values. `run.env` holds them plus `DATA_DIR`, `WEB_DIR`, `SCRATCH_HOME`, `SERVER_PID_FILE`, `SERVER_LOG`.

2. Start the server as an OMP named `bash` service: `name` = printed `SERVICE`, `command` = printed `SERVE_COMMAND`, `ready` = `{ "port": PORT, "log": "listening on http://127\\.0\\.0\\.1:" }` with the printed `PORT` number.

   Ready signal: the log line `dawnskill VERSION listening on http://127.0.0.1:PORT, no model configured (add one in Settings)`, VERSION being `package.json` `version`. `serve.sh` unsets every `DAWNSKILL_LLM_*` variable and points `HOME` and `DATA_DIR` into scratch, so the run always starts with no model and an empty store.

3. `bash` tool calls do not keep exports between calls: prefix every helper command below with the printed `export RUN_ENV=…` line and `&&`.

## Doctor

```sh
.omp/skills/verify-dawnskill/scripts/doctor.sh "$RUN_ENV"
```

Read-only. Prints `doctor: OK run=… pid=… version=… url=http://127.0.0.1:… db=/tmp/verify-dawnskill.…/data/dawnskill.db evidence=…` and exits 0 only when: the recorded PID is alive, runs `packages/host/src/main.ts` from this repo, carries this run's `VERIFY_DAWNSKILL_RUN_ID`, scratch `DATA_DIR` and `HOME`, and no `DAWNSKILL_LLM_*`; that PID holds the run's port; `/healthz` reports `ok: true` and the `package.json` version recorded at `new-run.sh` time (a bumped version means the checkout changed under the run: relaunch); the scratch DB and built UI exist and `/` serves the UI. Run it first whenever anything looks off; on failure read `SERVER_LOG` from `run.env`.

## Drive

Harness: OMP eval `browser` (read `xd://eval/browser` once), in a JavaScript eval cell. First cell: the printed `globalThis.RUN_ENV = "…";` line, then:

```js
globalThis.E = Object.fromEntries([...(await Bun.file(RUN_ENV).text()).matchAll(/^export (\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
globalThis.tab = await browser.open({ name: `verify-dawnskill-${E.RUN_ID}`, url: `${E.BASE_URL}/#/`, viewport: { width: 1280, height: 900 }, dialogs: "accept", app: { tern: false } });
globalThis.go = async (route) => { await tab.goto(`${E.BASE_URL}/#/${route}`); await tab.waitForSelector("main h1, main h2", { timeout: 10000 }); };
globalThis.sql = (query, evidenceName = "") => Bun.$`${E.REPO}/.omp/skills/verify-dawnskill/scripts/db.sh ${RUN_ENV} ${query} ${evidenceName}`.text();
globalThis.api = (path, evidenceName = "") => Bun.$`${E.REPO}/.omp/skills/verify-dawnskill/scripts/api.sh ${RUN_ENV} ${path} ${evidenceName}`.text();
globalThis.proof = async (feature, step) => {
  const base = `${E.EVIDENCE}/${feature}/${step}`;
  await Bun.write(`${base}.png`, Bun.file(await tab.screenshot({ fullPage: true, silent: true, format: "png" })));
  await Bun.write(`${base}.aria.yml`, `# ${await tab.url()}\n${await tab.ariaSnapshot("main")}`);
  return base;
};
```

Then follow a recipe: `E`, `tab`, `go`, `sql`, `api` and `proof` stay defined across cells. Handles are labels, roles and link names (`label/Goal`, `role/button[name="Approve plan"]`); role name filters match substrings, so use XPath with `normalize-space()` when one name contains another (`Cancel task` vs `Cancel task…`). Never use coordinates. The UI refreshes over SSE: wait for the element you expect (`tab.waitForSelector`) instead of sleeping. IDs (`T7`, `P3`) are global counters: read them from the URL after the action.

## Evidence

Everything goes to `EVIDENCE` from `run.env` (`.omp/evidence/verify-dawnskill/RUN_ID/`, outside scratch), one subdirectory per feature:

- UI: `proof(feature, step)` writes `<step>.png` (full-page screenshot) and `<step>.aria.yml` (URL + ARIA snapshot of `main`).
- Second view of every mutation: `sql(query, "<feature>/<name>.jsonl")` (read-only SQLite query: the query plus one JSON row per line) or `api(path, "<feature>/<name>.http")` (request, HTTP status, body). The `kernel_events` table is the source of truth; `tasks`, `skills`, `assessments`, `proposals`, `completions` are its projection.
- Proof = the user action, the resulting UI state, and the second view agreeing. A toast or a button changing state is never enough on its own.
- `.omp/evidence/` is not gitignored; leave it out of commits unless the user asks for it.

## Cleanup

1. In eval: `await browser.close({ name: \`verify-dawnskill-${E.RUN_ID}\` })`.
2. Stop the service: `write` to `proc://` + printed `SERVICE` + `/kill` (no content).
3. ```sh
   .omp/skills/verify-dawnskill/scripts/cleanup.sh "$RUN_ENV"
   ```
   Kills the recorded PID only if it still carries this run's ID (SIGTERM, SIGKILL after 10 s), then scans `/proc` and exits 1 if any process with this run's ID survives. Expected tail: `cleanup: no process of run … left`, `cleanup: removed /tmp/verify-dawnskill.…`, then the kept evidence files. Removes the whole scratch dir (DB, saved model settings and key, built UI, logs). Safe to run twice and after a failed launch. Runs create no scaffolding in the repo; evidence is never deleted.

## Helpers

| Script | Invocation | Exit |
|---|---|---|
| `scripts/new-run.sh` | `.omp/skills/verify-dawnskill/scripts/new-run.sh` | non-zero if the UI build fails |
| `scripts/serve.sh` | `.omp/skills/verify-dawnskill/scripts/serve.sh "$RUN_ENV"` (as the named service) | the server's |
| `scripts/doctor.sh` | `.omp/skills/verify-dawnskill/scripts/doctor.sh "$RUN_ENV"` | non-zero on any failed check |
| `scripts/db.sh` | `.omp/skills/verify-dawnskill/scripts/db.sh "$RUN_ENV" "SELECT key, level FROM skills" plan-manual-draft/skills.jsonl` (3rd argument optional: evidence file under `$EVIDENCE`) | non-zero on SQL error or missing DB |
| `scripts/api.sh` | `.omp/skills/verify-dawnskill/scripts/api.sh "$RUN_ENV" /api/config model-settings/config.http` (3rd argument optional) | non-zero unless HTTP 2xx |
| `scripts/cleanup.sh` | `.omp/skills/verify-dawnskill/scripts/cleanup.sh "$RUN_ENV"` | 1 for a non-scratch path or a surviving run process |

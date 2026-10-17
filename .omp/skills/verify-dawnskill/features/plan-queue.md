# Plan queue and cancel

Goals submitted while the planner is busy are queued: runs execute one at a time, oldest first, and every queued or running run card has a `Cancel` button. Cancelling a queued run drops it before it reaches the model; cancelling the running run aborts its model request, marks it `cancelled` and starts the next queued run. A cancelled run never proposes. The recipe points the planner at a model endpoint started in the eval kernel that accepts requests and never answers, so a run stays `running` until it is cancelled and every request to the model is counted.

## Sub-features

- `queue` a second and third goal (Plan page and Focus) while one runs show `queued` with `queued <date>`; only one request reaches the model.
- `cancel-queued` `Cancel` on a queued run marks it `cancelled` (no `started`), and the model never sees it.
- `cancel-running` `Cancel` on the running run marks it `cancelled` and the next queued run starts (`model planning…`, a second model request).
- `cancel-finished` cancelling a run that already finished answers 409 `finished`; no proposal exists.

## How to get to it (user POV)

- Plan page (`#/plan`), `New goal` + `Ask the planner`, repeatedly (covered).
- Focus page (`#/`), `What do you want to achieve?` + `Plan it` (covered).
- `Cancel` on a run card under the Focus form or in the Plan page's `Planner runs` panel (both covered). The Plan page also repeats the latest run under the form; this recipe scopes to `Planner runs`.
- Draft page `Re-plan with the model` queues the same way (not covered).

## Driving it with OMP browser

Preconditions:

- Baseline from `features/README.md`, no model configured.

1. **Start a model endpoint that never answers and save it in Settings.**
   ```js
   globalThis.R6 = { tag: Date.now().toString(36), requests: [] };
   R6.hang = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => { R6.requests.push(new URL(req.url).pathname); return new Promise(() => {}); } });
   R6.goals = ["Queue first", "Queue second", "Queue third"].map((g) => `${g} ${R6.tag}`);
   R6.card = (goal, scope = "") => `xpath/${scope}//div[strong[normalize-space()="${goal}"]]`;
   R6.runs = '//section[h2[normalize-space()="Planner runs"]]';
   R6.texts = async (scope = "") => { const out = []; for (const g of R6.goals) out.push(await tab.text(R6.card(g, scope))); return out; };
   await go("settings");
   await tab.fill("label/Base URL", `http://127.0.0.1:${R6.hang.port}/v1`);
   await tab.fill("label/Model", `verify-hang-${R6.tag}`);
   await tab.fill("label/API key", `sk-verify-${R6.tag}`);
   await tab.click('role/button[name="Save model settings"]');
   await tab.waitForSelector('role/button[name="Remove saved settings"]');
   await proof("plan-queue", "1-model-saved");
   return [await tab.text("text/Planner model:"), R6.requests.length];
   ```
   Returns `["Planner model: verify-hang-<tag> (saved in this app)", 0]`.
2. **Queue three goals back to back.**
   ```js
   await go("plan");
   for (const goal of R6.goals.slice(0, 2)) {
     await tab.fill("label/Goal", goal);
     await tab.click('role/button[name="Ask the planner"]');
     await tab.waitForSelector(R6.card(goal), { timeout: 10000 });
   }
   await go("");
   await tab.fill("label/What do you want to achieve?", R6.goals[2]);
   await tab.click('role/button[name="Plan it"]');
   await tab.waitForSelector(`${R6.card(R6.goals[2])}/span[normalize-space()="queued"]`, { timeout: 10000 });
   await proof("plan-queue", "2-queued");
   return [await R6.texts(), [...R6.requests]];
   ```
   Returns `[["model planning…\nQueue first <tag>\n0 attempts · started <date>\nCancel", "queued\nQueue second <tag>\nqueued <date>\nCancel", "queued\nQueue third <tag>\nqueued <date>\nCancel"], ["/v1/chat/completions"]]`: the button stayed enabled, the later goals wait, and only the first run called the model.
3. **Cancel the queued third run on Focus.**
   ```js
   await tab.click(`${R6.card(R6.goals[2])}/span/button[normalize-space()="Cancel"]`);
   await tab.waitForSelector(`${R6.card(R6.goals[2])}/span[normalize-space()="cancelled"]`, { timeout: 10000 });
   await proof("plan-queue", "3-queued-cancelled");
   return [(await R6.texts())[2], R6.requests.length];
   ```
   Returns `["cancelled\nQueue third <tag>\nqueued <date> · finished <date>", 1]`: no `started`, no `Cancel`, no model request.
4. **Cancel the running first run on the Plan page; the second starts.**
   ```js
   await go("plan");
   await tab.click(`${R6.card(R6.goals[0], R6.runs)}/span/button[normalize-space()="Cancel"]`);
   await tab.waitForSelector(`${R6.card(R6.goals[1], R6.runs)}/span[normalize-space()="model planning…"]`, { timeout: 10000 });
   await proof("plan-queue", "4-running-cancelled");
   return [await R6.texts(R6.runs), R6.requests.length];
   ```
   Returns `[["cancelled\nQueue first <tag>\nstarted <date> · finished <date> · 0 attempts", "model planning…\nQueue second <tag>\nstarted <date> · 0 attempts\nCancel", "cancelled\nQueue third <tag>\nqueued <date> · finished <date>"], 2]`.
5. **Cancel the second run; second view.**
   ```js
   await tab.click(`${R6.card(R6.goals[1], R6.runs)}/span/button[normalize-space()="Cancel"]`);
   await tab.waitForSelector(`${R6.card(R6.goals[1], R6.runs)}/span[normalize-space()="cancelled"]`, { timeout: 10000 });
   await proof("plan-queue", "5-all-cancelled");
   const list = await api("/api/plan/runs", "plan-queue/plan-runs.http");
   const runs = JSON.parse(list.slice(list.indexOf("\n") + 1)).filter((r) => r.goal.endsWith(R6.tag));
   const again = await fetch(`${E.BASE_URL}/api/plan/runs/${runs[0].id}/cancel`, { method: "POST" });
   const againBody = await again.text();
   await Bun.write(`${E.EVIDENCE}/plan-queue/cancel-finished.http`, `POST /api/plan/runs/${runs[0].id}/cancel\nHTTP ${again.status}\n${againBody}\n`);
   return [
     runs.map((r) => [r.goal, r.status, r.startedAt !== null, r.proposalId]),
     `HTTP ${again.status} ${againBody}`,
     await sql("SELECT count(*) AS proposals FROM proposals WHERE actor = 'agent'", "plan-queue/proposals.jsonl"),
     R6.requests.length,
   ];
   ```
   Returns `[[["Queue third <tag>", "cancelled", false, null], ["Queue second <tag>", "cancelled", true, null], ["Queue first <tag>", "cancelled", true, null]], "HTTP 409 {\"code\":\"finished\",\"message\":\"plan run R<n> has already finished\"}", "{\"proposals\":0}\n", 2]` on a fresh run (an earlier `planner-run.md` adds its own agent proposal to the count). Files land in `$EVIDENCE/plan-queue/`.
6. **Remove the model settings and stop the endpoint.**
   ```js
   await go("settings");
   await tab.click('role/button[name="Remove saved settings"]');
   await tab.waitForSelector("text/No model configured", { timeout: 10000 });
   R6.hang.stop(true);
   return await tab.text("text/No model configured");
   ```
   Returns `"No model configured — planning is unavailable; manual tasks still work."`.

## Gotchas

- Read card texts one at a time (`R6.texts`); concurrent `tab.text` calls on one tab fail with `Tab … is busy`.
- `idleTimeout: 0` keeps Bun from closing the hanging connection after 10 s, which would fail the run with `fetch failed` instead of keeping it `running`. The host's own timeout (`DAWNSKILL_LLM_TIMEOUT_MS`, 120 s under `serve.sh`) still ends a run left running that long: finish steps 2–5 well within it.
- The endpoint lives in the eval kernel: a kernel reset kills it and the running run fails. Step 6 stops it; `cleanup.sh` does not.
- At most 10 runs are queued or running; an 11th `POST /api/plan` answers 409 `busy` (not covered).
- A cancelled running run keeps `0 attempts`: attempts are only recorded when a run finishes on its own.

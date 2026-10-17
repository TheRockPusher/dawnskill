# Planner run

With a model configured, `Ask the planner` on the Plan page starts a background planner run; the run card shows its status and attempts and, once done, links to the agent's pending draft. The draft changes nothing until the user approves it; here the user reviews and rejects it with a reason. The recipe uses the VPS's local `llama-server` (`lfm2-350m` at `http://127.0.0.1:8080/v1`), read-only.

## Sub-features

- `run-start` `Ask the planner` creates a run (`R…`) that the run card tracks to `done` or `failed`.
- `run-draft` a done run links `Review draft` to a pending proposal "proposed by agent".
- `draft-reject` `Reject` (after a confirm dialog) with a reason marks the proposal `rejected` and creates nothing else.

## How to get to it (user POV)

- Plan page (`#/plan`), `New goal` form, `Ask the planner` (covered).
- Focus page (`#/`), `What do you want to achieve?` + `Plan it` (not covered; same `POST /api/plan`).
- Draft page `Re-plan with the model` (supersedes the draft; not covered).
- `Approve plan` on an agent draft (not covered here; same flow as `plan-manual-draft.md`).

## Driving it with OMP browser

Preconditions:

- Baseline from `features/README.md`, no model configured.
- The local model answers and its key file is readable: step 1 returns `200` and `true` first. Otherwise stop, run step 5 only if step 1 saved settings, and report this recipe as skipped (local model unavailable), not as verified.

1. **Check the model and save it in Settings.**
   ```js
   globalThis.R5 = { tag: Date.now().toString(36), baseUrl: "http://127.0.0.1:8080/v1", model: "lfm2-350m", keyFile: `${process.env.HOME}/.config/llama-server/api-key` };
   R5.goal = `Back up a folder with a shell script ${R5.tag}`;
   R5.card = `xpath///div[strong[normalize-space()="${R5.goal}"]]/..`;
   const health = await fetch("http://127.0.0.1:8080/health").then((r) => r.status, (e) => e.message);
   const hasKey = await Bun.file(R5.keyFile).exists();
   if (health !== 200 || !hasKey) return [health, hasKey];
   await go("settings");
   await tab.fill("label/Base URL", R5.baseUrl);
   await tab.fill("label/Model", R5.model);
   await tab.fill("label/API key", (await Bun.file(R5.keyFile).text()).trim());
   await tab.click('role/button[name="Save model settings"]');
   await tab.waitForSelector('role/button[name="Remove saved settings"]');
   await proof("planner-run", "1-model-saved");
   return [health, hasKey, await tab.text("text/Planner model:"), await tab.value("label/API key")];
   ```
   Returns `[200, true, "Planner model: lfm2-350m (saved in this app)", ""]`. The key is read from the host's key file straight into the password field; it is never printed and the evidence is captured after the field is cleared.
2. **Ask the planner and wait for the run.**
   ```js
   await go("plan");
   await tab.fill("label/Goal", R5.goal);
   await tab.click('role/button[name="Ask the planner"]');
   await tab.waitForSelector(`xpath///div[strong[normalize-space()="${R5.goal}"]]/span[normalize-space()="awaiting your review" or normalize-space()="failed"]`, { timeout: 300000 });
   await proof("planner-run", "2-run-finished");
   return await tab.text(R5.card);
   ```
   Takes 15–60 s (1–3 attempts are normal; the planner retries invalid output). The chip reads `model planning…` while the model works and `awaiting your review` once its draft is pending. Returns `"awaiting your review\nBack up a folder with a shell script <tag>\nstarted <date> · finished <date> · <n> attempts\nReview draft\n<k> tokens · <r> tok/s"`. A `failed` card instead (with the model's validation errors) means the small model produced no valid draft: keep the evidence and report the run as failed, not the recipe as verified.
3. **Review the draft.**
   ```js
   await tab.click(`${R5.card}//a[normalize-space()="Review draft"]`);
   await tab.waitForUrl(/#\/plan\/P\d+$/);
   R5.proposal = (await tab.url()).split("/").pop();
   await tab.waitForSelector(`role/heading[name="${R5.goal}"]`);
   await proof("planner-run", "3-draft");
   return [R5.proposal, await tab.text("text/proposed by agent"), await tab.text("text/estimated work")];
   ```
   Returns `["P<n>", "P<n> · proposed by agent · <date>", "<k> tasks · <s> new skill(s) · <h> estimated work"]` (counts depend on the model); the page shows the `pending` badge and `Approve plan` disabled until the new skills are rated.
4. **Reject with a reason.**
   ```js
   await tab.fill("label/Reason (optional)", `verification run ${R5.tag}`);
   await tab.click('xpath///button[normalize-space()="Reject"]');
   await tab.waitForSelector('xpath///main//span[normalize-space()="rejected"]', { timeout: 10000 });
   await proof("planner-run", "4-rejected");
   return await tab.text('xpath///main//span[normalize-space()="rejected"]/..');
   ```
   Returns `"rejected\nP<n> · proposed by agent · <date> · decided <date>"`.
5. **Remove the model settings.**
   ```js
   await go("settings");
   await tab.click('role/button[name="Remove saved settings"]');
   await tab.waitForSelector("text/No model configured", { timeout: 10000 });
   return await tab.text("text/No model configured");
   ```
   Returns `"No model configured — planning is unavailable; manual tasks still work."`.
6. **Second view and proof.**
   ```js
   const runs = await api("/api/plan/runs", "planner-run/plan-runs.http");
   const run = JSON.parse(runs.slice(runs.indexOf("\n") + 1)).find((r) => r.goal === R5.goal);
   return [
     { status: run.status, proposalId: run.proposalId, error: run.error },
     await sql(`SELECT id, status, actor, note, json_array_length(payload, '$.draft.tasks') AS tasks FROM proposals WHERE id = '${R5.proposal}'`, "planner-run/proposal.jsonl"),
     await Bun.file(`${E.DATA_DIR}/llm-settings.json`).exists(),
   ];
   ```
   Returns `[{"status":"done","proposalId":"P<n>","error":null}, "{\"id\":\"P<n>\",\"status\":\"rejected\",\"actor\":\"agent\",\"note\":\"verification run <tag>\",\"tasks\":<k>}\n", false]`: the run produced exactly this proposal, the proposal is rejected with the reason, and the saved settings file is gone. Files land in `$EVIDENCE/planner-run/`.

## Gotchas

- Goals submitted while a run is in progress are queued, not refused: `Ask the planner` stays enabled and the new card shows `queued` until the earlier runs finish. Queueing and `Cancel` are covered by `plan-queue.md`.
- The draft's content (titles, skill names, counts) is model output and varies per run; assert structure (pending, proposed by agent, rejected) and IDs, never the generated text.
- `Reject` asks `Reject this draft?` via `window.confirm`; the preamble opens the tab with `dialogs: "accept"`. Without it the click silently does nothing.
- The key file belongs to the host's inference setup; the recipe reads it but never writes, prints or saves it. Scratch `llm-settings.json` holds it until step 5 or cleanup removes it.
- A run against the local model uses shared CPU; do not run this recipe in parallel with other planner runs. Runs queued in the same instance wait for this one, and other processes using the same `llama-server` slow it down.

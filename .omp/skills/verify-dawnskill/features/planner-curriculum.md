# Planner: whole curriculum from source pages

A goal with linked curriculum pages and `Plan the whole curriculum (no task limit)` ticked: the run reads the pages (`reading sources`), extracts their reading lists (`extracting the curriculum`), plans every item as concrete study tasks in batches, and links each study task to the skills it builds (`develops`). The draft shows the run's sources, many tasks, a non-empty `Builds` column and no meta tasks (extracting, tracking, scheduling the curriculum). Needs a capable model: the recipe uses the cloud model from `~/.config/dawnskill/verify.env`, not the local `llama-server`.

## Sub-features

- `sources-input` the `Sources (optional): …` textarea sends one URL per line; the run card lists them as host plus path (`sources: susanrigetti.com/physics, …`).
- `uncapped` the `Plan the whole curriculum (no task limit)` checkbox; the run card shows the `all of it` chip and the draft exceeds the capped 12 tasks.
- `stages` the run card's live line shows `reading sources`, then `extracting the curriculum`, `drafting tasks`, `drafting skills`.
- `builds` draft tasks carry `builds: <skill> L<n>` chips in the `Builds` column; no task is planning work handed back to the user.

## How to get to it (user POV)

- Plan page (`#/plan`), `New goal` form: `Goal`, `Sources (optional): curriculum or reading-list pages, one URL per line`, `Plan the whole curriculum (no task limit)`, `Ask the planner` (covered).
- URLs pasted into `Goal` or `Context (optional): …` are read as well (not covered; same `POST /api/plan`).

## Driving it with OMP browser

Preconditions:

- Baseline from `features/README.md`, no model configured.
- `~/.config/dawnskill/verify.env` exists with `DAWNSKILL_LLM_BASE_URL`, `DAWNSKILL_LLM_MODEL`, `DAWNSKILL_LLM_API_KEY`, and the three source pages answer: step 1 returns `true` and `[200, 200, 200]` first. Otherwise stop, run step 6 only if step 1 saved settings, and report this recipe as skipped (cloud model or pages unavailable), not as verified.
- No other planner run is queued in this instance; with these three pages and `deepseek-v4.1-flash` the run takes about 100 minutes.

1. **Save the cloud model in Settings.**
   ```js
   globalThis.R7 = { tag: Date.now().toString(36), envFile: `${process.env.HOME}/.config/dawnskill/verify.env` };
   R7.urls = ["https://www.susanrigetti.com/physics", "https://www.susanrigetti.com/math", "https://www.susanrigetti.com/philosophy"];
   R7.goal = `Learn math, physics and philosophy ${R7.tag}`;
   R7.card = `xpath///div[strong[normalize-space()="${R7.goal}"]]/..`;
   const hasEnv = await Bun.file(R7.envFile).exists();
   const pages = await Promise.all(R7.urls.map((u) => fetch(u).then((r) => r.status, (e) => e.message)));
   if (!hasEnv || pages.some((s) => s !== 200)) return [hasEnv, pages];
   // Parsed inside this cell only; the values are never returned, logged or saved.
   const env = Object.fromEntries(
     (await Bun.file(R7.envFile).text()).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
       .map((l) => [l.slice(0, l.indexOf("=")).replace(/^export\s+/, ""), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]),
   );
   R7.model = env.DAWNSKILL_LLM_MODEL;
   await go("settings");
   await tab.fill("label/Base URL", env.DAWNSKILL_LLM_BASE_URL);
   await tab.fill("label/Model", env.DAWNSKILL_LLM_MODEL);
   await tab.fill("label/API key", env.DAWNSKILL_LLM_API_KEY);
   // The cloud model reasons before it answers; the defaults (4096 tokens, 120 s) cut extraction replies off mid-thought.
   await tab.fill("label/Max reply tokens", "32768");
   await tab.fill("label/Timeout", "300");
   await tab.click('role/button[name="Save model settings"]');
   await tab.waitForSelector('role/button[name="Remove saved settings"]');
   await proof("planner-curriculum", "1-model-saved");
   const config = await api("/api/config", "planner-curriculum/config-saved.http");
   return [hasEnv, pages, await tab.text("text/Planner model:"), await tab.value("label/API key"), config.includes('"maxTokens":32768,"timeoutMs":300000')];
   ```
   Returns `[true, [200, 200, 200], "Planner model: <model> (saved in this app)", "", true]`. The key goes from the file straight into the password field; the evidence is captured after the field is cleared. `/api/config` never contains the key.
2. **Ask for the whole curriculum.**
   ```js
   await go("plan");
   await tab.fill("label/Goal", R7.goal);
   await tab.fill("label/Sources (optional)", R7.urls.join("\n"));
   await tab.click("label/Plan the whole curriculum (no task limit)");
   await tab.click('role/button[name="Ask the planner"]');
   await tab.waitForSelector(`${R7.card}//a[@title="${R7.urls[0]}"]`, { timeout: 10000 });
   R7.started = Date.now();
   R7.stages = [];
   await proof("planner-curriculum", "2-run-started");
   return await tab.text(`${R7.card}//p[contains(@class, "run-sources")]`);
   ```
   Returns `"sources:\nsusanrigetti.com/physics\n, susanrigetti.com/math\n, susanrigetti.com/philosophy\nall of it"` (one link per page labelled host-without-`www.` plus path, full URL on hover, then the `all of it` chip).
3. **Wait for the draft by polling the API.** Set this eval cell's timeout to about 3500 s. The cell polls `/api/plan/runs` every 20 s and returns before the cell times out; if it returns `"still running"`, run the same cell again (the overall deadline is 110 minutes from step 2).
   ```js
   const FINAL = ["done", "failed", "cancelled"];
   const runOf = async () => {
     const r = await api("/api/plan/runs");
     return JSON.parse(r.slice(r.indexOf("\n") + 1)).find((x) => x.goal === R7.goal);
   };
   const stop = Math.min(Date.now() + 3_300_000, R7.started + 110 * 60_000);
   let run = await runOf();
   for (;;) {
     const stage = run.progress?.stage;
     if (stage && R7.stages.at(-1) !== stage) R7.stages.push(stage);
     if (FINAL.includes(run.status) || Date.now() >= stop) break;
     await Bun.sleep(20_000);
     run = await runOf();
   }
   const minutes = Math.round((Date.now() - R7.started) / 60_000);
   if (!FINAL.includes(run.status)) return ["still running", R7.stages, minutes, run.progress?.requests];
   await tab.waitForSelector(`xpath///div[strong[normalize-space()="${R7.goal}"]]/span[normalize-space()="awaiting your review" or normalize-space()="failed"]`, { timeout: 15000 });
   await proof("planner-curriculum", "3-run-finished");
   return [run.status, R7.stages, minutes, run.progress?.requests, run.error, await tab.text(R7.card)];
   ```
   Returns `["done", ["fetch" or "extract", …, "extract", "tasks", "skills"(, "dedupe")], <minutes>, <requests>, null, "awaiting your review\nLearn math, physics and philosophy <tag>\n…Review draft…"]`. The page read takes seconds, so the first poll may already see `extract`. Reference run (`deepseek-v4.1-flash`, Max reply tokens 32768, Timeout 300 s): 97 minutes, 90 requests (12 extract, 27 tasks, 51 skills, retries and repairs included; extraction 12 min, tasks 17 min, skills 68 min), about 591k streamed tokens. A `failed` run (`could not read <url>: …`, `the model's thinking used the whole reply budget of N tokens before it answered; …`, or the model's validation errors in the card) is a failed run: keep the evidence and report it, not the recipe as verified. The thinking-budget failure arrives within minutes; N other than 32768 means step 1's Max reply tokens did not reach the run. Still running after 110 minutes: report it as timed out with the stages and request count, and cancel it on the run card.
4. **Review the draft structure.**
   ```js
   await tab.click(`${R7.card}//a[normalize-space()="Review draft"]`);
   await tab.waitForUrl(/#\/plan\/P\d+$/);
   R7.proposal = (await tab.url()).split("/").pop();
   await tab.waitForSelector(`role/heading[name="${R7.goal}"]`);
   await tab.waitForSelector('xpath///table//th[normalize-space()="Builds"]');
   // A full-page screenshot of a draft with hundreds of tasks fails with "Page is too large"; keep the viewport instead.
   try {
     await proof("planner-curriculum", "4-draft");
   } catch {
     const base = `${E.EVIDENCE}/planner-curriculum/4-draft`;
     await Bun.write(`${base}.png`, Bun.file(await tab.screenshot({ silent: true, format: "png" })));
     await Bun.write(`${base}.aria.yml`, `# ${await tab.url()}\n${await tab.ariaSnapshot("main")}`);
   }
   return [
     R7.proposal,
     await tab.text("text/proposed by agent"),
     await tab.text("text/estimated work"),
     await tab.text('xpath///table//span[contains(@class, "plan-builds")]'),
   ];
   ```
   Returns `["P<n>", "P<n> · proposed by agent · <date>", "<k> tasks · <s> new skill(s) · <h> estimated work", "builds: <skill name> L<n>"]` with k well above 12. Reference run: 337 tasks, 293 new skills, 13216 h.
5. **Second view: run record and stored draft.**
   ```js
   const runs = await api("/api/plan/runs", "planner-curriculum/plan-runs.http");
   const run = JSON.parse(runs.slice(runs.indexOf("\n") + 1)).find((r) => r.goal === R7.goal);
   const rows = (await sql(
     `SELECT json_extract(t.value, '$.title') AS title, coalesce(json_array_length(t.value, '$.develops'), 0) AS builds
      FROM proposals p, json_each(p.payload, '$.draft.tasks') t WHERE p.id = '${R7.proposal}'`,
     "planner-curriculum/tasks.jsonl",
   )).trim().split("\n").map((l) => JSON.parse(l));
   const meta = rows.filter((r) => /extract|scrape|dedup|tracker|curriculum|schedule|spreadsheet/i.test(r.title));
   return [
     { status: run.status, proposalId: run.proposalId, sources: run.sources, uncapped: run.uncapped, stage: run.progress?.stage },
     await sql(`SELECT id, status, actor FROM proposals WHERE id = '${R7.proposal}'`, "planner-curriculum/proposal.jsonl"),
     { tasks: rows.length, building: rows.filter((r) => r.builds > 0).length, meta: meta.map((r) => r.title) },
   ];
   ```
   Returns `[{"status":"done","proposalId":"P<n>","sources":[<the three URLs in order>],"uncapped":true,"stage":"skills" or "dedupe"}, "{\"id\":\"P<n>\",\"status\":\"pending\",\"actor\":\"agent\"}\n", {"tasks":<k>,"building":<b>,"meta":[]}]` with k > 12, b > 0 (most study tasks build a skill) and an empty `meta` list. A non-empty `meta` is a failure: quote the titles. Reference run: 337 tasks, 319 building, `meta` empty.
6. **Remove the model settings.**
   ```js
   await go("settings");
   await tab.click('role/button[name="Remove saved settings"]');
   await tab.waitForSelector("text/No model configured", { timeout: 10000 });
   return [await tab.text("text/No model configured"), await Bun.file(`${E.DATA_DIR}/llm-settings.json`).exists()];
   ```
   Returns `["No model configured — planning is unavailable; manual tasks still work.", false]`. Files land in `$EVIDENCE/planner-curriculum/`.

## Gotchas

- Titles, skills and counts are model output: assert structure (sources, `all of it`, task count above the cap, `Builds` chips, no meta titles), never generated text.
- The draft stays pending; rating every new skill before `Approve plan` is not part of this recipe (approval of develops tasks without learning steps is covered by the host scenario "whole-curriculum plans").
- `Ask the planner` needs the checkbox ticked before the click; the form resets `Sources` and the checkbox after a successful submit.
- Never print, log, return or save the key: it stays inside step 1's cell and the password field; scratch `llm-settings.json` holds it until step 6 or cleanup removes it.
- More than 10 URLs (listed plus any in the goal or context) is refused with a 400 and shown as a form error; three is well within the limit.
- The browser tool caps a single `waitForSelector` at about 29 s whatever `timeout` says, and an XPath `contains(normalize-space(), …)` also matches hidden ancestors. Long waits therefore poll `/api/plan/runs` inside the eval cell (step 3), never the DOM.

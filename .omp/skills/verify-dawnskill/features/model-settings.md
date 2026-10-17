# Model settings

In Settings → Model the user saves the planner's OpenAI-compatible connection (base URL, model, API key) without restarting. The host stores it in `$DATA_DIR/llm-settings.json` (mode 0600), reports the connection without ever returning the key, keeps it out of exports, and enables `Ask the planner`. A planner run against an unreachable endpoint fails visibly on the Plan page. `Remove saved settings` deletes the file and returns to "no model".

## Sub-features

- `llm-save` saves base URL, model and key; the page shows `Planner model: <model> (saved in this app)`.
- `llm-key-hidden` the key field is a password input, empty after saving (placeholder `Saved — leave blank to keep it`); `/api/config` has only `hasApiKey`; `/api/export` never contains the key.
- `llm-file` `llm-settings.json` exists with mode `600`.
- `plan-run-failed` `Ask the planner` against an unreachable endpoint ends `failed` with `fetch failed`.
- `llm-remove` `Remove saved settings` (after a confirm dialog) deletes the file; the page shows `No model configured — …`.

## How to get to it (user POV)

- Settings page (`#/settings`), `Model` panel (covered).
- Plan page `Settings` link and Focus `Add one in Settings` link when no model is configured (navigation only, not covered).
- `DAWNSKILL_LLM_*` environment variables (`Configure with environment variables instead`): not covered; `serve.sh` deliberately unsets them.

## Driving it with OMP browser

Preconditions:

- Baseline from `features/README.md`: no model configured (true for every fresh run; `planner-run.md` removes its settings at the end).

1. **Save a connection to an unreachable endpoint.**
   ```js
   globalThis.R4 = { tag: Date.now().toString(36) };
   Object.assign(R4, { model: `verify-model-${R4.tag}`, key: `sk-verify-${R4.tag}`, baseUrl: "http://127.0.0.1:9/v1", goal: `Unreachable model ${R4.tag}` });
   const out = [];
   await go("settings");
   out.push(await tab.text("text/No model configured"));
   await tab.fill("label/Base URL", R4.baseUrl);
   await tab.fill("label/Model", R4.model);
   await tab.fill("label/API key", R4.key);
   out.push(await tab.attr("label/API key", "type"));
   await tab.click('role/button[name="Save model settings"]');
   await tab.waitForSelector('role/button[name="Remove saved settings"]');
   out.push(await tab.text("text/Planner model:"));
   out.push(await tab.attr("label/API key", "placeholder"));
   out.push(await tab.value("label/API key"));
   await proof("model-settings", "1-saved");
   return out;
   ```
   Returns `["No model configured — planning is unavailable; manual tasks still work.", "password", "Planner model: verify-model-<tag> (saved in this app)", "Saved — leave blank to keep it", ""]`.
2. **Second view of the save.**
   ```js
   const config = await api("/api/config", "model-settings/config-saved.http");
   const exported = await api("/api/export", "model-settings/export.http");
   const file = `${E.DATA_DIR}/llm-settings.json`;
   const mode = (await Bun.$`stat -c %a ${file}`.text()).trim();
   const saved = await Bun.file(file).json();
   await Bun.write(`${E.EVIDENCE}/model-settings/llm-settings.txt`, `mode ${mode}\n${JSON.stringify(saved)}\n`);
   return [config, config.includes(R4.key), exported.includes(R4.key) || exported.includes(R4.baseUrl), mode, saved.apiKey === R4.key && saved.model === R4.model];
   ```
   Returns `["HTTP 200\n{…\"llm\":{\"configured\":true,\"source\":\"app\",\"model\":\"verify-model-<tag>\",\"baseUrl\":\"http://127.0.0.1:9/v1\",\"hasApiKey\":true}}\n", false, false, "600", true]`: no key in `/api/config`, no key and no base URL in the export, file mode 600, file holds the key.
3. **Planner run fails visibly.**
   ```js
   const out = [];
   await go("plan");
   out.push(await tab.text("text/model: "));
   await tab.fill("label/Goal", R4.goal);
   await tab.click('role/button[name="Ask the planner"]');
   await tab.waitForSelector(`xpath///div[strong[normalize-space()="${R4.goal}"]]/following-sibling::p[normalize-space()="fetch failed"]`, { timeout: 15000 });
   out.push(await tab.text(`xpath///div[strong[normalize-space()="${R4.goal}"]]/..`));
   await proof("model-settings", "2-planner-failed");
   out.push(await api("/api/plan/runs", "model-settings/plan-runs.http"));
   return out;
   ```
   Returns `["model: verify-model-<tag>", "failed\nUnreachable model <tag>\nstarted <date> · finished <date> · 0 attempts\n\nfetch failed", "HTTP 200\n[{…\"goal\":\"Unreachable model <tag>\",\"status\":\"failed\",\"attempts\":0,\"error\":\"fetch failed\",…,\"proposalId\":null,…}…]\n"]` (newest run first).
4. **Remove the saved settings.**
   ```js
   await go("settings");
   await tab.click('role/button[name="Remove saved settings"]');
   await tab.waitForSelector("text/No model configured", { timeout: 10000 });
   await proof("model-settings", "3-removed");
   return [await tab.text("text/No model configured"), await tab.count('role/button[name="Remove saved settings"]')];
   ```
   Returns `["No model configured — planning is unavailable; manual tasks still work.", 0]`.
5. **Second view of the removal and proof.**
   ```js
   return [await api("/api/config", "model-settings/config-removed.http"), await Bun.file(`${E.DATA_DIR}/llm-settings.json`).exists()];
   ```
   Returns `["HTTP 200\n{…\"llm\":{\"configured\":false,\"source\":null,\"model\":null,\"baseUrl\":null,\"hasApiKey\":false}}\n", false]`. Files land in `$EVIDENCE/model-settings/`.

## Gotchas

- `Remove saved settings` opens `window.confirm`; the preamble's `dialogs: "accept"` answers it. In a tab opened without that policy the dialog stays pending and the tab reports `busy`; do not `await tab.dialog()` concurrently with the click, it blocks the tab.
- `http://127.0.0.1:9/v1` is chosen because nothing listens on port 9; if something does on your host, the run fails differently (status `failed` with another error).
- Changing the base URL of saved settings requires re-entering the key (the host refuses to reuse a key for a new URL).
- The run card appears twice (under the form and under `Planner runs`); `tab.text` reads the first.
- The evidence file `llm-settings.txt` contains this recipe's throwaway key only; never point this recipe at a real key.

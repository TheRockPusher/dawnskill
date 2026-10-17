# Task lifecycle

A user adds a task by hand on the Tasks page, opens its page, starts, pauses and resumes it, completes it with actual minutes and an outcome (which feeds the category's estimate calibration), reopens it and finally cancels it with a reason. The task page shows the status chip, the available actions and the completion history.

## Sub-features

- `task-create` adds an open work task from the `New task` form.
- `task-start-pause` moves the task between `open` and `doing`.
- `task-complete` records `done` with actual minutes, estimate and outcome in the completion history.
- `task-reopen` returns a closed task to `open`.
- `task-cancel` records `cancelled` with the reason as outcome.

## How to get to it (user POV)

- Tasks page (`#/tasks`), expandable `New task` form under the list (covered).
- Task page `#/tasks/<id>` via the task's link in the Tasks list (covered) or in Focus `Next up` / `Learn next` (not covered).
- `Start` and `Complete…` buttons on Focus cards (not covered; they send the same events).

## Driving it with OMP browser

Preconditions:

- Baseline from `features/README.md`.

1. **Create the task.**
   ```js
   globalThis.R2 = { tag: Date.now().toString(36) };
   R2.title = `Lifecycle task ${R2.tag}`;
   R2.status = () => tab.text('main .chip[class*="status-"]');
   await go("tasks");
   await tab.click('xpath///summary[normalize-space()="New task"]');
   await tab.fill("label/Title", R2.title);
   await tab.fill("label/Done when", "Release notes published");
   await tab.fill("label/Category", "ops");
   await tab.fill("label/Estimate (minutes)", "40");
   await tab.click('role/button[name="Create task"]');
   await tab.waitForSelector('xpath///span[normalize-space()="Created."]');
   await tab.click(`role/link[name="${R2.title}"]`);
   await tab.waitForSelector(`role/heading[name="${R2.title}"]`);
   R2.id = (await tab.url()).split("/").pop();
   return [R2.id, await R2.status(), await tab.isEnabled('role/button[name="Start"]')];
   ```
   Returns `["T<n>", "open", true]`.
2. **Start, pause, resume, complete.**
   ```js
   const out = [];
   await tab.click('role/button[name="Start"]');
   await tab.waitForSelector('role/button[name="Pause"]');
   out.push(await R2.status());
   await tab.click('role/button[name="Pause"]');
   await tab.waitForSelector('role/button[name="Start"]');
   out.push(await R2.status());
   await tab.click('role/button[name="Start"]');
   await tab.waitForSelector('role/button[name="Pause"]');
   await tab.click('role/button[name="Complete…"]');
   await tab.fill("label/Actual minutes", "50");
   await tab.fill("label/Outcome", `Shipped ${R2.tag}`);
   await tab.click('role/button[name="Mark done"]');
   await tab.waitForSelector('role/button[name="Reopen"]');
   out.push(await R2.status());
   out.push(await tab.text('xpath///h2[normalize-space()="Completion history"]/following::table[1]'));
   await proof("task-lifecycle", "1-done");
   return out;
   ```
   Returns `["doing", "open", "done", "<header row>\n<date>\tdone\t50 min / 40 min ×1.25\tShipped <tag>\t—"]`.
3. **Reopen, then cancel.**
   ```js
   const out = [];
   await tab.click('role/button[name="Reopen"]');
   await tab.waitForSelector('role/button[name="Start"]');
   out.push(await R2.status());
   await tab.click('role/button[name="Cancel task…"]');
   await tab.fill("label/Why cancel?", `Superseded ${R2.tag}`);
   await tab.click('xpath///button[normalize-space()="Cancel task"]');
   await tab.waitForSelector('role/button[name="Reopen"]');
   out.push(await R2.status());
   out.push(await tab.text('xpath///h2[normalize-space()="Completion history"]/following::table[1]'));
   await proof("task-lifecycle", "2-cancelled");
   return out;
   ```
   Returns `["open", "cancelled", "<header row>\n…done…\n<date>\tcancelled\tnot tracked / 40 min\tSuperseded <tag>\t—"]`.
4. **Second view and proof.**
   ```js
   return [
     await sql(`SELECT id, status FROM tasks WHERE id = '${R2.id}'`, "task-lifecycle/task.jsonl"),
     await sql(`SELECT status, actual_minutes, estimate_minutes, category, outcome FROM completions WHERE task_id = '${R2.id}' ORDER BY id`, "task-lifecycle/completions.jsonl"),
     await sql(`SELECT type FROM kernel_events WHERE json_extract(body, '$.taskId') = '${R2.id}' ORDER BY seq`, "task-lifecycle/events.jsonl"),
   ];
   ```
   Task `{"id":"T<n>","status":"cancelled"}`; completions `{"status":"done","actual_minutes":50,"estimate_minutes":40,"category":"ops","outcome":"Shipped <tag>"}` then `{"status":"cancelled","actual_minutes":null,…,"outcome":"Superseded <tag>"}`; events `TaskStarted, TaskPaused, TaskStarted, TaskCompleted, TaskReopened, TaskCancelled` in that order. Files land in `$EVIDENCE/task-lifecycle/`.

## Gotchas

- `role/button[name="Cancel task"]` also matches `Cancel task…` (substring); the XPath with `normalize-space()` picks the submit button.
- The `New task` form says `Created.` before the list re-renders over SSE; wait for the link, do not read the list immediately.
- `Start` is rendered but disabled for a blocked task (open blocker or skill gap); this recipe's task has no requirements, so it is ready.
- The `×1.25` ratio in the history depends on actual 50 / estimate 40; change both or neither.

# Dawnskill feature map

Per-feature verification recipes for the web UI. Each recipe is a sequence of JavaScript OMP eval cells.

## Baseline preconditions

- Launched via `SKILL.md` → Launch (fresh `new-run.sh`, named service ready), and `doctor.sh "$RUN_ENV"` printed `doctor: OK`.
- The eval preamble from `SKILL.md` → Drive has run in this kernel, so `RUN_ENV`, `E` (all of `run.env`), `tab`, `go`, `sql`, `api` and `proof` exist.
- No seed data: a fresh run has an empty store, no model configured, no auth. Every recipe creates its own uniquely tagged records, so recipes also work after any earlier recipe in the same launch.

## Driving conventions

- Every recipe starts with its own tag, `Date.now().toString(36)`, kept in a recipe-local object on `globalThis` (`globalThis.R1 = …`) so later cells of the same recipe can read it. Titles, skill names and skill keys include the tag; IDs (`T…`, `P…`) are read from the URL after the action, never assumed.
- Handles: `label/<visible label>` for fields (a prefix of the label is enough, e.g. `label/Actual minutes`), `role/button[name="…"]` and `role/link[name="…"]` for actions (substring match), XPath with `normalize-space()` when a name is a substring of another or a control must be scoped to a list item.
- After any action, wait for the element the next step needs (`tab.waitForSelector(…, { timeout: 10000 })`); the view refreshes over SSE a moment after the write returns.
- `tab.select(selector, "<option text>")` for `<select>`; `tab.fill` for inputs and textareas (`\n` in a textarea value separates lines).
- Confirm dialogs (`Reject this draft?`, `Remove the saved model settings…?`) are accepted automatically because the preamble opens the tab with `dialogs: "accept"`. A tab opened without it leaves them pending: the click does nothing and later calls report the tab `busy`.
- Reset to baseline: there is no reset command. Clean up (SKILL.md → Cleanup) and launch a fresh run.

## Proof and skip reporting

- Each recipe saves into `$EVIDENCE/<feature>/`: at least one `proof()` pair (`.png` + `.aria.yml`) after the user action, plus the second view (`sql(…, "<feature>/….jsonl")` or `api(…, "<feature>/….http")`) that shows the stored side effect.
- Compare against the literal text quoted in the recipe; a mismatch is a failure, not a reason to adjust the expectation.
- An entry point a recipe could not drive (for example the planner when no local model answers) is reported as skipped, with the reason, never as verified through another path.

## Features

- [plan-manual-draft.md](plan-manual-draft.md): write a plan draft by hand on the Plan page, validation, self-rating, learning-step preview, approval into tasks and learning tasks.
- [task-lifecycle.md](task-lifecycle.md): create a task on the Tasks page, start, pause, complete with actual minutes, reopen, cancel.
- [learning-levels.md](learning-levels.md): finish a learning step, confirm the proposed level on the Learning page, and add learning steps for a hand-made task's skill gap.
- [model-settings.md](model-settings.md): save, inspect and remove the planner model connection in Settings; the API key never leaves the host; a planner run against an unreachable model fails visibly.
- [planner-run.md](planner-run.md): a real planner run against the host's local `llama-server`, reviewed and rejected on the Plan page.
- [plan-queue.md](plan-queue.md): queue several goals while the planner is busy, cancel a queued and a running run, and confirm a cancelled run never proposes.

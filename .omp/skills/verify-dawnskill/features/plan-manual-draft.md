# Manual plan draft

A user without a model writes a plan draft by hand (goal, task, new skill, requirement), sees the kernel validator's problems live, saves it as a pending draft, rates themselves on the new skill, previews the learning steps approval will add, and approves it: the goal, the work task and one chained learning task per level step appear.

## Sub-features

- `draft-validate` lists kernel validation problems live and keeps `Save as new draft` disabled until there are none.
- `draft-save` saves a pending proposal `P…` marked "proposed by user".
- `draft-rate` requires a 0–5 self-rating for every new skill before `Approve plan` is enabled.
- `draft-preview` shows one learning step per level from the rated level up to the highest required level.
- `draft-approve` creates the goal, the work task and the learning tasks, and records the rating as a self assessment.

## How to get to it (user POV)

- Plan page (`#/plan`), button `Write a draft manually` (covered).
- Focus page (`#/`), link `write a plan draft by hand` shown when no model is configured: it only navigates to `#/plan` (not covered separately).
- `Edit` on a pending draft page opens the same editor prefilled (not covered).

## Driving it with OMP browser

Preconditions:

- Baseline from `features/README.md`.

1. **Tag.**
   ```js
   globalThis.R1 = { tag: Date.now().toString(36) };
   Object.assign(R1, { goal: `Ship demo ${R1.tag}`, task: `Write the demo ${R1.tag}`, skill: `Demo writing ${R1.tag}`, key: `demo-writing-${R1.tag}` });
   ```
   No output.
2. **Open the editor.**
   ```js
   await go("plan");
   await tab.click('role/button[name="Write a draft manually"]');
   await tab.waitForSelector('role/heading[name="Write a draft manually"]');
   return [await tab.isEnabled('role/button[name="Save as new draft"]'), await tab.text('xpath///summary[contains(., "problems to fix before saving")]')];
   ```
   Returns `[false, "3 problems to fix before saving"]`.
3. **Fill goal and task.**
   ```js
   await tab.fill("label/Goal", R1.goal);
   await tab.fill("label/Title", R1.task);
   await tab.fill("label/Done when (verifiable)", "Demo merged");
   await tab.fill("label/Category", "dev");
   return [await tab.count('xpath///summary[contains(., "problems to fix before saving")]'), await tab.isEnabled('role/button[name="Save as new draft"]'), await tab.isEnabled('role/button[name="Add requirement"]')];
   ```
   Returns `[0, true, false]` on a fresh store: the problem summary is gone, a draft without skills is already valid, and `Add requirement` is disabled (`Add a skill below first.`). After another recipe has created a skill the last value is `true`, because existing skills can be required directly.
4. **Add the skill and an L3 requirement.**
   ```js
   await tab.click('role/button[name="Add skill"]');
   await tab.fill("label/Name", R1.skill);
   await tab.fill("label/Key (lowercase-kebab", R1.key);
   await tab.fill("label/Description", "Writing demos");
   await tab.fill("label/What you need to know", "Audience\nScript");
   await tab.fill("label/Retrieval prompts", "Name the three parts of a demo script");
   await tab.click('role/button[name="Add requirement"]');
   await tab.select("label/Skill", `${R1.skill} (${R1.key})`);
   await tab.select("label/Level", "L3 Competent");
   return await tab.isEnabled('role/button[name="Save as new draft"]');
   ```
   Returns `true` (`Save as new draft` enabled).
5. **Save.**
   ```js
   await tab.click('role/button[name="Save as new draft"]');
   await tab.waitForUrl(/#\/plan\/P\d+$/);
   R1.proposal = (await tab.url()).split("/").pop();
   await tab.waitForSelector(`role/heading[name="${R1.goal}"]`);
   return [R1.proposal, await tab.text("text/estimated work"), await tab.text("text/proposed by user"), await tab.text(`text/Rate ${R1.skill} first.`), await tab.isEnabled('role/button[name="Approve plan"]')];
   ```
   Returns `["P<n>", "1 task · 1 new skill · 1 h estimated work", "P<n> · proposed by user · <date>", "Rate Demo writing <tag> first.", false]`; the page shows the `pending` badge.
6. **Rate L0 and read the preview.**
   ```js
   await tab.click(`xpath///div[@role="radiogroup" and @aria-label="Your level in ${R1.skill}"]//label[.//strong[normalize-space()="No exposure"]]`);
   await tab.waitForSelector('xpath///strong[normalize-space()="Total new learning: 3 steps, 3 h"]');
   await proof("plan-manual-draft", "1-rated-preview");
   return await tab.isEnabled('role/button[name="Approve plan"]');
   ```
   Returns `true`. The preview lists L1 Novice, L2 Advanced beginner, L3 Competent (each `new`, 1 h), the last with `unblocks “Write the demo <tag>”`, and `Total new learning: 3 steps, 3 h`.
7. **Approve.**
   ```js
   await tab.click('role/button[name="Approve plan"]');
   await tab.waitForUrl(/#\/$/);
   await tab.waitForSelector(`aria/${R1.goal}: 0 of 4 tasks done[role="progressbar"]`);
   await proof("plan-manual-draft", "2-approved-focus");
   ```
   The app navigates to Focus (`#/`), which shows the goal with `0/4 done`, `4 open tasks (0 in progress, 3 blocked)` and `Learn Demo writing <tag>: reach L1 Novice` under `Learn next`.
8. **Second view and proof.**
   ```js
   return [
     await sql(`SELECT id, status FROM proposals WHERE id = '${R1.proposal}'`, "plan-manual-draft/proposal.jsonl"),
     await sql(`SELECT t.title, t.status, t.learning IS NOT NULL AS learning FROM tasks t JOIN goals g ON g.id = t.goal_id WHERE g.title = '${R1.goal}' ORDER BY t.title`, "plan-manual-draft/tasks.jsonl"),
     await sql(`SELECT skill, level, source, evidence FROM assessments WHERE skill = '${R1.key}'`, "plan-manual-draft/assessments.jsonl"),
   ];
   ```
   Proposal `{"id":"P<n>","status":"accepted"}`; four `open` tasks: `Learn Demo writing <tag>: reach L1 Novice`, `…: reach L2 Advanced beginner`, `…: reach L3 Competent` (each `"learning":1`) and `Write the demo <tag>` (`"learning":0`); one assessment `{"skill":"demo-writing-<tag>","level":0,"source":"self","evidence":"self-rated at plan approval"}`. Files land in `$EVIDENCE/plan-manual-draft/`.

## Gotchas

- The editor does not carry over a Goal typed on the Plan page; fill it in the editor.
- `label/Goal`, `label/Title`, `label/Name`, `label/Level` are unique only while the draft has one task and one skill. With more, scope by the task or skill `article`.
- `role/progressbar[…]` does not match the native `<progress>`; use `aria/<name>[role="progressbar"]`. Likewise `xpath` `contains(text(), …)` misses text Preact splits into several nodes; use `text/<substring>`.
- Rating L1 instead of L0 changes the preview to 2 steps and the goal to 3 tasks; keep the recipe's rating or recompute every expectation.
- Full-page screenshots show the sticky header drawn mid-page; that is the capture, not a layout bug.

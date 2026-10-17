# Learning steps and level confirmation

Finishing a learning task does not raise a skill level by itself: it creates a level proposal that the user confirms (or rejects) on the Learning page, and only then the skill's level changes and the gap closes. For a task added by hand whose skill gap has no learning steps yet, `Add learning steps` on the task page creates one chained learning task per missing level, and the last one blocks the task.

## Sub-features

- `step-complete` completes a learning task with "What did you learn?" and proposes the step's level.
- `level-confirm` confirms the proposal on the Learning page; the skill level rises and a confirmed assessment is stored.
- `gap-met` the task that required the level shows `met` on the skill page.
- `steps-add` `Add learning steps` on a hand-made task creates the missing level steps and blocks the task on the last one.

## How to get to it (user POV)

- Learning task page `#/tasks/<id>`, reached from the skill page's `Learning tasks` table (covered) or Focus `Learn next` (not covered).
- Learning page (`#/learning`), `Level confirmations` list, `Confirm` (covered) and `Reject` (not covered).
- Focus `Needs you` shows the same confirmations (not covered).
- Task page `Blocked` panel, `Add learning steps` (covered).

## Driving it with OMP browser

Preconditions:

- Baseline from `features/README.md`. The recipe creates its own goal and skill through the manual draft editor (same controls as `plan-manual-draft.md`).

1. **Plan a skill needed at L1, rated L0, and open its learning step.**
   ```js
   globalThis.R3 = { tag: Date.now().toString(36) };
   Object.assign(R3, { goal: `Learn sketching ${R3.tag}`, task: `Sketch the UI ${R3.tag}`, skill: `Sketching ${R3.tag}`, key: `sketching-${R3.tag}` });
   await go("plan");
   await tab.click('role/button[name="Write a draft manually"]');
   await tab.waitForSelector('role/heading[name="Write a draft manually"]');
   await tab.fill("label/Goal", R3.goal);
   await tab.fill("label/Title", R3.task);
   await tab.fill("label/Done when (verifiable)", "Sketch reviewed");
   await tab.fill("label/Category", "design");
   await tab.click('role/button[name="Add skill"]');
   await tab.fill("label/Name", R3.skill);
   await tab.fill("label/Key (lowercase-kebab", R3.key);
   await tab.fill("label/Description", "Quick UI sketches");
   await tab.fill("label/What you need to know", "Layout");
   await tab.fill("label/Retrieval prompts", "What does a wireframe leave out?");
   await tab.fill("label/Practice minutes", "30");
   await tab.click('role/button[name="Add requirement"]');
   await tab.select("label/Skill", `${R3.skill} (${R3.key})`);
   await tab.select("label/Level", "L1 Novice");
   await tab.click('role/button[name="Save as new draft"]');
   await tab.waitForUrl(/#\/plan\/P\d+$/);
   await tab.waitForSelector(`role/heading[name="${R3.goal}"]`);
   await tab.click(`xpath///div[@role="radiogroup" and @aria-label="Your level in ${R3.skill}"]//label[.//strong[normalize-space()="No exposure"]]`);
   const total = await tab.text('xpath///strong[starts-with(normalize-space(), "Total new learning")]');
   await tab.click('role/button[name="Approve plan"]');
   await tab.waitForUrl(/#\/$/);
   await go(`skills/${R3.key}`);
   await tab.click(`role/link[name="Learn ${R3.skill}: reach L1 Novice"]`);
   await tab.waitForSelector(`role/heading[name="Learn ${R3.skill}: reach L1 Novice"]`);
   R3.step1 = (await tab.url()).split("/").pop();
   return [total, R3.step1];
   ```
   Returns `["Total new learning: 1 step, 30 min", "T<n>"]`.
2. **Complete the step, see the proposal, confirm it.**
   ```js
   const out = [];
   await tab.click('role/button[name="Start"]');
   await tab.waitForSelector('role/button[name="Pause"]');
   await tab.click('role/button[name="Complete…"]');
   out.push(await tab.text("text/Completing proposes"));
   await tab.fill("label/Actual minutes", "25");
   await tab.fill("label/What did you learn?", `Sketched three layouts ${R3.tag}`);
   await tab.click('role/button[name="Mark done"]');
   await tab.waitForSelector('role/button[name="Reopen"]');
   await go("learning");
   R3.item = `xpath///li[.//a[normalize-space()="${R3.skill}"] and .//button[normalize-space()="Confirm"]]`;
   await tab.waitForSelector(R3.item);
   out.push(await tab.text(R3.item));
   await proof("learning-levels", "1-confirmation-pending");
   await tab.click(`${R3.item}//button[normalize-space()="Confirm"]`);
   await tab.waitForSelector(R3.item, { hidden: true });
   out.push(await tab.count(R3.item));
   return out;
   ```
   Returns `["Completing proposes L1 Novice for this skill. Your level changes only when you confirm it.", "Sketching <tag>\n→\nL1\nNovice\nfrom Learn Sketching <tag>: reach L1 Novice\n\nEvidence: Sketched three layouts <tag>\n\nConfirm\nReject", 0]` (the last value: the confirmation is gone).
3. **Skill page shows L1 and the gap met.**
   ```js
   await go(`skills/${R3.key}`);
   await tab.waitForSelector('xpath///main//strong[normalize-space()="L1 Novice"]');
   await proof("learning-levels", "2-skill-l1");
   return await tab.text('xpath///h2[normalize-space()="Required by"]/following::table[1]');
   ```
   Returns `"TASK\tREQUIRED\tSTATUS\nSketch the UI <tag>\tL1 Novice\tmet"`.
4. **Hand-made task needing L3, then Add learning steps.**
   ```js
   const out = [];
   R3.task2 = `Teach sketching ${R3.tag}`;
   await go("tasks");
   await tab.click('xpath///summary[normalize-space()="New task"]');
   await tab.fill("label/Title", R3.task2);
   await tab.fill("label/Done when", "Workshop held");
   await tab.fill("label/Category", "teaching");
   await tab.click('role/button[name="Add required skill"]');
   await tab.select("label/Skill", R3.skill);
   await tab.select("label/Level", "L3 Competent");
   await tab.click('role/button[name="Create task"]');
   await tab.waitForSelector(`role/link[name="${R3.task2}"]`);
   await tab.click(`role/link[name="${R3.task2}"]`);
   await tab.waitForSelector(`role/heading[name="${R3.task2}"]`);
   R3.task2Id = (await tab.url()).split("/").pop();
   out.push(await tab.isEnabled('role/button[name="Start"]'));
   out.push(await tab.text("text/One learning task per level step"));
   await tab.click('role/button[name="Add learning steps"]');
   await tab.waitForSelector(`role/link[name="Learn ${R3.skill}: reach L3 Competent"]`);
   out.push(await tab.text('xpath///h2[normalize-space()="Blocked"]/..'));
   await proof("learning-levels", "3-steps-added");
   return out;
   ```
   Returns `[false, "One learning task per level step for 1 uncovered gap; they block this task.", "Blocked\n\nWaiting for 1 open task:\n\nLearn Sketching <tag>: reach L3 Competent open\n\n…you L1, needed L3 Competent · learning: Learn Sketching <tag>: reach L2 Advanced beginner (to L2), Learn Sketching <tag>: reach L3 Competent (to L3)"]`.
5. **Second view and proof.**
   ```js
   return [
     await sql(`SELECT key, level FROM skills WHERE key = '${R3.key}'`, "learning-levels/skill.jsonl"),
     await sql(`SELECT level, source, evidence FROM assessments WHERE skill = '${R3.key}' ORDER BY id`, "learning-levels/assessments.jsonl"),
     await sql(`SELECT id, title, status FROM tasks WHERE title LIKE 'Learn ${R3.skill}: %' ORDER BY title`, "learning-levels/learning-tasks.jsonl"),
     await sql(`SELECT blocker_id FROM dependencies WHERE task_id = '${R3.task2Id}'`, "learning-levels/dependencies.jsonl"),
   ];
   ```
   Skill `{"key":"sketching-<tag>","level":1}`; assessments `{"level":0,"source":"self",…}` then `{"level":1,"source":"confirmed","evidence":"Sketched three layouts <tag>"}`; learning tasks `…reach L1 Novice` `done`, `…reach L2 Advanced beginner` and `…reach L3 Competent` `open`; the hand-made task's only blocker is the L3 step's ID. Files land in `$EVIDENCE/learning-levels/`.

## Gotchas

- In the draft editor the requirement's `Skill` select defaults to the alphabetically first skill (existing skills included) and its options read `<name> (<key>)`; always select it. On the Tasks page `New task` form the options are plain names.
- Learning-task titles are generated: `Learn <skill name>: reach L<n> <Dreyfus name>`.
- The Learning page can list several confirmations; scope `Confirm`/`Reject` to the `li` containing the skill link, never click the first `Confirm`.
- `Add learning steps` appears only when a gap has no existing step covering it; a skill with open steps up to the needed level shows the steps instead.
- Spaced reviews only fall due a day after the first finished step; the host has no clock override, so `Reviews due` cannot be driven in one session.

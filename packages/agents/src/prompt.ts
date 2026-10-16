/**
 * Planner prompts, grounded in docs/learning-model.md (Dreyfus levels, skill granularity, retrieval
 * practice). Two compact stages so small local models fit: A writes tasks, B the skills they need.
 */
import type { KernelState } from "@dawnskill/core";

export interface PlannerInput {
	readonly goal: string;
	readonly context: string;
}

export interface PlannerPrompt {
	readonly system: string;
	readonly user: string;
}

const TASKS_SYSTEM = `You plan software work for Dawnskill, a learning-first task manager. Turn the user's goal into 3 to 12 concrete tasks. Reply only with JSON matching the schema.
Plan only the real work. Never add study, tutorial or "learn X" tasks: the system adds learning steps for skill gaps itself.
summary: two or three sentences on the approach.
Per task:
- title: an imperative, concrete action ("Add a --glob flag to the CLI parser"), not a topic.
- doneWhen: an observable criterion a stranger could check ("PR opened with passing CI"), never "understand X".
- estimateMinutes: focused minutes for someone who has the skills, 15 to 480. Split anything longer into several tasks.
- category: short lowercase kind of work (coding, debugging, writing, research, setup, review, design). Reuse an existing category when one fits. Never "learning".
- importance: 1 nice to have, 2 improves the result, 3 expected but could be trimmed, 4 a core part, 5 the goal fails without it.
- urgency: 1 no time pressure, 2 within months, 3 within weeks, 4 this week, 5 within days or others are waiting. Without a deadline in the context use 2 or 3.
- after: 0-based indices of EARLIER tasks that must be finished first, only when one task's output is another's input. Put blockers first. Usually empty.
- notes: approach hints or pitfalls; may be empty.`;

const SKILLS_SYSTEM = `You identify the skills a developer needs for planned tasks, for Dawnskill, a learning-first task manager. Reply only with JSON matching the schema. The system compares each needed level with the user's level and adds learning steps for every gap.
For each task find the 0 to 3 skills it genuinely depends on. Skip generic abilities (editor, basic git) unless the task is about them. List only skills some task needs, or prerequisites of those.
Per skill:
- key: lowercase kebab-case from the name, e.g. rust-ownership-borrowing. name: "<technology or domain>: <capability>", e.g. "Rust: ownership & borrowing".
- Granularity: advancing ONE level must take at most 480 focused minutes on one concrete deliverable. Otherwise split into narrower skills linked by prerequisites.
- neededBy: each task index that needs the skill, with the Dreyfus level needed to do that task unaided:
  1 Novice: needs step-by-step instructions.
  2 Advanced beginner: adapts examples for familiar tasks; stuck when things differ.
  3 Competent: plans and delivers a non-trivial feature alone; debugs own mistakes.
  4 Proficient: sees quickly what matters in unfamiliar code; catches problems in reviews.
  5 Expert: handles novel edge cases intuitively; designs idiomatic APIs.
  Most tasks need 2 or 3; 4 only for subtle work in unfamiliar code; 5 almost never.
- description: what the skill covers and where it stops.
- concepts: the key ideas to know, as short phrases.
- retrievalPrompts: 2 to 4 questions answered from memory (recall, write, explain); never multiple choice or yes/no.
- practiceMinutes: focused minutes to advance one level, 5 to 480.
- prerequisites: keys of skills to learn first; no cycles; often empty.
- resources: official documentation only, and only URLs you are certain exist; otherwise empty. Never guess a URL.`;

/** Stage A: goal and context in, tasks out. Existing categories keep estimate reference classes stable. */
export function buildTasksPrompt(state: KernelState, input: PlannerInput): PlannerPrompt {
	const categories = [
		...new Set(
			Object.values(state.tasks)
				.map((t) => t.category)
				.filter((c) => c !== "learning"),
		),
	].sort();
	const context = input.context.trim();
	const user = [
		`Goal: ${input.goal.trim()}`,
		`Context: ${context === "" ? "(none)" : context}`,
		`Existing task categories: ${categories.length === 0 ? "(none)" : categories.join(", ")}`,
	].join("\n");
	return { system: TASKS_SYSTEM, user };
}

/**
 * Stage B: numbered tasks in, skills with the tasks that need them out. Existing skills are not
 * listed: small models copy unrelated keys. Reuse happens afterwards (exact key match, dedupe judge).
 */
export function buildSkillsPrompt(
	goal: string,
	tasks: readonly { readonly title: string; readonly doneWhen: string }[],
): PlannerPrompt {
	const user = [
		`Goal: ${goal}`,
		"Tasks (index. title; done when):",
		...tasks.map((t, i) => `${i}. ${t.title}; done when: ${t.doneWhen}`),
	].join("\n");
	return { system: SKILLS_SYSTEM, user };
}

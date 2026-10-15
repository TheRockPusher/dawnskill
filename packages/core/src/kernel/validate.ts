/**
 * Pure input validators. Each returns human-readable errors (`[]` = valid) that name the bad path
 * and value and the legal set, so an agent can repair its own output. Inputs may come from an LLM,
 * so every field is checked at runtime whatever its static type says.
 */
import type { NewSkill, NewTask, TaskPatch } from "./events.ts";
import type { DraftSkill, KernelState, PlanDraft, SkillKey } from "./types.ts";

/** Lowercase kebab-case skill key (docs/learning-model.md §2). */
export const SKILL_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Core compiles against ES libs only; URL is a runtime global in every host we target. */
declare const URL: { canParse(input: string): boolean };

const MAX_SKILL_KEY = 64;
const MAX_KNOWN_SHOWN = 20;

export function validateDraft(state: KernelState, draft: PlanDraft): readonly string[] {
	const errors: string[] = [];
	text(errors, "goal", draft.goal, true, 200);
	text(errors, "summary", draft.summary, false, 2000);
	if (!Array.isArray(draft.skills)) errors.push(`skills = ${show(draft.skills)}; legal: array of 0..30 skills`);
	if (!Array.isArray(draft.tasks)) errors.push(`tasks = ${show(draft.tasks)}; legal: array of 1..40 tasks`);
	if (!Array.isArray(draft.skills) || !Array.isArray(draft.tasks)) return errors;
	count(errors, "skills", draft.skills, 0, 30);
	count(errors, "tasks", draft.tasks, 1, 40);
	const skills = objects(errors, "skills", draft.skills);
	const tasks = objects(errors, "tasks", draft.tasks);

	const draftKeys = new Map<SkillKey, number>();
	for (const [i, skill] of skills) {
		skillFields(errors, `skills[${i}].`, skill);
		const first = draftKeys.get(skill.key);
		if (first === undefined) draftKeys.set(skill.key, i);
		else errors.push(`skills[${i}].key = ${show(skill.key)} duplicates skills[${first}]; legal: unique keys`);
	}
	const known = new Set([...draftKeys.keys(), ...Object.keys(state.skills)]);
	for (const [i, skill] of skills) {
		if (!Array.isArray(skill.prerequisites)) continue;
		skill.prerequisites.forEach((key: SkillKey, j: number) => {
			const path = `skills[${i}].prerequisites[${j}]`;
			if (key === skill.key)
				errors.push(`${path} = ${show(key)} references the skill itself; legal: another skill key`);
			else if (!known.has(key)) errors.push(`${path} = ${show(key)} not found; known: ${list(known)}`);
		});
	}
	// Union of draft and state edges: acyclic here means acyclic whichever definition the kernel keeps.
	const prerequisites = (key: SkillKey): readonly SkillKey[] => [
		...skills.flatMap(([, skill]) =>
			skill.key === key && Array.isArray(skill.prerequisites) ? skill.prerequisites : [],
		),
		...(Object.hasOwn(state.skills, key) ? (state.skills[key]?.prerequisites ?? []) : []),
	];
	const skillCycle = findCycle([...draftKeys.keys()], prerequisites);
	if (skillCycle !== null) {
		const owner = skillCycle.find((key) => draftKeys.has(key));
		const path = owner === undefined ? "skills" : `skills[${draftKeys.get(owner)}].prerequisites`;
		errors.push(`${path} form a cycle: ${skillCycle.join(" -> ")}; legal: acyclic prerequisites`);
	}

	const refs = new Map<string, number>();
	for (const [i, task] of tasks) {
		const path = `tasks[${i}]`;
		text(errors, `${path}.ref`, task.ref, true);
		const first = refs.get(task.ref);
		if (first === undefined) refs.set(task.ref, i);
		else errors.push(`${path}.ref = ${show(task.ref)} duplicates tasks[${first}]; legal: unique refs`);
		taskFields(errors, `${path}.`, task, false);
		requirements(errors, `${path}.requires`, task.requires, known);
	}
	for (const [i, task] of tasks) {
		if (!Array.isArray(task.after)) {
			errors.push(`tasks[${i}].after = ${show(task.after)}; legal: array of task refs`);
			continue;
		}
		task.after.forEach((ref: string, j: number) => {
			const path = `tasks[${i}].after[${j}]`;
			if (ref === task.ref) errors.push(`${path} = ${show(ref)} references the task itself; legal: another task ref`);
			else if (!refs.has(ref)) errors.push(`${path} = ${show(ref)} not found; known: ${list(refs.keys())}`);
		});
	}
	const after = (ref: string): readonly string[] =>
		tasks.flatMap(([, task]) => (task.ref === ref && Array.isArray(task.after) ? task.after : []));
	const taskCycle = findCycle([...refs.keys()], after);
	if (taskCycle !== null) {
		errors.push(
			`tasks[${refs.get(taskCycle[0] as string)}].after forms a cycle: ${taskCycle.join(" -> ")}; legal: acyclic dependencies`,
		);
	}
	return errors;
}

export function validateNewTask(state: KernelState, task: NewTask): readonly string[] {
	const errors: string[] = [];
	goal(errors, state, task.goalId);
	taskFields(errors, "", task, false);
	requirements(errors, "requirements", task.requirements, new Set(Object.keys(state.skills)));
	return errors;
}

/** Only fields present in the patch are checked. */
export function validateTaskPatch(state: KernelState, patch: TaskPatch): readonly string[] {
	const errors: string[] = [];
	if (patch.goalId !== undefined) goal(errors, state, patch.goalId);
	taskFields(errors, "", patch, true);
	if (patch.requirements !== undefined) {
		requirements(errors, "requirements", patch.requirements, new Set(Object.keys(state.skills)));
	}
	return errors;
}

export function validateNewSkill(state: KernelState, skill: NewSkill): readonly string[] {
	const errors: string[] = [];
	skillFields(errors, "", skill);
	if (!Array.isArray(skill.prerequisites)) return errors;
	skill.prerequisites.forEach((key, i) => {
		const path = `prerequisites[${i}]`;
		if (key === skill.key) errors.push(`${path} = ${show(key)} references the skill itself; legal: another skill key`);
		else if (!Object.hasOwn(state.skills, key)) {
			errors.push(`${path} = ${show(key)} not found; known: ${list(Object.keys(state.skills))}`);
		}
	});
	const prerequisites = (key: SkillKey): readonly SkillKey[] => [
		...(key === skill.key ? skill.prerequisites : []),
		...(Object.hasOwn(state.skills, key) ? (state.skills[key]?.prerequisites ?? []) : []),
	];
	const cycle = findCycle([skill.key], prerequisites);
	if (cycle !== null) errors.push(`prerequisites form a cycle: ${cycle.join(" -> ")}; legal: acyclic prerequisites`);
	return errors;
}

/** Field rules shared by draft skills and new skills; references are checked by the caller. */
function skillFields(errors: string[], prefix: string, skill: DraftSkill): void {
	const { key } = skill;
	if (typeof key !== "string" || !SKILL_KEY_PATTERN.test(key) || key.length > MAX_SKILL_KEY) {
		errors.push(
			`${prefix}key = ${show(key)}; legal: lowercase kebab-case matching ${SKILL_KEY_PATTERN.source}, at most ${MAX_SKILL_KEY} chars`,
		);
	}
	text(errors, `${prefix}name`, skill.name, true, 120);
	text(errors, `${prefix}description`, skill.description, false, 2000);
	texts(errors, `${prefix}concepts`, skill.concepts, 12);
	texts(errors, `${prefix}retrievalPrompts`, skill.retrievalPrompts, 8);
	integer(errors, `${prefix}practiceMinutes`, skill.practiceMinutes, 5, 2400);
	if (!Array.isArray(skill.prerequisites)) {
		errors.push(`${prefix}prerequisites = ${show(skill.prerequisites)}; legal: array of skill keys`);
	}
	if (!Array.isArray(skill.resources)) {
		errors.push(`${prefix}resources = ${show(skill.resources)}; legal: array of {title, url}`);
		return;
	}
	for (const [i, resource] of objects(errors, `${prefix}resources`, skill.resources)) {
		const path = `${prefix}resources[${i}]`;
		text(errors, `${path}.title`, resource.title, true);
		const { url } = resource;
		if (typeof url !== "string" || !/^https?:\/\//i.test(url) || !URL.canParse(url)) {
			errors.push(`${path}.url = ${show(url)}; legal: absolute http(s) URL`);
		}
	}
}

interface TaskFields {
	readonly title?: unknown;
	readonly notes?: unknown;
	readonly doneWhen?: unknown;
	readonly category?: unknown;
	readonly estimateMinutes?: unknown;
	readonly importance?: unknown;
	readonly urgency?: unknown;
}

/** Task metadata rules. `partial`: absent fields are skipped (patches); otherwise every field is required. */
function taskFields(errors: string[], prefix: string, task: TaskFields, partial: boolean): void {
	const present = (value: unknown): boolean => !partial || value !== undefined;
	if (present(task.title)) text(errors, `${prefix}title`, task.title, true, 200);
	if (present(task.doneWhen)) text(errors, `${prefix}doneWhen`, task.doneWhen, false, 1000);
	if (present(task.notes)) text(errors, `${prefix}notes`, task.notes, false, 4000);
	if (present(task.category)) text(errors, `${prefix}category`, task.category, true, 40);
	if (present(task.estimateMinutes)) integer(errors, `${prefix}estimateMinutes`, task.estimateMinutes, 1, 100_000);
	if (present(task.importance)) integer(errors, `${prefix}importance`, task.importance, 1, 5);
	if (present(task.urgency)) integer(errors, `${prefix}urgency`, task.urgency, 1, 5);
}

function requirements(errors: string[], path: string, value: unknown, known: ReadonlySet<SkillKey>): void {
	if (!Array.isArray(value)) {
		errors.push(`${path} = ${show(value)}; legal: array of {skill, level}`);
		return;
	}
	const seen = new Map<unknown, number>();
	for (const [i, { skill, level }] of objects<{ skill?: unknown; level?: unknown }>(errors, path, value)) {
		const first = seen.get(skill);
		if (first !== undefined) {
			errors.push(
				`${path}[${i}].skill = ${show(skill)} duplicates ${path}[${first}]; legal: one requirement per skill`,
			);
		} else {
			seen.set(skill, i);
			if (typeof skill !== "string" || !known.has(skill)) {
				errors.push(`${path}[${i}].skill = ${show(skill)} not found; known: ${list(known)}`);
			}
		}
		integer(errors, `${path}[${i}].level`, level, 1, 5);
	}
}

function goal(errors: string[], state: KernelState, goalId: unknown): void {
	if (goalId === null || (typeof goalId === "string" && Object.hasOwn(state.goals, goalId))) return;
	errors.push(`goalId = ${show(goalId)} not found; legal: null or one of ${list(Object.keys(state.goals))}`);
}

/** Entries of `items` that are objects, with their index; reports the others. */
function objects<T>(errors: string[], path: string, items: readonly T[]): readonly (readonly [number, T])[] {
	const valid: (readonly [number, T])[] = [];
	items.forEach((item, i) => {
		if (typeof item === "object" && item !== null && !Array.isArray(item)) valid.push([i, item]);
		else errors.push(`${path}[${i}] = ${show(item)}; legal: object`);
	});
	return valid;
}

function text(errors: string[], path: string, value: unknown, required: boolean, max = Number.POSITIVE_INFINITY): void {
	if (typeof value === "string" && value.length <= max && (!required || value.trim().length > 0)) return;
	const kind = required ? "non-empty string" : "string";
	errors.push(
		`${path} = ${show(value)}; legal: ${max === Number.POSITIVE_INFINITY ? kind : `${kind} of at most ${max} chars`}`,
	);
}

function texts(errors: string[], path: string, value: unknown, max: number): void {
	if (!Array.isArray(value) || value.length < 1 || value.length > max) {
		errors.push(`${path} = ${show(value)}; legal: 1..${max} non-empty strings`);
		return;
	}
	value.forEach((item, i) => {
		text(errors, `${path}[${i}]`, item, true);
	});
}

function count(errors: string[], path: string, value: readonly unknown[], min: number, max: number): void {
	if (value.length < min || value.length > max)
		errors.push(`${path} has ${value.length} entries; legal: ${min}..${max}`);
}

function integer(errors: string[], path: string, value: unknown, min: number, max: number): void {
	if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return;
	errors.push(`${path} = ${show(value)}; legal: integer ${min}..${max}`);
}

/** Short, unambiguous rendering of a bad value; long strings are cut and their length shown. */
function show(value: unknown): string {
	if (typeof value === "string") {
		return value.length > 40 ? `${JSON.stringify(value.slice(0, 40))}… (${value.length} chars)` : JSON.stringify(value);
	}
	if (Array.isArray(value)) return `array(${value.length})`;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	return typeof value;
}

/** Sorted, capped list of legal names. */
function list(names: Iterable<string>): string {
	const sorted = [...names].sort();
	if (sorted.length === 0) return "(none)";
	const shown = sorted.slice(0, MAX_KNOWN_SHOWN).join(", ");
	return sorted.length > MAX_KNOWN_SHOWN ? `${shown}, … (${sorted.length - MAX_KNOWN_SHOWN} more)` : shown;
}

/**
 * First cycle reachable from `roots` in root order, as `a -> b -> a`; null if acyclic.
 * Self-loops are skipped: callers report self-references with their own message.
 */
function findCycle(roots: readonly string[], next: (node: string) => readonly string[]): readonly string[] | null {
	const done = new Set<string>();
	const path: string[] = [];
	const visit = (node: string): readonly string[] | null => {
		const start = path.indexOf(node);
		if (start !== -1) return [...path.slice(start), node];
		if (done.has(node)) return null;
		path.push(node);
		for (const child of next(node)) {
			if (child === node) continue;
			const cycle = visit(child);
			if (cycle !== null) return cycle;
		}
		path.pop();
		done.add(node);
		return null;
	};
	for (const root of roots) {
		const cycle = visit(root);
		if (cycle !== null) return cycle;
	}
	return null;
}

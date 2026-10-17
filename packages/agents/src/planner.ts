/**
 * Planner agent: goal → validated `PlanDraft`, in two stages so references are indices the schema
 * constrains: A writes tasks (`after` = earlier task indices), B the skills they need (`neededBy` =
 * task indices). Each stage is normalized, checked against its schema and core `validateDraft`, and
 * repaired in its own bounded loop that names every bad value (PLAN.md §5, "Agents propose only").
 * The draft is a proposal; only the user can approve it.
 */
import {
	type DraftSkill,
	type DraftTask,
	type KernelState,
	type Likert,
	type PlanDraft,
	type Requirement,
	type SkillKey,
	type TargetLevel,
	validateDraft,
} from "@dawnskill/core";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { dedupeSkills } from "./dedupe.ts";
import { buildSkillsPrompt, buildTasksPrompt, type PlannerInput, type PlannerPrompt } from "./prompt.ts";
import { type ChatProvider, ContextSizeError, TruncatedReplyError } from "./provider.ts";
import { skillsSchema, TASKS_SCHEMA } from "./schema.ts";

const DEFAULT_MAX_REPAIRS = 2;
/** Reply budget per stage; the provider caps it at its configured `maxTokens`. */
const STAGE_MAX_TOKENS = 8192;
const MAX_SKILL_KEY = 64;
/** Kernel limit for `PlanDraft.goal` (core `validateDraft`). */
const MAX_GOAL = 200;

export interface PlanResult {
	readonly draft: PlanDraft;
	/** Plan generations used across both stages, repairs included. Skill-judge calls are not counted. */
	readonly attempts: number;
	/** Draft skill key → existing key it was merged into by deduplication. */
	readonly remapped: Readonly<Record<SkillKey, SkillKey>>;
}

export class PlannerError extends Error {
	readonly errors: readonly string[];
	readonly attempts: number;

	constructor(errors: readonly string[], attempts: number, message?: string) {
		const shown = errors.slice(0, 3).join("; ");
		const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : "";
		super(message ?? `planner output still invalid after ${attempts} attempt(s): ${shown}${more}`);
		this.name = "PlannerError";
		this.errors = errors;
		this.attempts = attempts;
	}
}

type Checked<T> =
	| { readonly ok: true; readonly value: T }
	/** `shown`: what the repair turn quotes back, the normalized JSON or the raw text that did not parse. */
	| { readonly ok: false; readonly shown: string; readonly errors: readonly string[] };

interface TasksStage {
	readonly goal: string;
	readonly summary: string;
	readonly tasks: readonly DraftTask[];
}

export type PlannerStage = "tasks" | "skills" | "dedupe";
export type PlannerStreamEvent =
	| { readonly type: "request"; readonly stage: PlannerStage } // before every model request, repairs included
	| { readonly type: "delta"; readonly reasoning: string; readonly content: string };

export async function planGoal(
	provider: ChatProvider,
	state: KernelState,
	input: PlannerInput,
	options: {
		readonly maxRepairs?: number;
		readonly signal?: AbortSignal;
		/** Hears each model request as it starts and each chunk its reply streams. */
		readonly onStream?: (event: PlannerStreamEvent) => void;
	} = {},
): Promise<PlanResult> {
	const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;
	if (!Number.isInteger(maxRepairs) || maxRepairs < 0) {
		throw new RangeError(`maxRepairs = ${maxRepairs}; legal: integer >= 0`);
	}
	// The goal is the user's: the model never rewrites it. Cut to the kernel's 200-char limit.
	const goal = input.goal.trim().slice(0, MAX_GOAL);
	if (goal === "") throw new RangeError("goal is empty; legal: non-empty text");
	let attempts = 0;
	const onStream = options.onStream;
	// Every request (stages, repairs, judge calls) goes through this, so `onStream` hears them all.
	const model: ChatProvider =
		onStream === undefined
			? provider
			: {
					model: provider.model,
					completeJson(request, signal) {
						const stage: PlannerStage =
							request.schemaName === "plan_tasks"
								? "tasks"
								: request.schemaName === "plan_skills"
									? "skills"
									: "dedupe";
						onStream({ type: "request", stage });
						return provider.completeJson(request, signal, (delta) =>
							onStream({ type: "delta", reasoning: delta.reasoning, content: delta.content }),
						);
					},
				};
	/** One stage: generate, check, repair. `items` names what to cap after a truncated reply. */
	const generate = async <T>(
		prompt: PlannerPrompt,
		schemaName: string,
		schema: TSchema,
		items: string,
		check: (raw: string) => Checked<T>,
	): Promise<T> => {
		let user = prompt.user;
		for (let repairs = 0; ; repairs++) {
			attempts++;
			const request = { system: prompt.system, user, schemaName, schema, maxTokens: STAGE_MAX_TOKENS };
			let raw: string;
			try {
				raw = await model.completeJson(request, options.signal);
			} catch (error) {
				if (error instanceof ContextSizeError) throw new PlannerError([error.message], attempts, error.message);
				if (!(error instanceof TruncatedReplyError)) throw error;
				if (repairs === maxRepairs) throw new PlannerError([error.message], attempts);
				// Echoing a runaway reply would only fill the context: restate the request and ask for less.
				user = [
					prompt.user,
					"",
					`Your previous reply was cut off before the JSON ended. Reply again with the same structure, shorter: at most 8 ${items}, one sentence per text field.`,
				].join("\n");
				continue;
			}
			const checked = check(raw);
			if (checked.ok) return checked.value;
			if (repairs === maxRepairs) throw new PlannerError(checked.errors, attempts);
			user = repairMessage(checked.shown, checked.errors);
		}
	};

	const stage = await generate(buildTasksPrompt(state, input), "plan_tasks", TASKS_SCHEMA, "tasks", (raw) =>
		checkTasks(state, goal, raw),
	);
	const draft = await generate(
		buildSkillsPrompt(stage.goal, stage.tasks),
		"plan_skills",
		skillsSchema(stage.tasks.length),
		"skills",
		(raw) => checkSkills(state, stage, raw),
	);
	// Final gate: both stages passed, so this only fails if assembly itself is wrong.
	const errors = validateDraft(state, draft);
	if (errors.length > 0) throw new PlannerError(errors, attempts);
	const deduped = await dedupeSkills(model, state, draft, options.signal);
	return { draft: deduped.draft, attempts, remapped: deduped.remapped };
}

function repairMessage(shown: string, errors: readonly string[]): string {
	return [
		"Your previous answer:",
		shown,
		"It failed validation:",
		...errors.map((error, i) => `${i + 1}. ${error}`),
		"Fix every error and return the corrected JSON: the complete answer, not only the changed parts.",
	].join("\n");
}

function parse(raw: string): { readonly ok: true; readonly value: unknown } | Checked<never> {
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, shown: raw, errors: [`response is not valid JSON: ${reason}`] };
	}
}

/** Stage A: tasks get refs `t1..tn`; `after` keeps only earlier indices, so dependencies are always a DAG. */
function checkTasks(state: KernelState, goal: string, raw: string): Checked<TasksStage> {
	const parsed = parse(raw);
	if (!parsed.ok) return parsed;
	const value = trimDeep(parsed.value);
	if (isRecord(value) && Array.isArray(value.tasks)) {
		value.tasks.forEach((task, i) => {
			if (!isRecord(task)) return;
			if (typeof task.estimateMinutes === "number") task.estimateMinutes = Math.round(task.estimateMinutes);
			// Categories key the estimate reference classes: "Data Processing" and "data processing" are one class.
			if (typeof task.category === "string") task.category = task.category.toLowerCase();
			if (Array.isArray(task.after)) {
				task.after = [...new Set(task.after)].filter((a) => Number.isInteger(a) && a >= 0 && a < i);
			}
		});
	}
	const shown = JSON.stringify(value);
	if (!Value.Check(TASKS_SCHEMA, value)) return { ok: false, shown, errors: schemaErrors(TASKS_SCHEMA, value) };
	const stage: TasksStage = {
		goal,
		summary: value.summary,
		tasks: value.tasks.map((t, i) => ({
			ref: `t${i + 1}`,
			title: t.title,
			notes: t.notes,
			doneWhen: t.doneWhen,
			category: t.category,
			estimateMinutes: t.estimateMinutes,
			// The schema bounds both to 1..5.
			importance: t.importance as Likert,
			urgency: t.urgency as Likert,
			requires: [],
			after: t.after.map((a) => `t${a + 1}`),
		})),
	};
	const errors = validateDraft(state, { ...stage, skills: [] });
	return errors.length === 0 ? { ok: true, value: stage } : { ok: false, shown, errors };
}

/**
 * Stage B: skills with the task indices that need them. Requirements are derived from `neededBy`
 * (highest level per task and skill). An entry whose key exactly matches a known skill reuses it: it is
 * filled from state for validation and left out of the draft. Prerequisites are hints: unknown keys are dropped.
 */
function checkSkills(state: KernelState, stage: TasksStage, raw: string): Checked<PlanDraft> {
	const parsed = parse(raw);
	if (!parsed.ok) return parsed;
	const value = trimDeep(parsed.value);
	const entries = isRecord(value) && Array.isArray(value.skills) ? value.skills.filter(isRecord) : [];
	for (const skill of entries) normalizeSkill(skill);
	const known = new Set([...entries.map((s) => s.key), ...Object.keys(state.skills)]);
	for (const skill of entries) {
		if (Array.isArray(skill.prerequisites)) {
			skill.prerequisites = skill.prerequisites.filter((key) => key !== skill.key && known.has(key));
		}
	}
	const shown = JSON.stringify(value);
	const schema = skillsSchema(stage.tasks.length);
	if (!Value.Check(schema, value)) return { ok: false, shown, errors: schemaErrors(schema, value) };

	const requires = stage.tasks.map(() => new Map<SkillKey, TargetLevel>());
	const skills: DraftSkill[] = value.skills.map(({ neededBy, ...skill }) => {
		for (const { task, level } of neededBy) {
			const needs = requires[task];
			// The schema's enums bound `task` to the task indices and `level` to 1..5.
			if (needs !== undefined && level > (needs.get(skill.key) ?? 0)) needs.set(skill.key, level as TargetLevel);
		}
		const existing = state.skills[skill.key];
		if (existing === undefined) return skill;
		const { key, name, description, concepts, prerequisites, resources, retrievalPrompts, practiceMinutes } = existing;
		return { key, name, description, concepts, prerequisites, resources, retrievalPrompts, practiceMinutes };
	});
	const tasks = stage.tasks.map((task, i) => ({
		...task,
		requires: [...(requires[i] ?? [])].map(([skill, level]): Requirement => ({ skill, level })),
	}));
	const errors = validateDraft(state, { goal: stage.goal, summary: stage.summary, skills, tasks });
	if (errors.length > 0) return { ok: false, shown, errors };
	const draft: PlanDraft = {
		goal: stage.goal,
		summary: stage.summary,
		skills: skills.filter((skill) => !Object.hasOwn(state.skills, skill.key)),
		tasks,
	};
	return { ok: true, value: draft };
}

/** Schema violations as `path = value: message`, in the same path style as core `validateDraft`. */
function schemaErrors(schema: TSchema, value: unknown): readonly string[] {
	const out: string[] = [];
	for (const error of Value.Errors(schema, value)) {
		// `additionalProperties: false` also reports each extra property as "schema is false"; the summary below names them all.
		if (error.keyword === "boolean") continue;
		const segments = error.instancePath
			.split("/")
			.slice(1)
			.map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
		const path =
			segments.reduce((acc, s) => (/^\d+$/.test(s) ? `${acc}[${s}]` : acc === "" ? s : `${acc}.${s}`), "") || "(root)";
		if (error.keyword === "additionalProperties") {
			const extra = error.params.additionalProperties.join(", ");
			out.push(`${path} has unknown properties ${extra}; legal: only the schema's properties, remove them`);
			continue;
		}
		if (error.keyword === "required") {
			out.push(`${path}: ${error.message}`);
			continue;
		}
		const bad = segments.reduce<unknown>(
			(acc, s) => (typeof acc === "object" && acc !== null ? Reflect.get(acc, s) : undefined),
			value,
		);
		out.push(`${path} = ${show(bad)}: ${error.message}`);
	}
	return [...new Set(out)];
}

function show(value: unknown): string {
	if (typeof value === "string") {
		return value.length > 40 ? `${JSON.stringify(value.slice(0, 40))}… (${value.length} chars)` : JSON.stringify(value);
	}
	if (Array.isArray(value)) return `array(${value.length})`;
	if (value === undefined || value === null || typeof value !== "object") return String(value);
	return "object";
}

// ---------------------------------------------------------------------------------------------
// Normalization: only changes that cannot alter meaning. Anything else is left for validation.

/** Slugifies the key and prerequisites, rounds minutes, dedupes texts, drops non-http(s) resources. Absent fields stay absent. */
function normalizeSkill(skill: Record<string, unknown>): void {
	if (typeof skill.key === "string") skill.key = slugify(skill.key);
	if (typeof skill.practiceMinutes === "number") skill.practiceMinutes = Math.round(skill.practiceMinutes);
	for (const field of ["concepts", "retrievalPrompts"]) {
		const texts = skill[field];
		if (Array.isArray(texts)) skill[field] = [...new Set(texts)].filter((text) => text !== "");
	}
	if (Array.isArray(skill.prerequisites)) {
		skill.prerequisites = [
			...new Set(skill.prerequisites.map((key) => (typeof key === "string" ? slugify(key) : key))),
		];
	}
	if (Array.isArray(skill.resources)) {
		skill.resources = skill.resources.filter(
			(resource) => isRecord(resource) && typeof resource.url === "string" && /^https?:\/\//i.test(resource.url),
		);
	}
}

/**
 * Lowercase kebab-case key (docs/learning-model.md §2). Valid keys are fixed points, so applying it
 * to keys and references alike keeps every reference consistent. Empty results keep the input so
 * validation reports it.
 */
function slugify(key: string): string {
	const slug = key
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replaceAll("+", "p")
		.replaceAll("#", "sharp")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SKILL_KEY)
		.replace(/-+$/, "");
	return slug === "" ? key : slug;
}

/** Fresh containers with every string trimmed, so later in-place edits never touch the parsed input. */
function trimDeep(value: unknown): unknown {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return value.map(trimDeep);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimDeep(v)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

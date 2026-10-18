/**
 * Planner agent: goal → validated `PlanDraft`, in stages so references are indices the schema
 * constrains. Supplied sources are first reduced to a curriculum (the study resources they
 * recommend); A writes tasks (`after` = earlier task indices), B the skills they need or develop
 * (`neededBy`/`developedBy` = task indices). Uncapped plans run A and B in batches. Each request is
 * normalized, checked against its schema and core `validateDraft`, and repaired in its own bounded
 * loop that names every bad value (PLAN.md §5, "Agents propose only").
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
import { type CurriculumItem, chunkText, halveChunk, MAX_CHUNK, mergeItems } from "./extract.ts";
import {
	buildExtractPrompt,
	buildSkillsPrompt,
	buildTasksPrompt,
	type PlannerInput,
	type PlannerPrompt,
	type PlannerSource,
} from "./prompt.ts";
import { type ChatProvider, ContextSizeError, TruncatedReplyError } from "./provider.ts";
import {
	EXTRACT_SCHEMA,
	MAX_SKILLS,
	MAX_TASK_MINUTES,
	MAX_TASKS,
	MAX_UNCAPPED_TASK_MINUTES,
	skillsSchema,
	tasksSchema,
} from "./schema.ts";

const DEFAULT_MAX_REPAIRS = 2;
const MAX_SKILL_KEY = 64;
/** Kernel limit for `PlanDraft.goal` (core `validateDraft`). */
const MAX_GOAL = 200;
/** Uncapped plans: curriculum items per tasks request, tasks per item at most, tasks per skills request. */
const ITEMS_PER_REQUEST = 8;
const TASKS_PER_ITEM = 3;
const TASKS_PER_SKILLS_REQUEST = 8;

export interface PlanResult {
	readonly draft: PlanDraft;
	/** Plan generations used across all stages, repairs included. Skill-judge calls are not counted. */
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

/** Repairs and truncation splits spent on one request and every half split off it. */
interface Budget {
	repairs: number;
}

/** A truncated reply whose request the caller splits instead of retrying. */
const TRUNCATED: unique symbol = Symbol("truncated");

/** One stage A reply: `summary` is null when the request did not ask for one. */
interface TasksReply {
	readonly summary: string | null;
	readonly tasks: readonly DraftTask[];
}

interface TasksStage {
	readonly goal: string;
	readonly summary: string;
	readonly tasks: readonly DraftTask[];
}

/** Skill links of one task: skill → highest level. */
type Links = Map<SkillKey, TargetLevel>;

/** One stage B reply: its skills (state skills filled from state) and the links of its tasks. */
interface SkillsReply {
	readonly skills: readonly DraftSkill[];
	readonly requires: ReadonlyMap<number, Links>;
	readonly develops: ReadonlyMap<number, Links>;
}

export type PlannerStage = "extract" | "tasks" | "skills" | "dedupe";
export type PlannerStreamEvent =
	| { readonly type: "request"; readonly stage: PlannerStage } // before every model request, repairs included
	| { readonly type: "delta"; readonly reasoning: string; readonly content: string };

const STAGES: Readonly<Record<string, PlannerStage>> = {
	plan_extract: "extract",
	plan_tasks: "tasks",
	plan_skills: "skills",
};

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
						onStream({ type: "request", stage: STAGES[request.schemaName] ?? "dedupe" });
						return provider.completeJson(request, signal, (delta) =>
							onStream({ type: "delta", reasoning: delta.reasoning, content: delta.content }),
						);
					},
				};
	/**
	 * One request: generate, check, repair. After a truncated reply it retries asking for a reply
	 * `shorter` as described, or returns `TRUNCATED` when `shorter` is null so the caller splits the request.
	 * A reply that was all thinking is retried once unchanged; a second one fails.
	 */
	const generate = async <T>(
		prompt: PlannerPrompt,
		schemaName: string,
		schema: TSchema,
		check: (raw: string) => Checked<T>,
		budget: Budget,
		shorter: string | null,
	): Promise<T | typeof TRUNCATED> => {
		let user = prompt.user;
		let thinkingRetried = false;
		for (;;) {
			attempts++;
			// No maxTokens: the configured reply budget applies (reasoning models need all of it).
			const request = { system: prompt.system, user, schemaName, schema };
			let raw: string;
			try {
				raw = await model.completeJson(request, options.signal);
			} catch (error) {
				if (error instanceof ContextSizeError) throw new PlannerError([error.message], attempts, error.message);
				if (!(error instanceof TruncatedReplyError)) throw error;
				// Thinking alone filled the reply budget: halving or asking for less cannot help, but runaway
				// thinking is stochastic, so the identical request is retried once outside the repair budget.
				if (error.thinkingOnly) {
					if (thinkingRetried) throw new PlannerError([error.message], attempts, error.message);
					thinkingRetried = true;
					continue;
				}
				if (budget.repairs === maxRepairs) throw new PlannerError([error.message], attempts);
				budget.repairs++;
				if (shorter === null) return TRUNCATED;
				// Echoing a runaway reply would only fill the context: restate the request and ask for less.
				user = [
					prompt.user,
					"",
					`Your previous reply was cut off before the JSON ended. Reply again with the same structure, shorter: ${shorter}.`,
				].join("\n");
				continue;
			}
			const checked = check(raw);
			if (checked.ok) return checked.value;
			if (budget.repairs === maxRepairs) throw new PlannerError(checked.errors, attempts);
			budget.repairs++;
			// The original request stays: without it the model no longer sees the tasks, items or text it answered.
			user = `${prompt.user}\n\n${repairMessage(checked.shown, checked.errors)}`;
		}
	};
	/**
	 * Runs one request per unit, in order. A unit whose reply is truncated is replaced by its halves,
	 * which share its repair budget; a unit that cannot be halved is retried with a `shorter` reply.
	 */
	const inOrder = async <U, T>(
		units: readonly U[],
		halve: (unit: U) => readonly U[] | null,
		shorter: string,
		run: (unit: U, budget: Budget, shorter: string | null) => Promise<T | typeof TRUNCATED>,
		apply: (value: T) => void,
	): Promise<void> => {
		const queue = units.map((unit) => ({ unit, budget: { repairs: 0 } }));
		for (;;) {
			const next = queue.shift();
			if (next === undefined) return;
			const halves = halve(next.unit);
			const value = await run(next.unit, next.budget, halves === null ? shorter : null);
			if (value === TRUNCATED) queue.unshift(...(halves ?? []).map((unit) => ({ unit, budget: next.budget })));
			else apply(value);
		}
	};

	// Extraction: the curriculum the sources recommend. Uncapped plans read the context as one more source.
	const context = input.context.trim();
	const sources: readonly PlannerSource[] = [
		...input.sources,
		...(input.uncapped && context !== "" ? [{ url: "context", title: "Context", text: context }] : []),
	];
	const found: CurriculumItem[] = [];
	for (const source of sources) {
		await inOrder(
			chunkText(source.text, MAX_CHUNK),
			halveChunk,
			"one short sentence per note",
			(chunk, budget, shorter) =>
				generate(
					buildExtractPrompt(source, chunk),
					"plan_extract",
					EXTRACT_SCHEMA,
					(raw) => checkExtract(source.url, raw),
					budget,
					shorter,
				),
			(items) => found.push(...items),
		);
	}
	const curriculum = mergeItems(found);

	// Stage A. An uncapped curriculum is planned a few items per request; anything else in one request.
	let summary = "";
	const tasks: DraftTask[] = [];
	const addTasks = (reply: TasksReply) => {
		if (reply.summary !== null) summary = reply.summary;
		tasks.push(...reply.tasks);
	};
	if (input.uncapped && curriculum.length > 0) {
		const batches = Array.from({ length: Math.ceil(curriculum.length / ITEMS_PER_REQUEST) }, (_, n) => ({
			first: n * ITEMS_PER_REQUEST,
			count: Math.min(ITEMS_PER_REQUEST, curriculum.length - n * ITEMS_PER_REQUEST),
		}));
		await inOrder(
			batches,
			({ first, count }) => {
				const half = Math.floor(count / 2);
				return count < 2
					? null
					: [
							{ first, count: half },
							{ first: first + half, count: count - half },
						];
			},
			"one sentence per text field",
			({ first, count }, budget, shorter) => {
				const items = Array.from({ length: count }, (_, i) => first + i + 1);
				const schema = tasksSchema({
					minTasks: count,
					maxTasks: count * TASKS_PER_ITEM,
					firstIndex: tasks.length,
					maxMinutes: MAX_UNCAPPED_TASK_MINUTES,
					summary: tasks.length === 0,
					items,
				});
				return generate(
					buildTasksPrompt(state, input, curriculum, { first, count, planned: tasks }),
					"plan_tasks",
					schema,
					(raw) => checkTasks(state, goal, raw, schema, tasks, items),
					budget,
					shorter,
				);
			},
			addTasks,
		);
	} else {
		const schema = tasksSchema({
			minTasks: 3,
			maxTasks: input.uncapped ? null : MAX_TASKS,
			firstIndex: 0,
			maxMinutes: input.uncapped ? MAX_UNCAPPED_TASK_MINUTES : MAX_TASK_MINUTES,
			summary: true,
			items: null,
		});
		await inOrder(
			[null],
			() => null,
			input.uncapped
				? "fewer, larger tasks, one sentence per text field"
				: "at most 8 tasks, one sentence per text field",
			(_, budget, shorter) =>
				generate(
					buildTasksPrompt(state, input, curriculum),
					"plan_tasks",
					schema,
					(raw) => checkTasks(state, goal, raw, schema, [], null),
					budget,
					shorter,
				),
			addTasks,
		);
	}
	const stage: TasksStage = { goal, summary, tasks };

	// Stage B. Uncapped plans ask in batches of tasks; later batches see the skills defined so far.
	const defined = new Map<SkillKey, DraftSkill>();
	const requires = new Map<number, Links>();
	const develops = new Map<number, Links>();
	const indices = tasks.map((_, i) => i);
	const batchSize = input.uncapped ? TASKS_PER_SKILLS_REQUEST : indices.length;
	const batches = Array.from({ length: Math.ceil(indices.length / batchSize) }, (_, n) =>
		indices.slice(n * batchSize, (n + 1) * batchSize),
	);
	const maxSkills = input.uncapped ? null : MAX_SKILLS;
	await inOrder(
		batches,
		(batch) => {
			const half = Math.floor(batch.length / 2);
			return input.uncapped && batch.length > 1 ? [batch.slice(0, half), batch.slice(half)] : null;
		},
		"at most 8 skills, one sentence per text field",
		(batch, budget, shorter) =>
			generate(
				buildSkillsPrompt(
					goal,
					batch.map((index) => ({ index, title: tasks[index]?.title ?? "", doneWhen: tasks[index]?.doneWhen ?? "" })),
					[...defined.values()].map(({ key, name }) => ({ key, name })),
				),
				"plan_skills",
				skillsSchema(batch, maxSkills),
				(raw) => checkSkills(state, stage, batch, maxSkills, { defined, requires, develops }, raw),
				budget,
				shorter,
			),
		(reply) => {
			// Merged by key: the first definition keeps its fields, links accumulate.
			for (const skill of reply.skills) if (!defined.has(skill.key)) defined.set(skill.key, skill);
			for (const [task, links] of reply.requires) requires.set(task, links);
			for (const [task, links] of reply.develops) develops.set(task, links);
		},
	);
	const draft: PlanDraft = {
		goal,
		summary,
		skills: [...defined.values()].filter((skill) => !Object.hasOwn(state.skills, skill.key)),
		tasks: tasks.map((task, i) => withLinks(task, requires.get(i), develops.get(i))),
	};
	// Final gate: every request passed, so this only fails if assembly itself is wrong.
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

/** Extraction: the resources of one chunk, tagged with their source. Items without a title are dropped. */
function checkExtract(source: string, raw: string): Checked<readonly CurriculumItem[]> {
	const parsed = parse(raw);
	if (!parsed.ok) return parsed;
	const value = trimDeep(parsed.value);
	if (isRecord(value) && Array.isArray(value.items)) {
		const items = value.items.filter((item) => !isRecord(item) || item.title !== "");
		for (const item of items) {
			if (isRecord(item) && typeof item.kind === "string") item.kind = item.kind.toLowerCase();
		}
		value.items = items;
	}
	if (!Value.Check(EXTRACT_SCHEMA, value)) {
		return { ok: false, shown: JSON.stringify(value), errors: schemaErrors(EXTRACT_SCHEMA, value) };
	}
	return { ok: true, value: value.items.map((item) => ({ source, ...item })) };
}

/**
 * Stage A: the reply's tasks continue `planned` with refs `t<n+1>` for global index n; `after` keeps
 * only earlier indices, so dependencies are always a DAG. `items`: curriculum item numbers that
 * each need a task, or null.
 */
function checkTasks(
	state: KernelState,
	goal: string,
	raw: string,
	schema: TSchema,
	planned: readonly DraftTask[],
	items: readonly number[] | null,
): Checked<TasksReply> {
	const parsed = parse(raw);
	if (!parsed.ok) return parsed;
	const first = planned.length;
	const value = trimDeep(parsed.value);
	if (isRecord(value) && Array.isArray(value.tasks)) {
		value.tasks.forEach((task, i) => {
			if (!isRecord(task)) return;
			if (typeof task.estimateMinutes === "number") task.estimateMinutes = Math.round(task.estimateMinutes);
			// Categories key the estimate reference classes: "Data Processing" and "data processing" are one class.
			if (typeof task.category === "string") task.category = task.category.toLowerCase();
			if (Array.isArray(task.after)) {
				task.after = [...new Set(task.after)].filter((a) => Number.isInteger(a) && a >= 0 && a < first + i);
			}
		});
	}
	const shown = JSON.stringify(value);
	if (!Value.Check(schema, value)) return { ok: false, shown, errors: schemaErrors(schema, value) };
	const reply = value as {
		readonly summary?: string;
		readonly tasks: readonly {
			readonly item?: number;
			readonly title: string;
			readonly doneWhen: string;
			readonly notes: string;
			readonly category: string;
			readonly estimateMinutes: number;
			readonly importance: number;
			readonly urgency: number;
			readonly after: readonly number[];
		}[];
	};
	const missing = (items ?? []).filter((n) => !reply.tasks.some((t) => t.item === n));
	if (missing.length > 0) {
		return {
			ok: false,
			shown,
			errors: [
				`curriculum items ${missing.join(", ")} have no task; legal: at least one task per item, with item set to its number`,
			],
		};
	}
	const tasks = reply.tasks.map(
		(t, i): DraftTask => ({
			ref: `t${first + i + 1}`,
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
		}),
	);
	const summary = reply.summary ?? null;
	const errors = validateDraft(state, { goal, summary: summary ?? "", skills: [], tasks: [...planned, ...tasks] })
		// The reply numbers its own tasks from 0.
		.map((error) => error.replace(/^tasks\[(\d+)\]/, (_, n: string) => `tasks[${Number(n) - first}]`));
	return errors.length === 0 ? { ok: true, value: { summary, tasks } } : { ok: false, shown, errors };
}

/**
 * Stage B: skills with the indices of the tasks (`batch`) that need or develop them. Requirements
 * come from `neededBy`, `develops` from `developedBy` (highest level per task and skill). An entry whose
 * key exactly matches a known skill reuses it: it is filled from state for validation and left out of
 * the draft. Skills linked to no task are dropped. Prerequisites are hints: unknown keys are dropped.
 * `earlier`: what previous batches produced.
 */
function checkSkills(
	state: KernelState,
	stage: TasksStage,
	batch: readonly number[],
	maxSkills: number | null,
	earlier: {
		readonly defined: ReadonlyMap<SkillKey, DraftSkill>;
		readonly requires: ReadonlyMap<number, Links>;
		readonly develops: ReadonlyMap<number, Links>;
	},
	raw: string,
): Checked<SkillsReply> {
	const parsed = parse(raw);
	if (!parsed.ok) return parsed;
	const value = trimDeep(parsed.value);
	let entries = isRecord(value) && Array.isArray(value.skills) ? value.skills.filter(isRecord) : [];
	const unlinked = (skill: Record<string, unknown>) =>
		Array.isArray(skill.neededBy) &&
		skill.neededBy.length === 0 &&
		Array.isArray(skill.developedBy) &&
		skill.developedBy.length === 0;
	// A skill linked to no task cannot change the plan: it is dropped before prerequisites are resolved, so
	// references to it go too. A reply with no linked skill at all missed the links and is repaired instead.
	if (isRecord(value) && Array.isArray(value.skills) && entries.some((skill) => !unlinked(skill))) {
		value.skills = value.skills.filter((skill) => !isRecord(skill) || !unlinked(skill));
		entries = entries.filter((skill) => !unlinked(skill));
	}
	for (const skill of entries) normalizeSkill(skill);
	const known = new Set([...entries.map((s) => s.key), ...earlier.defined.keys(), ...Object.keys(state.skills)]);
	for (const skill of entries) {
		if (Array.isArray(skill.prerequisites)) {
			skill.prerequisites = skill.prerequisites.filter((key) => key !== skill.key && known.has(key));
		}
	}
	const shown = JSON.stringify(value);
	const schema = skillsSchema(batch, maxSkills);
	if (!Value.Check(schema, value)) return { ok: false, shown, errors: schemaErrors(schema, value) };
	const missing = value.skills.flatMap((skill, i) =>
		skill.neededBy.length === 0 && skill.developedBy.length === 0
			? [`skills[${i}] has empty neededBy and developedBy; legal: at least one task in either`]
			: [],
	);
	if (missing.length > 0) return { ok: false, shown, errors: missing };

	const requires = new Map(batch.map((i): [number, Links] => [i, new Map()]));
	const develops = new Map(batch.map((i): [number, Links] => [i, new Map()]));
	const link = (links: ReadonlyMap<number, Links>, key: SkillKey, task: number, level: number) => {
		const own = links.get(task);
		// The schema's enums bound `task` to the batch's indices and `level` to 1..5.
		if (own !== undefined && level > (own.get(key) ?? 0)) own.set(key, level as TargetLevel);
	};
	const skills: DraftSkill[] = value.skills.map(({ neededBy, developedBy, ...skill }) => {
		for (const { task, level } of neededBy) link(requires, skill.key, task, level);
		for (const { task, level } of developedBy) link(develops, skill.key, task, level);
		const existing = state.skills[skill.key];
		if (existing === undefined) return skill;
		const { key, name, description, concepts, prerequisites, resources, retrievalPrompts, practiceMinutes } = existing;
		return { key, name, description, concepts, prerequisites, resources, retrievalPrompts, practiceMinutes };
	});
	// Validated as the plan so far: this reply's skills first, so `skills[i]` paths match the reply.
	const keys = new Set(skills.map((skill) => skill.key));
	const errors = validateDraft(state, {
		goal: stage.goal,
		summary: stage.summary,
		skills: [...skills, ...[...earlier.defined.values()].filter((skill) => !keys.has(skill.key))],
		tasks: stage.tasks.map((task, i) =>
			withLinks(task, requires.get(i) ?? earlier.requires.get(i), develops.get(i) ?? earlier.develops.get(i)),
		),
	});
	return errors.length === 0 ? { ok: true, value: { skills, requires, develops } } : { ok: false, shown, errors };
}

/** `task` with its skill links; `develops` is left out when empty. */
function withLinks(task: DraftTask, requires: Links | undefined, develops: Links | undefined): DraftTask {
	const toRequirements = (links: Links | undefined) =>
		[...(links ?? [])].map(([skill, level]): Requirement => ({ skill, level }));
	const developed = toRequirements(develops);
	return { ...task, requires: toRequirements(requires), ...(developed.length > 0 ? { develops: developed } : {}) };
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

/**
 * JSON Schemas for the planner stages. Extraction lists a source's study resources, stage A writes
 * tasks, stage B the skills they need or develop. References are indices constrained by the schema
 * itself (`after` → earlier tasks, `neededBy.task`/`developedBy.task` → an `enum` of the task indices),
 * so grammar-constrained decoding cannot invent a dangling one.
 * Strict-mode compatible: every property required, no additional properties, no length keywords.
 * Bounds mirror core `validateDraft` plus the planner rules in docs/learning-model.md §2.
 */
import { Type } from "typebox";

/** Prompt guidance and schema cap of a capped plan: a goal is 3–12 concrete tasks. */
export const MAX_TASKS = 12;
/** Skills per capped plan. Uncapped plans have no skill cap. */
export const MAX_SKILLS = 30;
/** Estimate cap of a capped plan's task: longer work is split. Uncapped tasks may span a whole resource. */
export const MAX_TASK_MINUTES = 480;
/** Core `validateDraft` bound on `estimateMinutes`. */
export const MAX_UNCAPPED_TASK_MINUTES = 100_000;

const RESOURCE_KINDS = [
	"book",
	"course",
	"lecture-notes",
	"video",
	"article",
	"paper",
	"problem-set",
	"website",
	"other",
] as const;

/** Extraction: every study resource a page (chunk) recommends, in page order. */
export const EXTRACT_SCHEMA = Type.Object(
	{
		items: Type.Array(
			Type.Object(
				{
					section: Type.String({ description: "Nearest heading above the item, verbatim; empty if none." }),
					title: Type.String({ description: "Title verbatim as on the page." }),
					creator: Type.String({ description: "Author(s), lecturer or publisher; empty if none." }),
					kind: Type.String({ enum: [...RESOURCE_KINDS], description: "Kind of resource." }),
					level: Type.String({ description: "Level the page gives, e.g. introductory; empty if none." }),
					note: Type.String({ description: "What the page says about it, incl. companion material; may be empty." }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/**
 * Stage A schema for one request whose tasks get global indices `firstIndex..`. `maxTasks: null`
 * leaves the count open. `items`: curriculum item numbers this request covers; each task names one.
 * `summary`: only the first request of a plan writes it.
 */
export function tasksSchema(options: {
	readonly minTasks: number;
	readonly maxTasks: number | null;
	readonly firstIndex: number;
	readonly maxMinutes: number;
	readonly summary: boolean;
	readonly items: readonly number[] | null;
}) {
	const { minTasks, maxTasks, firstIndex, maxMinutes, summary, items } = options;
	const lastIndex = maxTasks === null ? null : firstIndex + maxTasks - 1;
	return Type.Object(
		{
			...(summary ? { summary: Type.String({ description: "Two or three sentences on the approach." }) } : {}),
			tasks: Type.Array(
				Type.Object(
					{
						...(items === null
							? {}
							: { item: Type.Integer({ enum: [...items], description: "Number of the curriculum item worked on." }) }),
						title: Type.String({ description: "Imperative, concrete action, at most 200 chars." }),
						doneWhen: Type.String({ description: "Observable, verifiable completion criterion." }),
						notes: Type.String({ description: "Approach hints; may be empty." }),
						category: Type.String({
							description: "Short lowercase kind of work, e.g. coding, reading. Never learning.",
						}),
						estimateMinutes: Type.Integer({
							minimum: 1,
							maximum: maxMinutes,
							description: `Focused minutes, 15–${maxMinutes}.`,
						}),
						importance: Type.Integer({
							minimum: 1,
							maximum: 5,
							description: "1 nice to have … 5 the goal fails without it.",
						}),
						urgency: Type.Integer({ minimum: 1, maximum: 5, description: "1 no time pressure … 5 within days." }),
						after: Type.Array(
							Type.Integer(lastIndex === null ? { minimum: 0 } : { minimum: 0, maximum: lastIndex - 1 }),
							{
								...(lastIndex === null ? {} : { maxItems: lastIndex }),
								description: "0-based indices of EARLIER tasks that must finish first; only genuine blockers.",
							},
						),
					},
					{ additionalProperties: false },
				),
				maxTasks === null ? { minItems: minTasks } : { minItems: minTasks, maxItems: maxTasks },
			),
		},
		{ additionalProperties: false },
	);
}

/**
 * Stage B schema for a request about the tasks with global indices `taskIndices`: `neededBy.task`
 * and `developedBy.task` may only name one of them. `maxSkills: null` leaves the count open.
 */
export function skillsSchema(taskIndices: readonly number[], maxSkills: number | null) {
	const links = (description: string, level: string) =>
		Type.Array(
			Type.Object(
				{
					task: Type.Integer({ enum: [...taskIndices], description: "Task index." }),
					level: Type.Integer({ enum: [1, 2, 3, 4, 5], description: level }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 0, maxItems: taskIndices.length, description },
		);
	return Type.Object(
		{
			skills: Type.Array(
				Type.Object(
					{
						key: Type.String({
							pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
							description: "kebab-case, at most 64 chars.",
						}),
						name: Type.String({ description: "<technology or domain>: <capability>" }),
						description: Type.String({ description: "What the skill covers and where it stops." }),
						concepts: Type.Array(Type.String(), { minItems: 2, maxItems: 12, description: "Key ideas to know." }),
						retrievalPrompts: Type.Array(Type.String(), {
							minItems: 2,
							maxItems: 4,
							description: "Questions answered from memory.",
						}),
						practiceMinutes: Type.Integer({ minimum: 5, maximum: 480, description: "Focused minutes per level step." }),
						prerequisites: Type.Array(Type.String(), { maxItems: 10, description: "Keys of skills to learn first." }),
						resources: Type.Array(
							Type.Object({ title: Type.String(), url: Type.String() }, { additionalProperties: false }),
							{ maxItems: 5, description: "Official documentation URLs you are certain exist; else empty." },
						),
						neededBy: links("Tasks that depend on this skill without teaching it.", "Dreyfus level the task needs."),
						developedBy: links(
							"Study or practice tasks that build this skill.",
							"Dreyfus level the task brings the user to.",
						),
					},
					{ additionalProperties: false },
				),
				maxSkills === null ? {} : { maxItems: maxSkills },
			),
		},
		{ additionalProperties: false },
	);
}

/** Same-skill judgement used by skill deduplication. */
export const SAME_SKILL_SCHEMA = Type.Object(
	{ same: Type.Boolean({ description: "True only if both describe the same skill." }) },
	{ additionalProperties: false },
);

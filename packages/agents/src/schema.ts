/**
 * JSON Schemas for the two planner stages. Stage A writes tasks, stage B the skills they need.
 * References are indices constrained by the schema itself (`after` → earlier tasks, `neededBy.task`
 * → an `enum` of the task indices), so grammar-constrained decoding cannot invent a dangling one.
 * Strict-mode compatible: every property required, no additional properties, no length keywords.
 * Bounds mirror core `validateDraft` plus the planner rules in docs/learning-model.md §2.
 */
import { Type } from "typebox";

/** Prompt guidance and schema cap: a goal is 3–12 concrete tasks. */
const MAX_TASKS = 12;

export const TASKS_SCHEMA = Type.Object(
	{
		summary: Type.String({ description: "Two or three sentences on the approach." }),
		tasks: Type.Array(
			Type.Object(
				{
					title: Type.String({ description: "Imperative, concrete action, at most 200 chars." }),
					doneWhen: Type.String({ description: "Observable, verifiable completion criterion." }),
					notes: Type.String({ description: "Approach hints; may be empty." }),
					category: Type.String({ description: "Short lowercase kind of work, e.g. coding. Never learning." }),
					estimateMinutes: Type.Integer({ minimum: 1, maximum: 480, description: "Focused minutes, 15–480." }),
					importance: Type.Integer({
						minimum: 1,
						maximum: 5,
						description: "1 nice to have … 5 the goal fails without it.",
					}),
					urgency: Type.Integer({ minimum: 1, maximum: 5, description: "1 no time pressure … 5 within days." }),
					after: Type.Array(Type.Integer({ minimum: 0, maximum: MAX_TASKS - 2 }), {
						maxItems: MAX_TASKS - 1,
						description: "0-based indices of EARLIER tasks that must finish first; only genuine blockers.",
					}),
				},
				{ additionalProperties: false },
			),
			{ minItems: 3, maxItems: MAX_TASKS },
		),
	},
	{ additionalProperties: false },
);

/** Stage B schema for a plan with `taskCount` tasks: `neededBy.task` may only name one of them. */
export function skillsSchema(taskCount: number) {
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
						neededBy: Type.Array(
							Type.Object(
								{
									task: Type.Integer({
										enum: Array.from({ length: taskCount }, (_, i) => i),
										description: "Task index.",
									}),
									level: Type.Integer({ enum: [1, 2, 3, 4, 5], description: "Dreyfus level the task needs." }),
								},
								{ additionalProperties: false },
							),
							{ minItems: 1, maxItems: taskCount, description: "Tasks that need this skill." },
						),
					},
					{ additionalProperties: false },
				),
				{ maxItems: 30 },
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

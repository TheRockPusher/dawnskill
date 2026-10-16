// Request-body shapes for the HTTP API. They check structure, types and size caps only; the kernel
// (`core.apply`) owns every semantic rule (references, legal transitions, exact field limits).
import { CRITERIA, type Criterion, type EventBody, type Level, type Likert, type TargetLevel } from "@dawnskill/core";
import Type, { type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";

const ID = 64;
const SHORT = 200;
const TEXT = 4000;
const URL_MAX = 2048;
const LIST = 100;

const options = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: ID });
const short = Type.String({ maxLength: SHORT });
const text = Type.String({ maxLength: TEXT });
const minutes = Type.Integer({ minimum: 0, maximum: 1_000_000 });
const likert = Type.Unsafe<Likert>(Type.Integer({ minimum: 1, maximum: 5 }));
const level = Type.Unsafe<Level>(Type.Integer({ minimum: 0, maximum: 5 }));
const targetLevel = Type.Unsafe<TargetLevel>(Type.Integer({ minimum: 1, maximum: 5 }));
const criterion = Type.Unsafe<Criterion>(Type.Union(CRITERIA.map((c) => Type.Literal(c))));
const list = <T extends TSchema>(item: T) => Type.Array(item, { maxItems: LIST });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const resource = Type.Object({ title: short, url: Type.String({ maxLength: URL_MAX }) }, options);
const requirement = Type.Object({ skill: id, level: targetLevel }, options);

const taskFields = {
	goalId: nullable(id),
	title: short,
	notes: text,
	doneWhen: text,
	category: short,
	estimateMinutes: minutes,
	importance: likert,
	urgency: likert,
	requirements: list(requirement),
};

const newTask = Type.Object(taskFields, options);
const taskPatch = Type.Object(
	{
		goalId: Type.Optional(taskFields.goalId),
		title: Type.Optional(taskFields.title),
		notes: Type.Optional(taskFields.notes),
		doneWhen: Type.Optional(taskFields.doneWhen),
		category: Type.Optional(taskFields.category),
		estimateMinutes: Type.Optional(taskFields.estimateMinutes),
		importance: Type.Optional(taskFields.importance),
		urgency: Type.Optional(taskFields.urgency),
		requirements: Type.Optional(taskFields.requirements),
	},
	options,
);

const skillFields = {
	key: id,
	name: short,
	description: text,
	concepts: list(short),
	prerequisites: list(id),
	resources: list(resource),
	retrievalPrompts: list(text),
	practiceMinutes: minutes,
};
const newSkill = Type.Object(skillFields, options);

const draftTask = Type.Object(
	{
		ref: short,
		title: short,
		notes: text,
		doneWhen: text,
		category: short,
		estimateMinutes: minutes,
		importance: likert,
		urgency: likert,
		requires: list(requirement),
		after: list(short),
	},
	options,
);
const planDraft = Type.Object({ goal: short, summary: text, skills: list(newSkill), tasks: list(draftTask) }, options);

const event = <K extends string, P extends Record<string, TSchema>>(type: K, properties: P) =>
	Type.Object({ type: Type.Literal(type), ...properties }, options);
const onTask = { taskId: id };

/** One schema per `EventBody` variant, discriminated by `type`. */
const variants = [
	event("TaskCreated", { task: newTask }),
	event("TaskEdited", { ...onTask, patch: taskPatch }),
	event("TaskStarted", onTask),
	event("TaskPaused", onTask),
	event("TaskCompleted", {
		...onTask,
		actualMinutes: nullable(minutes),
		outcome: text,
		evidenceUrl: nullable(Type.String({ maxLength: URL_MAX })),
	}),
	event("TaskCancelled", { ...onTask, reason: text }),
	event("TaskReopened", onTask),
	event("DependencyAdded", { ...onTask, blockerId: id }),
	event("DependencyRemoved", { ...onTask, blockerId: id }),
	event("LearningStepsAdded", onTask),
	event("SkillCreated", { skill: newSkill }),
	event("SkillSelfRated", { skill: id, level, evidence: text }),
	event("PlanProposed", { draft: planDraft, supersedes: nullable(id) }),
	event("LevelProposed", { skill: id, level: targetLevel, evidence: text }),
	event("ProposalRejected", { proposalId: id, reason: text }),
	event("PlanApproved", { proposalId: id, ratings: Type.Record(Type.String(), level, { maxProperties: LIST }) }),
	event("LevelConfirmed", { proposalId: id, evidence: text }),
	event("ReviewRecorded", { skill: id, recalled: Type.Boolean() }),
	event("PreferencesSet", { criteriaRank: Type.Array(criterion, { maxItems: 5 }) }),
] as const;

const EventBodySchema = Type.Union([...variants]);

/** Body of `POST /api/plan`. */
const PlanRequestSchema = Type.Object(
	{
		goal: Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" }),
		context: Type.Optional(Type.String({ maxLength: 4000 })),
		supersedes: Type.Optional(id),
	},
	options,
);
type PlanRequest = Static<typeof PlanRequestSchema>;

const eventBody = Compile(EventBodySchema);
const variantByType: Readonly<Record<string, Checker>> = Object.fromEntries(
	variants.map((schema) => [schema.properties.type.const, Compile(schema)]),
);
const planRequest = Compile(PlanRequestSchema);

type Parsed<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string; readonly details: readonly string[] };

interface Checker {
	Errors(value: unknown): readonly TLocalizedValidationError[];
}

/** Validates an untrusted `POST /api/events` body. Errors name the offending field as a JSON pointer. */
export function parseEventBody(value: unknown): Parsed<EventBody> {
	if (eventBody.Check(value)) {
		// Assignment doubles as a compile-time check that the schemas match the kernel's EventBody.
		const body: EventBody = value;
		return { ok: true, value: body };
	}
	const type = typeof value === "object" && value !== null && "type" in value ? value.type : undefined;
	const variant = typeof type === "string" && Object.hasOwn(variantByType, type) ? variantByType[type] : undefined;
	if (variant === undefined) {
		const legal = Object.keys(variantByType).join(", ");
		return failure("invalid event", [`/type = ${JSON.stringify(type) ?? "undefined"}; legal: ${legal}`]);
	}
	return failure(`invalid ${String(type)} event`, describe(variant, value));
}

export function parsePlanRequest(value: unknown): Parsed<PlanRequest> {
	if (planRequest.Check(value)) return { ok: true, value };
	return failure("invalid plan request", describe(planRequest, value));
}

function failure(error: string, details: readonly string[]): Parsed<never> {
	return { ok: false, error: details.length > 0 ? `${error}: ${details[0]}` : error, details };
}

const MAX_DETAILS = 20;

function describe(checker: Checker, value: unknown): readonly string[] {
	const details: string[] = [];
	for (const error of checker.Errors(value)) {
		// `additionalProperties: false` reports each extra key twice; keep the one that names it.
		if (error.keyword === "boolean") continue;
		const path = error.instancePath === "" ? "/" : error.instancePath;
		if (error.keyword === "additionalProperties") {
			details.push(`${path}: unknown field(s) ${error.params.additionalProperties.join(", ")}`);
		} else if (error.keyword === "required") {
			details.push(`${path}: missing field(s) ${error.params.requiredProperties.join(", ")}`);
		} else {
			details.push(`${path}: ${error.message}`);
		}
		if (details.length === MAX_DETAILS) break;
	}
	return details;
}

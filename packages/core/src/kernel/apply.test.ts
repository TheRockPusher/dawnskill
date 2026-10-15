import { fc, test } from "@fast-check/vitest";
// `test` from @fast-check/vitest re-runs a plain body numRuns times, so deterministic examples use vitest's `it`.
import { afterAll, describe, expect, it } from "vitest";
import { userEvent } from "../user.ts";
import { apply, initialState } from "./apply.ts";
import type { ApplyResult, EventBody, EventType, Illegal, KernelEvent, NewTask, TaskPatch } from "./events.ts";
import { AGENT_EVENTS } from "./events.ts";
import { isBlocked, skillGaps } from "./readiness.ts";
import type {
	Actor,
	Criterion,
	DraftSkill,
	DraftTask,
	Iso,
	KernelState,
	Level,
	PlanDraft,
	Requirement,
	SkillKey,
	TargetLevel,
	Task,
} from "./types.ts";

const START = Date.parse("2026-10-16T09:00:00.000Z");

/** Injected clock: one minute per step. */
function at(step: number): Iso {
	return new Date(START + step * 60_000).toISOString();
}

const TS = "typescript-generics";
const SQL = "sql-joins";
const RUST = "rust-traits";
const UNKNOWN_SKILL = "cobol-decks";

const AGENT_TYPES: readonly EventType[] = AGENT_EVENTS;
const LEVEL_EVENTS: readonly EventType[] = ["SkillSelfRated", "LevelConfirmed", "PlanApproved"];
const STATUS_EVENTS: readonly EventType[] = [
	"TaskStarted",
	"TaskPaused",
	"TaskCompleted",
	"TaskCancelled",
	"TaskReopened",
];
const CRITERIA: readonly Criterion[] = ["importance", "urgency", "unblocks", "effort", "age"];

function skillDraft(key: SkillKey, name: string): DraftSkill {
	return {
		key,
		name,
		description: `${name} as used in typed services`,
		concepts: [`${name} basics`, `${name} pitfalls`],
		prerequisites: [],
		resources: [{ title: `${name} handbook`, url: `https://example.com/${key}` }],
		retrievalPrompts: [`Explain ${name} from memory.`, `Write a ${name} example without notes.`],
		practiceMinutes: 60,
	};
}

function draftTask(ref: string, requires: readonly Requirement[], after: readonly string[]): DraftTask {
	return {
		ref,
		title: `Build ${ref}`,
		notes: `Part of the ${ref} milestone`,
		doneWhen: `${ref} merged`,
		category: "feature",
		estimateMinutes: 90,
		importance: 4,
		urgency: 3,
		requires,
		after,
	};
}

function newTask(title: string): NewTask {
	return {
		goalId: null,
		title,
		notes: "",
		doneWhen: "merged",
		category: "feature",
		estimateMinutes: 60,
		importance: 3,
		urgency: 3,
		requirements: [],
	};
}

function done(taskId: string, outcome: string): Extract<EventBody, { readonly type: "TaskCompleted" }> {
	return { type: "TaskCompleted", taskId, actualMinutes: 45, outcome, evidenceUrl: null };
}

/** "schema" needs SQL at 2, "builder" needs TS at 3 after "schema", "docs" comes last. */
const SEED_DRAFT: PlanDraft = {
	goal: "Ship a typed query builder",
	summary: "A generic SQL query builder in TypeScript",
	skills: [skillDraft(TS, "TypeScript: generics"), skillDraft(SQL, "SQL: joins")],
	tasks: [
		draftTask("schema", [{ skill: SQL, level: 2 }], []),
		draftTask("builder", [{ skill: TS, level: 3 }], ["schema"]),
		draftTask("docs", [], ["builder"]),
	],
};
const SEED_RATINGS: Readonly<Record<SkillKey, Level>> = { [TS]: 1, [SQL]: 0 };

const NEXT_DRAFT: PlanDraft = {
	goal: "Port the CLI to Rust",
	summary: "",
	skills: [skillDraft(RUST, "Rust: traits"), skillDraft(SQL, "SQL: joins")],
	tasks: [
		draftTask(
			"port",
			[
				{ skill: RUST, level: 2 },
				{ skill: SQL, level: 3 },
			],
			[],
		),
		draftTask("release", [], ["port"]),
	],
};

const BAD_DRAFT: PlanDraft = {
	goal: "Learn COBOL",
	summary: "",
	skills: [],
	tasks: [draftTask("deck", [{ skill: UNKNOWN_SKILL, level: 2 }], ["missing"])],
};

const DRAFTS: readonly PlanDraft[] = [SEED_DRAFT, NEXT_DRAFT, BAD_DRAFT];

/** Forges non-user envelopes: only `userEvent` brands, so `apply` must still check the actor at runtime (K6). */
function envelope(body: EventBody, actor: Actor, when: Iso): KernelEvent {
	return actor === "user" ? userEvent(body, when) : ({ ...body, actor, at: when } as KernelEvent);
}

function accepted(result: ApplyResult): KernelState {
	if (!result.ok) throw new Error(`rejected (${result.code}): ${result.message}`);
	return result.state;
}

function rejected(result: ApplyResult): Illegal {
	if (result.ok) throw new Error("an illegal event was accepted");
	return result;
}

function defined<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`missing ${what}`);
	return value;
}

function taskTitled(state: KernelState, title: string): Task {
	return defined(
		Object.values(state.tasks).find((task) => task.title === title),
		`task "${title}"`,
	);
}

function learningSteps(state: KernelState, skill: SkillKey): Task[] {
	return Object.values(state.tasks)
		.filter((task) => task.learning?.skill === skill)
		.sort((x, y) => (x.learning?.targetLevel ?? 0) - (y.learning?.targetLevel ?? 0));
}

/** Plan P1 proposed by the agent and approved with TS rated 1 and SQL rated 0, so both skills get learning chains. */
function seeded(): KernelState {
	const proposed = accepted(
		apply(initialState(), envelope({ type: "PlanProposed", draft: SEED_DRAFT, supersedes: null }, "agent", at(0))),
	);
	return accepted(apply(proposed, userEvent({ type: "PlanApproved", proposalId: "P1", ratings: SEED_RATINGS }, at(1))));
}

/** Freezes the whole state so any in-place mutation inside `apply` throws (ES modules are strict). */
function deepFreeze(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
}

/** Independent of `wouldCycle`: three-colour DFS over the blocker graph. */
function hasCycle(blockers: KernelState["blockers"]): boolean {
	const colour = new Map<string, "grey" | "black">();
	const visit = (id: string): boolean => {
		const seen = colour.get(id);
		if (seen !== undefined) return seen === "grey";
		colour.set(id, "grey");
		for (const next of blockers[id] ?? []) if (visit(next)) return true;
		colour.set(id, "black");
		return false;
	};
	return Object.keys(blockers).some((id) => visit(id));
}

// ── Abstract intents mapped onto the evolving state ──────────────────────────

interface Intent {
	readonly kind: EventType;
	readonly actor: Actor;
	/** Prefer targets for which the event is legal (otherwise any id, including a missing one). */
	readonly focus: boolean;
	readonly a: number;
	readonly b: number;
	readonly c: number;
}

/** Index `n` into `ids`; unless `focus`, one extra slot yields an id that does not exist. */
function pick(ids: readonly string[], n: number, missing: string, focus = false): string {
	return ids[n % (ids.length + (focus ? 0 : 1))] ?? missing;
}

function oneToFive(n: number): TargetLevel {
	return ((n % 5) + 1) as TargetLevel;
}

function pendingIds(state: KernelState, kind: "plan" | "level"): string[] {
	return Object.values(state.proposals)
		.filter((p) => p.status === "pending" && p.payload.kind === kind)
		.map((p) => p.id);
}

/** A task id: with `focus`, one for which `legal` holds (if any); otherwise any id or a missing one. */
function taskFor(state: KernelState, focus: boolean, n: number, legal: (task: Task) => boolean): string {
	const ids = Object.values(state.tasks)
		.filter((task) => !focus || legal(task))
		.map((task) => task.id);
	return pick(ids, n, "T999", focus);
}

function isActive(task: Task): boolean {
	return task.status === "open" || task.status === "doing";
}

type Builders = {
	readonly [K in EventType]: (state: KernelState, intent: Intent) => Extract<EventBody, { readonly type: K }>;
};

/** One builder per event type (the mapped type makes a missing one a compile error); some outputs are deliberately illegal. */
const BUILDERS: Builders = {
	TaskCreated: (s, { a, b, c }) => ({
		type: "TaskCreated",
		task: {
			goalId: c % 3 === 0 ? null : pick(Object.keys(s.goals), c, "G999"),
			title: `Chore ${a}`,
			notes: "",
			doneWhen: "checked in",
			category: b % 2 === 0 ? "feature" : "ops",
			estimateMinutes: b % 6 === 0 ? 0 : 10 + (a % 120),
			importance: oneToFive(a),
			urgency: oneToFive(b),
			requirements: c % 2 === 0 ? [] : [{ skill: pick(Object.keys(s.skills), a, UNKNOWN_SKILL), level: oneToFive(b) }],
		},
	}),
	TaskEdited: (s, { a, b, c }) => {
		const patches: readonly TaskPatch[] = [
			{ title: `Renamed ${b}` },
			{ importance: oneToFive(b), urgency: oneToFive(c) },
			{ requirements: [{ skill: pick(Object.keys(s.skills), b, UNKNOWN_SKILL), level: oneToFive(c) }] },
			{ requirements: [] },
			{ estimateMinutes: -5 },
			{ goalId: pick(Object.keys(s.goals), b, "G999") },
		];
		return {
			type: "TaskEdited",
			taskId: pick(Object.keys(s.tasks), a, "T999"),
			patch: patches[c % patches.length] ?? {},
		};
	},
	TaskStarted: (s, { focus, a }) => ({
		type: "TaskStarted",
		taskId: taskFor(s, focus, a, (task) => task.status === "open" && !isBlocked(s, task)),
	}),
	TaskPaused: (s, { focus, a }) => ({
		type: "TaskPaused",
		taskId: taskFor(s, focus, a, (task) => task.status === "doing"),
	}),
	TaskCompleted: (s, { focus, a, b, c }) => ({
		type: "TaskCompleted",
		taskId: taskFor(s, focus, a, isActive),
		actualMinutes: b % 4 === 0 ? 0 : b % 4 === 1 ? null : 5 + (b % 200),
		outcome: c % 4 === 0 ? "" : `Learned trick ${c}`,
		evidenceUrl: c % 5 === 1 ? "https://example.com/pr/7" : c % 5 === 2 ? "not a url" : null,
	}),
	TaskCancelled: (s, { focus, a }) => ({
		type: "TaskCancelled",
		taskId: taskFor(s, focus, a, isActive),
		reason: "out of scope",
	}),
	TaskReopened: (s, { focus, a }) => ({
		type: "TaskReopened",
		taskId: taskFor(s, focus, a, (task) => !isActive(task)),
	}),
	DependencyAdded: (s, { focus, a, b }) => ({
		type: "DependencyAdded",
		taskId: taskFor(s, focus, a, isActive),
		blockerId: taskFor(s, focus, b, isActive),
	}),
	DependencyRemoved: (s, { focus, a, b }) => {
		const edges = Object.entries(s.blockers).flatMap(([taskId, ids]) => ids.map((id) => [taskId, id] as const));
		const edge = focus ? edges[a % Math.max(edges.length, 1)] : undefined;
		return {
			type: "DependencyRemoved",
			taskId: edge?.[0] ?? pick(Object.keys(s.tasks), a, "T999"),
			blockerId: edge?.[1] ?? pick(Object.keys(s.tasks), b, "T999"),
		};
	},
	LearningStepsAdded: (s, { focus, a }) => ({
		type: "LearningStepsAdded",
		taskId: taskFor(s, focus, a, (task) => isActive(task) && skillGaps(s, task).length > 0),
	}),
	SkillCreated: (_s, { a }) => {
		const key = pick([TS, RUST, "go-channels"], a, "Not Kebab");
		return { type: "SkillCreated", skill: skillDraft(key, `Skill ${key}`) };
	},
	SkillSelfRated: (s, { a, b }) => ({
		type: "SkillSelfRated",
		skill: pick(Object.keys(s.skills), a, UNKNOWN_SKILL),
		level: (b % 7) as Level,
		evidence: "gut feeling",
	}),
	PlanProposed: (s, { a, b, c }) => ({
		type: "PlanProposed",
		draft: DRAFTS[a % DRAFTS.length] ?? SEED_DRAFT,
		supersedes: c % 2 === 0 ? null : pick(Object.keys(s.proposals), b, "P999"),
	}),
	LevelProposed: (s, { a, b }) => ({
		type: "LevelProposed",
		skill: pick(Object.keys(s.skills), a, UNKNOWN_SKILL),
		level: (b % 6) as TargetLevel,
		evidence: "passed the assessor quiz",
	}),
	ProposalRejected: (s, { a }) => ({
		type: "ProposalRejected",
		proposalId: pick(Object.keys(s.proposals), a, "P999"),
		reason: "not now",
	}),
	PlanApproved: (s, { focus, a, b, c }) => {
		const proposalId = pick(focus ? pendingIds(s, "plan") : Object.keys(s.proposals), a, "P999", focus);
		const payload = s.proposals[proposalId]?.payload;
		const keys = payload?.kind === "plan" ? payload.draft.skills.map((skill) => skill.key) : [];
		const rated = keys.map((key, i): [SkillKey, Level] => [key, ((b + i) % 6) as Level]);
		const variant = c % 6;
		const entries =
			variant === 0
				? rated.slice(1)
				: variant === 1
					? [...rated, [UNKNOWN_SKILL, 2] as [SkillKey, Level]]
					: variant === 2
						? rated.map(([key]): [SkillKey, Level] => [key, 9 as Level])
						: rated;
		return { type: "PlanApproved", proposalId, ratings: Object.fromEntries(entries) };
	},
	LevelConfirmed: (s, { focus, a, c }) => ({
		type: "LevelConfirmed",
		proposalId: pick(focus ? pendingIds(s, "level") : Object.keys(s.proposals), a, "P999", focus),
		evidence: c % 2 === 0 ? "" : "showed the demo",
	}),
	ReviewRecorded: (s, { a, b }) => ({
		type: "ReviewRecorded",
		skill: pick(Object.keys(s.skills), a, UNKNOWN_SKILL),
		recalled: b % 2 === 0,
	}),
	PreferencesSet: (_s, { a, c }) => ({
		type: "PreferencesSet",
		criteriaRank:
			c % 4 === 0
				? ["importance", "importance", "urgency", "effort", "age"]
				: [...CRITERIA.slice(a % 5), ...CRITERIA.slice(0, a % 5)],
	}),
};

const KINDS = Object.keys(BUILDERS) as EventType[];

const intentArb = fc.record({
	kind: fc.constantFrom(...KINDS),
	actor: fc.oneof(
		{ arbitrary: fc.constant<Actor>("user"), weight: 6 },
		{ arbitrary: fc.constant<Actor>("agent"), weight: 2 },
		{ arbitrary: fc.constant<Actor>("system"), weight: 1 },
	),
	focus: fc.boolean(),
	a: fc.nat(1000),
	b: fc.nat(1000),
	c: fc.nat(1000),
});

// ── Invariants checked after every step ──────────────────────────────────────

/** Latest row per key, in one pass. */
function latestBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
	const latest = new Map<string, T>();
	for (const row of rows) latest.set(key(row), row);
	return latest;
}

/** K1: a level changes only through a user level event and equals the assessment appended for it. */
function checkLevels(prev: KernelState, next: KernelState, event: KernelEvent): void {
	const appended = latestBy(next.assessments.slice(prev.assessments.length), (row) => row.skill);
	const latest = latestBy(next.assessments, (row) => row.skill);
	const skills = Object.values(next.skills);
	const changed = skills.filter((skill) => skill.level !== (prev.skills[skill.key]?.level ?? null));
	if (changed.length > 0) {
		expect(event.actor).toBe("user");
		expect(LEVEL_EVENTS).toContain(event.type);
	}
	expect({
		rewritten: prev.assessments.some((row, i) => next.assessments[i] !== row),
		lost: Object.keys(prev.skills).filter((key) => next.skills[key] === undefined),
		unexplained: changed.filter((skill) => appended.get(skill.key)?.level !== skill.level).map((skill) => skill.key),
		drifted: skills.filter((skill) => skill.level !== (latest.get(skill.key)?.level ?? null)).map((skill) => skill.key),
	}).toEqual({ rewritten: false, lost: [], unexplained: [], drifted: [] });
}

/** K2: every close writes exactly one completion row, and a closed task's latest row matches its status. */
function checkCompletions(prev: KernelState, next: KernelState, event: KernelEvent): void {
	const closedId = event.type === "TaskCompleted" || event.type === "TaskCancelled" ? event.taskId : null;
	expect(next.completions.length).toBe(prev.completions.length + (closedId === null ? 0 : 1));
	if (closedId !== null) {
		expect(next.completions.at(-1)).toMatchObject({
			taskId: closedId,
			status: event.type === "TaskCompleted" ? "done" : "cancelled",
			at: event.at,
		});
	}
	const latest = latestBy(next.completions, (row) => row.taskId);
	const closed = Object.values(next.tasks).filter((task) => !isActive(task));
	expect({
		unrecorded: closed.filter((task) => latest.get(task.id)?.status !== task.status).map((task) => task.id),
		closedByOtherEvent: closed
			.filter((task) => prev.tasks[task.id]?.status !== task.status && task.id !== closedId)
			.map((task) => task.id),
	}).toEqual({ unrecorded: [], closedByOtherEvent: [] });
}

/** K3 (accepted starts), K4 (acyclic, no edge touches a closed task), K7 (status changes keep edges). */
function checkGraph(prev: KernelState, next: KernelState, event: KernelEvent): void {
	if (event.type === "TaskStarted") {
		const task = prev.tasks[event.taskId];
		expect(task !== undefined && !isBlocked(prev, task)).toBe(true);
	}
	const dangling: string[] = [];
	const closedEnds: string[] = [];
	for (const [taskId, blockerIds] of Object.entries(next.blockers)) {
		for (const blockerId of blockerIds) {
			const task = next.tasks[taskId];
			const blocker = next.tasks[blockerId];
			if (task === undefined || blocker === undefined) dangling.push(`${taskId}<-${blockerId}`);
			else if (!prev.blockers[taskId]?.includes(blockerId) && !(isActive(task) && isActive(blocker))) {
				closedEnds.push(`${taskId}<-${blockerId}`);
			}
		}
	}
	expect({ cycle: hasCycle(next.blockers), dangling, closedEnds }).toEqual({
		cycle: false,
		dangling: [],
		closedEnds: [],
	});
	if (event.type === "DependencyAdded") {
		const ends = [prev.tasks[event.taskId], prev.tasks[event.blockerId]];
		expect(ends.every((task) => task !== undefined && isActive(task))).toBe(true);
		expect(next.blockers[event.taskId]).toContain(event.blockerId);
	}
	if (STATUS_EVENTS.includes(event.type)) expect(next.blockers).toBe(prev.blockers);
}

/** K5 (only a pending plan commits; decided proposals never change) and K6 (agents only add proposals). */
function checkProposals(prev: KernelState, next: KernelState, event: KernelEvent): void {
	const redecided = Object.values(prev.proposals)
		.filter((proposal) => proposal.status !== "pending" && next.proposals[proposal.id] !== proposal)
		.map((proposal) => proposal.id);
	expect(redecided).toEqual([]);
	if (event.type === "PlanApproved") {
		expect(prev.proposals[event.proposalId]).toMatchObject({ status: "pending", payload: { kind: "plan" } });
		expect(next.proposals[event.proposalId]).toMatchObject({ status: "accepted", decidedAt: event.at });
		expect(Object.values(next.goals).filter((goal) => goal.proposalId === event.proposalId)).toHaveLength(1);
	}
	if (event.actor === "agent") {
		expect(AGENT_TYPES).toContain(event.type);
		const touched = (Object.keys(prev) as (keyof KernelState)[]).filter(
			(key) => key !== "proposals" && key !== "seq" && key !== "nextId" && next[key] !== prev[key],
		);
		expect(touched).toEqual([]);
		const created = Object.values(next.proposals).filter((p) => prev.proposals[p.id] === undefined);
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ status: "pending", actor: "agent", createdAt: event.at });
	}
}

/** Checks one step and returns the state the caller keeps. */
function checkStep(prev: KernelState, event: KernelEvent, result: ApplyResult): KernelState {
	if (event.actor === "system" || (event.actor === "agent" && !AGENT_TYPES.includes(event.type))) {
		expect(result).toMatchObject({ ok: false, code: "actor" });
	}
	if (event.type === "PlanApproved") {
		const proposal = prev.proposals[event.proposalId];
		const approvable = proposal !== undefined && proposal.status === "pending" && proposal.payload.kind === "plan";
		if (!approvable) expect(result.ok).toBe(false);
	}
	if (event.type === "TaskStarted" && event.actor === "user") {
		const task = prev.tasks[event.taskId];
		if (task?.status === "open" && isBlocked(prev, task)) expect(result).toMatchObject({ ok: false, code: "blocked" });
	}
	if (!result.ok) {
		expect(result.message).not.toBe("");
		return prev;
	}
	const next = result.state;
	deepFreeze(next);
	expect(next.seq).toBe(prev.seq + 1);
	checkLevels(prev, next, event);
	checkCompletions(prev, next, event);
	checkGraph(prev, next, event);
	checkProposals(prev, next, event);
	return next;
}

describe("apply: model-based", () => {
	const acceptedKinds = new Set<EventType>();
	const rejectedKinds = new Set<EventType>();

	test.prop([fc.array(intentArb, { minLength: 10, maxLength: 40, size: "max" })])(
		"random event sequences keep K1–K7 and illegal events are rejected",
		(intents) => {
			// The seeded plan is approved (learning chains exist); a second plan stays pending for approval intents.
			let state = accepted(
				apply(seeded(), envelope({ type: "PlanProposed", draft: NEXT_DRAFT, supersedes: null }, "agent", at(2))),
			);
			deepFreeze(state);
			intents.forEach((intent, i) => {
				const event = envelope(BUILDERS[intent.kind](state, intent), intent.actor, at(i + 3));
				const result = apply(state, event);
				(result.ok ? acceptedKinds : rejectedKinds).add(event.type);
				state = checkStep(state, event, result);
			});
		},
	);

	// Guards against a vacuous model: across all runs every event type was both applied and refused.
	afterAll(() => {
		if (acceptedKinds.size + rejectedKinds.size === 0) return; // the property was filtered out
		expect(KINDS.filter((kind) => !acceptedKinds.has(kind))).toEqual([]);
		expect(KINDS.filter((kind) => !rejectedKinds.has(kind))).toEqual([]);
	});
});

describe("apply: examples", () => {
	it("approval chains learning steps; only confirmed levels unblock the work task", () => {
		const draft: PlanDraft = {
			goal: "Typed query builder",
			summary: "",
			skills: [skillDraft(TS, "TypeScript: generics")],
			tasks: [draftTask("builder", [{ skill: TS, level: 3 }], [])],
		};
		let s = accepted(
			apply(initialState(), envelope({ type: "PlanProposed", draft, supersedes: null }, "agent", at(0))),
		);
		s = accepted(apply(s, userEvent({ type: "PlanApproved", proposalId: "P1", ratings: { [TS]: 1 } }, at(1))));
		const builder = taskTitled(s, "Build builder");
		const steps = learningSteps(s, TS);
		expect(steps.map((task) => task.learning?.targetLevel)).toEqual([2, 3]);
		const l2 = defined(steps[0], "L2 step");
		const l3 = defined(steps[1], "L3 step");
		expect(s.blockers[l3.id]).toEqual([l2.id]);
		expect(s.blockers[builder.id]).toEqual([l3.id]);
		expect(s.skills[TS]?.level).toBe(1);
		expect(s.assessments).toEqual([
			{ skill: TS, level: 1, evidence: "self-rated at plan approval", source: "self", proposalId: null, at: at(1) },
		]);
		expect(rejected(apply(s, userEvent({ type: "TaskStarted", taskId: builder.id }, at(2))))).toMatchObject({
			code: "blocked",
			message: expect.stringContaining(l3.id),
		});

		expect(rejected(apply(s, userEvent(done(l2.id, " "), at(3))))).toMatchObject({ code: "invalid" });
		s = accepted(
			apply(
				s,
				userEvent({ ...done(l2.id, "Wrote a generic Result<T, E>"), evidenceUrl: "https://example.com/pr/1" }, at(3)),
			),
		);
		expect(s.skills[TS]?.level).toBe(1);
		const p2 = defined(pendingIds(s, "level")[0], "L2 proposal");
		expect(s.proposals[p2]).toMatchObject({
			status: "pending",
			actor: "system",
			payload: {
				kind: "level",
				skill: TS,
				level: 2,
				evidence: "Wrote a generic Result<T, E> (https://example.com/pr/1)",
				fromTaskId: l2.id,
			},
		});
		s = accepted(apply(s, userEvent({ type: "LevelConfirmed", proposalId: p2, evidence: "" }, at(4))));
		expect(s.skills[TS]?.level).toBe(2);
		expect(s.assessments.at(-1)).toEqual({
			skill: TS,
			level: 2,
			evidence: "Wrote a generic Result<T, E> (https://example.com/pr/1)",
			source: "confirmed",
			proposalId: p2,
			at: at(4),
		});
		expect(rejected(apply(s, userEvent({ type: "TaskStarted", taskId: builder.id }, at(5))))).toMatchObject({
			code: "blocked",
		});

		s = accepted(apply(s, userEvent(done(l3.id, "Typed the select() chain"), at(5))));
		s = accepted(apply(s, envelope({ type: "LevelProposed", skill: TS, level: 3, evidence: "quiz" }, "agent", at(6))));
		const [p3, quiz] = pendingIds(s, "level");
		s = accepted(
			apply(s, userEvent({ type: "LevelConfirmed", proposalId: defined(p3, "L3 proposal"), evidence: "Demo" }, at(7))),
		);
		expect(s.skills[TS]?.level).toBe(3);
		expect(s.assessments.at(-1)).toMatchObject({ level: 3, evidence: "Demo", source: "confirmed" });
		expect(s.proposals[defined(quiz, "agent proposal")]).toMatchObject({ status: "superseded", decidedAt: at(7) });
		s = accepted(apply(s, userEvent({ type: "TaskStarted", taskId: builder.id }, at(8))));
		expect(s.tasks[builder.id]?.status).toBe("doing");
	});

	it("a blocked task cannot start; reopening its blocker restores the block without touching edges", () => {
		let s = accepted(apply(initialState(), userEvent({ type: "TaskCreated", task: newTask("Write schema") }, at(0))));
		s = accepted(apply(s, userEvent({ type: "TaskCreated", task: newTask("Write queries") }, at(1))));
		s = accepted(apply(s, userEvent({ type: "DependencyAdded", taskId: "T2", blockerId: "T1" }, at(2))));
		expect(rejected(apply(s, userEvent({ type: "DependencyAdded", taskId: "T1", blockerId: "T2" }, at(3)))).code).toBe(
			"cycle",
		);
		expect(rejected(apply(s, userEvent({ type: "TaskStarted", taskId: "T2" }, at(3))))).toMatchObject({
			code: "blocked",
			message: expect.stringContaining("open blockers: T1"),
		});

		s = accepted(apply(s, userEvent(done("T1", "schema merged"), at(4))));
		const edges = s.blockers;
		s = accepted(apply(s, userEvent({ type: "TaskStarted", taskId: "T2" }, at(5))));
		s = accepted(apply(s, userEvent({ type: "TaskReopened", taskId: "T1" }, at(6))));
		expect(s.blockers).toBe(edges);
		s = accepted(apply(s, userEvent({ type: "TaskPaused", taskId: "T2" }, at(7))));
		expect(rejected(apply(s, userEvent({ type: "TaskStarted", taskId: "T2" }, at(8)))).code).toBe("blocked");

		s = accepted(apply(s, userEvent({ type: "TaskCancelled", taskId: "T1", reason: "merged upstream" }, at(8))));
		expect(s.completions.filter((row) => row.taskId === "T1").map((row) => [row.status, row.outcome])).toEqual([
			["done", "schema merged"],
			["cancelled", "merged upstream"],
		]);
		expect(
			rejected(apply(s, userEvent({ type: "DependencyRemoved", taskId: "T2", blockerId: "T1" }, at(9)))).code,
		).toBe("closed-task-edge");
		expect(rejected(apply(s, userEvent({ type: "DependencyAdded", taskId: "T1", blockerId: "T2" }, at(9)))).code).toBe(
			"closed-task-edge",
		);
		expect(rejected(apply(s, userEvent(done("T1", "again"), at(9)))).code).toBe("illegal-transition");
		expect(s.blockers).toBe(edges);
	});

	it("superseded and rejected plans never commit; agents cannot approve", () => {
		let s = accepted(
			apply(initialState(), envelope({ type: "PlanProposed", draft: SEED_DRAFT, supersedes: null }, "agent", at(0))),
		);
		s = accepted(apply(s, envelope({ type: "PlanProposed", draft: SEED_DRAFT, supersedes: "P1" }, "agent", at(1))));
		expect(s.proposals.P1).toMatchObject({ status: "superseded", note: "replaced by P2", decidedAt: at(1) });
		expect(s.proposals.P2).toMatchObject({ status: "pending", supersedes: "P1" });

		const approve = (proposalId: string, ratings: Readonly<Record<SkillKey, Level>>, step: number): ApplyResult =>
			apply(s, userEvent({ type: "PlanApproved", proposalId, ratings }, at(step)));
		expect(rejected(approve("P1", SEED_RATINGS, 2)).code).toBe("illegal-transition");
		expect(
			rejected(apply(s, envelope({ type: "PlanApproved", proposalId: "P2", ratings: SEED_RATINGS }, "agent", at(2))))
				.code,
		).toBe("actor");
		expect(rejected(approve("P2", { [TS]: 1 }, 2))).toMatchObject({
			code: "invalid",
			message: expect.stringContaining(SQL),
		});
		expect(rejected(approve("P2", { ...SEED_RATINGS, [RUST]: 2 }, 2))).toMatchObject({
			code: "invalid",
			message: expect.stringContaining(RUST),
		});

		s = accepted(apply(s, userEvent({ type: "ProposalRejected", proposalId: "P2", reason: "too big" }, at(3))));
		expect(s.proposals.P2).toMatchObject({ status: "rejected", note: "too big", decidedAt: at(3) });
		expect(rejected(approve("P2", SEED_RATINGS, 4)).code).toBe("illegal-transition");
		expect(s.goals).toEqual({});
		expect(s.tasks).toEqual({});
	});

	it("a self-rating supersedes pending level proposals for that skill only", () => {
		let s = seeded();
		s = accepted(apply(s, envelope({ type: "LevelProposed", skill: TS, level: 2, evidence: "quiz" }, "agent", at(2))));
		s = accepted(apply(s, envelope({ type: "LevelProposed", skill: SQL, level: 1, evidence: "quiz" }, "agent", at(3))));
		const [ts, sql] = pendingIds(s, "level");
		s = accepted(apply(s, userEvent({ type: "SkillSelfRated", skill: TS, level: 4, evidence: "ships libs" }, at(4))));
		expect(s.skills[TS]?.level).toBe(4);
		expect(s.proposals[defined(ts, "TS proposal")]).toMatchObject({
			status: "superseded",
			note: "superseded by self-rating",
			decidedAt: at(4),
		});
		expect(s.proposals[defined(sql, "SQL proposal")]?.status).toBe("pending");
		expect(
			rejected(
				apply(s, userEvent({ type: "LevelConfirmed", proposalId: defined(ts, "TS proposal"), evidence: "" }, at(5))),
			).code,
		).toBe("illegal-transition");
	});

	it("an event keeps reference identity of every entity it does not change", () => {
		const s = seeded();
		const schema = taskTitled(s, "Build schema");
		const edited = accepted(
			apply(s, userEvent({ type: "TaskEdited", taskId: schema.id, patch: { title: "Model the schema" } }, at(2))),
		);
		expect(edited.tasks[schema.id]).toEqual({ ...schema, title: "Model the schema", updatedAt: at(2) });
		for (const task of Object.values(s.tasks)) {
			if (task.id !== schema.id) expect(edited.tasks[task.id]).toBe(task);
		}
		for (const key of [
			"goals",
			"blockers",
			"completions",
			"skills",
			"assessments",
			"proposals",
			"reviews",
			"preferences",
		] as const) {
			expect(edited[key], key).toBe(s[key]);
		}

		const rated = accepted(
			apply(edited, userEvent({ type: "SkillSelfRated", skill: SQL, level: 2, evidence: "wrote reports" }, at(3))),
		);
		expect(rated.skills[TS]).toBe(edited.skills[TS]);
		expect(rated.skills[SQL]).toEqual({ ...edited.skills[SQL], level: 2 });
		expect(rated.tasks).toBe(edited.tasks);
	});
});

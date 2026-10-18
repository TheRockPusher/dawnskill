/**
 * The kernel reducer: the only way state changes. Pure and deterministic; ids come from
 * `state.nextId` and the clock from `event.at`, so replaying the event log reproduces state (K8).
 * Unchanged entities keep reference identity because persistence diffs by identity.
 */
import type {
	Applied,
	ApplyResult,
	Envelope,
	EventBody,
	EventType,
	Illegal,
	IllegalCode,
	KernelEvent,
} from "./events.ts";
import { AGENT_EVENTS } from "./events.ts";
import type { PlannedLearning } from "./learning.ts";
import { planLearning } from "./learning.ts";
import { isBlocked, openBlockers, skillGaps, wouldCycle } from "./readiness.ts";
import type { ProposalTransition, TaskTransition } from "./transitions.ts";
import { PROPOSAL_TRANSITIONS, TASK_TRANSITIONS, canTaskTransition } from "./transitions.ts";
import type {
	Assessment,
	Completion,
	Criterion,
	DraftSkill,
	DraftTask,
	Goal,
	Iso,
	KernelState,
	Level,
	Proposal,
	ProposalId,
	Requirement,
	Skill,
	SkillKey,
	Task,
	TaskId,
} from "./types.ts";
import { validateDraft, validateNewSkill, validateNewTask, validateTaskPatch } from "./validate.ts";

/** Default MCDA ranking, most important first (docs/learning-model.md §6). */
const DEFAULT_CRITERIA_RANK = [
	"importance",
	"urgency",
	"unblocks",
	"effort",
	"age",
] as const satisfies readonly Criterion[];

const MAX_ACTUAL_MINUTES = 100_000;
const HTTP_URL = /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/;
const PLAN_RATING_EVIDENCE = "self-rated at plan approval";

type On<T extends EventType> = Extract<EventBody, { readonly type: T }> & Envelope;
type Edges = Readonly<Record<TaskId, readonly TaskId[]>>;

export function initialState(): KernelState {
	return {
		seq: 0,
		nextId: 1,
		goals: {},
		tasks: {},
		blockers: {},
		completions: [],
		skills: {},
		assessments: [],
		proposals: {},
		reviews: [],
		preferences: { criteriaRank: DEFAULT_CRITERIA_RANK },
	};
}

/** Applies one event. On `Illegal` the caller keeps the old state. */
export function apply(state: KernelState, event: KernelEvent): ApplyResult {
	const denied = actorDenied(event);
	if (denied !== null) return denied;
	const result = reduce(state, event);
	if (!result.ok) return result;
	return { ok: true, state: { ...result.state, seq: state.seq + 1 } };
}

/** K6: agents may only propose; `system` emits nothing (it only acts inside a user event). */
function actorDenied(event: KernelEvent): Illegal | null {
	const agentMay = (AGENT_EVENTS as readonly EventType[]).includes(event.type);
	const legal = agentMay ? "user, agent" : "user";
	switch (event.actor) {
		case "user":
			return null;
		case "agent":
			return agentMay ? null : illegal("actor", `${event.type} by actor "agent"; legal actors: ${legal}`);
		case "system":
			return illegal("actor", `${event.type} by actor "system"; legal actors: ${legal}`);
	}
}

function reduce(state: KernelState, event: KernelEvent): ApplyResult {
	switch (event.type) {
		case "TaskCreated":
			return taskCreated(state, event);
		case "TaskEdited":
			return taskEdited(state, event);
		case "TaskStarted":
			return taskStarted(state, event);
		case "TaskPaused":
			return statusChanged(state, event, "TaskPaused");
		case "TaskCompleted":
			return taskCompleted(state, event);
		case "TaskCancelled":
			return taskCancelled(state, event);
		case "TaskReopened":
			return statusChanged(state, event, "TaskReopened");
		case "DependencyAdded":
			return dependencyAdded(state, event);
		case "DependencyRemoved":
			return dependencyRemoved(state, event);
		case "LearningStepsAdded":
			return learningStepsAdded(state, event);
		case "SkillCreated":
			return skillCreated(state, event);
		case "SkillSelfRated":
			return skillSelfRated(state, event);
		case "PlanProposed":
			return planProposed(state, event);
		case "LevelProposed":
			return levelProposed(state, event);
		case "ProposalRejected":
			return proposalRejected(state, event);
		case "PlanApproved":
			return planApproved(state, event);
		case "LevelConfirmed":
			return levelConfirmed(state, event);
		case "ReviewRecorded":
			return reviewRecorded(state, event);
		case "PreferencesSet":
			return preferencesSet(state, event);
	}
}

// ── Tasks ────────────────────────────────────────────────────────────────────

function taskCreated(state: KernelState, event: On<"TaskCreated">): ApplyResult {
	const input = event.task;
	if (input.goalId !== null && own(state.goals, input.goalId) === undefined) {
		return illegal("not-found", `goalId = "${input.goalId}" not found; legal: null or an existing goal`);
	}
	const errors = validateNewTask(state, input);
	if (errors.length > 0) return invalid(errors);
	const id = `T${state.nextId}`;
	const task: Task = {
		id,
		goalId: input.goalId,
		title: input.title,
		notes: input.notes,
		doneWhen: input.doneWhen,
		category: input.category,
		estimateMinutes: input.estimateMinutes,
		importance: input.importance,
		urgency: input.urgency,
		status: "open",
		requirements: input.requirements,
		...developsField(input.develops),
		learning: null,
		createdAt: event.at,
		updatedAt: event.at,
	};
	return ok({ ...state, nextId: state.nextId + 1, tasks: { ...state.tasks, [id]: task } });
}

function taskEdited(state: KernelState, event: On<"TaskEdited">): ApplyResult {
	const task = own(state.tasks, event.taskId);
	if (task === undefined) return taskNotFound(event.taskId);
	const { patch } = event;
	if (patch.goalId !== undefined && patch.goalId !== null && own(state.goals, patch.goalId) === undefined) {
		return illegal("not-found", `goalId = "${patch.goalId}" not found; legal: null or an existing goal`);
	}
	const errors = validateTaskPatch(state, patch, task);
	if (errors.length > 0) return invalid(errors);
	const { develops, ...rest } = task;
	const edited: Task = {
		...rest,
		goalId: patch.goalId === undefined ? task.goalId : patch.goalId,
		title: patch.title ?? task.title,
		notes: patch.notes ?? task.notes,
		doneWhen: patch.doneWhen ?? task.doneWhen,
		category: patch.category ?? task.category,
		estimateMinutes: patch.estimateMinutes ?? task.estimateMinutes,
		importance: patch.importance ?? task.importance,
		urgency: patch.urgency ?? task.urgency,
		requirements: patch.requirements ?? task.requirements,
		...developsField(patch.develops ?? develops),
		updatedAt: event.at,
	};
	return ok(withTask(state, edited));
}

/** K3: a derived-blocked task (open dependency or skill gap) cannot enter `doing`. */
function taskStarted(state: KernelState, event: On<"TaskStarted">): ApplyResult {
	const task = own(state.tasks, event.taskId);
	if (task === undefined) return taskNotFound(event.taskId);
	const denied = taskTransitionDenied(task, "TaskStarted");
	if (denied !== null) return denied;
	if (isBlocked(state, task)) return illegal("blocked", blockedMessage(state, task));
	return ok(withTask(state, moved(task, "TaskStarted", event.at)));
}

/** Pause and reopen only change status; edges survive closing and reopening (K7). */
function statusChanged(
	state: KernelState,
	event: On<"TaskPaused" | "TaskReopened">,
	transition: "TaskPaused" | "TaskReopened",
): ApplyResult {
	const task = own(state.tasks, event.taskId);
	if (task === undefined) return taskNotFound(event.taskId);
	const denied = taskTransitionDenied(task, transition);
	if (denied !== null) return denied;
	return ok(withTask(state, moved(task, transition, event.at)));
}

/** K2: the completion row (and level proposals for a learning step or developed skills) is written in this step. */
function taskCompleted(state: KernelState, event: On<"TaskCompleted">): ApplyResult {
	const task = own(state.tasks, event.taskId);
	if (task === undefined) return taskNotFound(event.taskId);
	const denied = taskTransitionDenied(task, "TaskCompleted");
	if (denied !== null) return denied;
	const { actualMinutes, outcome, evidenceUrl } = event;
	const errors: string[] = [];
	if (actualMinutes !== null && !isIntIn(actualMinutes, 1, MAX_ACTUAL_MINUTES)) {
		errors.push(`actualMinutes = ${actualMinutes}; legal: null or integer 1..${MAX_ACTUAL_MINUTES}`);
	}
	if (task.learning !== null && outcome.trim() === "") {
		errors.push(`outcome = ""; legal: non-empty text saying what you learned (task ${task.id} is a learning task)`);
	} else if (task.develops !== undefined && outcome.trim() === "") {
		const skills = task.develops.map((d) => d.skill).join(", ");
		errors.push(`outcome = ""; legal: non-empty text saying what you learned (task ${task.id} develops ${skills})`);
	}
	if (evidenceUrl !== null && !HTTP_URL.test(evidenceUrl)) {
		errors.push(`evidenceUrl = ${JSON.stringify(evidenceUrl)}; legal: null or an http(s) URL`);
	}
	if (errors.length > 0) return invalid(errors);

	const completion: Completion = {
		taskId: task.id,
		status: "done",
		actualMinutes,
		estimateMinutes: task.estimateMinutes,
		category: task.category,
		outcome,
		evidenceUrl,
		at: event.at,
	};
	const closed: KernelState = {
		...withTask(state, moved(task, "TaskCompleted", event.at)),
		completions: [...state.completions, completion],
	};
	const targets: readonly Requirement[] =
		task.learning === null ? (task.develops ?? []) : [{ skill: task.learning.skill, level: task.learning.targetLevel }];
	let n = state.nextId;
	const proposals: Record<ProposalId, Proposal> = { ...state.proposals };
	for (const target of targets) {
		const current = own(state.skills, target.skill)?.level ?? null;
		if (current !== null && current >= target.level) continue;
		const id = `P${n++}`;
		proposals[id] = {
			id,
			status: "pending",
			actor: "system",
			payload: {
				kind: "level",
				skill: target.skill,
				level: target.level,
				evidence: evidenceUrl === null ? outcome : `${outcome} (${evidenceUrl})`,
				fromTaskId: task.id,
			},
			supersedes: null,
			note: "",
			createdAt: event.at,
			decidedAt: null,
		};
	}
	return ok(n === state.nextId ? closed : { ...closed, nextId: n, proposals });
}

function taskCancelled(state: KernelState, event: On<"TaskCancelled">): ApplyResult {
	const task = own(state.tasks, event.taskId);
	if (task === undefined) return taskNotFound(event.taskId);
	const denied = taskTransitionDenied(task, "TaskCancelled");
	if (denied !== null) return denied;
	const completion: Completion = {
		taskId: task.id,
		status: "cancelled",
		actualMinutes: null,
		estimateMinutes: task.estimateMinutes,
		category: task.category,
		outcome: event.reason,
		evidenceUrl: null,
		at: event.at,
	};
	return ok({
		...withTask(state, moved(task, "TaskCancelled", event.at)),
		completions: [...state.completions, completion],
	});
}

// ── Dependencies (K4) ────────────────────────────────────────────────────────

function dependencyAdded(state: KernelState, event: On<"DependencyAdded">): ApplyResult {
	const task = own(state.tasks, event.taskId);
	if (task === undefined) return taskNotFound(event.taskId);
	const blocker = own(state.tasks, event.blockerId);
	if (blocker === undefined) return taskNotFound(event.blockerId);
	if (task.id === blocker.id) return illegal("cycle", `task ${task.id} cannot block itself`);
	const closed = closedEdgeEnd(task, blocker);
	if (closed !== null) return closed;
	const current = own(state.blockers, task.id) ?? [];
	if (current.includes(blocker.id)) {
		return illegal("duplicate", `${blocker.id} already blocks ${task.id}`);
	}
	if (wouldCycle(state, task.id, blocker.id)) {
		return illegal(
			"cycle",
			`${blocker.id} blocking ${task.id} closes a cycle: ${task.id} is already upstream of ${blocker.id}`,
		);
	}
	return ok({ ...state, blockers: { ...state.blockers, [task.id]: [...current, blocker.id] } });
}

function dependencyRemoved(state: KernelState, event: On<"DependencyRemoved">): ApplyResult {
	const current = own(state.blockers, event.taskId) ?? [];
	if (!current.includes(event.blockerId)) {
		const existing = current.length > 0 ? current.join(", ") : "(none)";
		return illegal(
			"not-found",
			`${event.blockerId} does not block ${event.taskId}; blockers of ${event.taskId}: ${existing}`,
		);
	}
	const task = own(state.tasks, event.taskId);
	const blocker = own(state.tasks, event.blockerId);
	if (task !== undefined && blocker !== undefined) {
		const closed = closedEdgeEnd(task, blocker);
		if (closed !== null) return closed;
	}
	const remaining = current.filter((id) => id !== event.blockerId);
	const blockers =
		remaining.length > 0
			? { ...state.blockers, [event.taskId]: remaining }
			: Object.fromEntries(Object.entries(state.blockers).filter(([id]) => id !== event.taskId));
	return ok({ ...state, blockers });
}

function learningStepsAdded(state: KernelState, event: On<"LearningStepsAdded">): ApplyResult {
	const task = own(state.tasks, event.taskId);
	if (task === undefined) return taskNotFound(event.taskId);
	if (task.status === "done" || task.status === "cancelled") {
		return illegal(
			"closed-task-edge",
			`task ${task.id} is "${task.status}"; learning steps need a task in: open, doing`,
		);
	}
	const planned = planLearning(state, [task.id], event.at);
	if (planned.tasks.length === 0 && planned.edges.length === 0) {
		return illegal("invalid", `task ${task.id}: no skill gaps need new learning steps`);
	}
	return ok(withPlanned(state, planned));
}

// ── Skills ───────────────────────────────────────────────────────────────────

function skillCreated(state: KernelState, event: On<"SkillCreated">): ApplyResult {
	const input = event.skill;
	if (own(state.skills, input.key) !== undefined) return illegal("duplicate", `skill "${input.key}" already exists`);
	const errors = validateNewSkill(state, input);
	if (errors.length > 0) return invalid(errors);
	const skill: Skill = {
		key: input.key,
		name: input.name,
		description: input.description,
		concepts: input.concepts,
		prerequisites: input.prerequisites,
		resources: input.resources,
		retrievalPrompts: input.retrievalPrompts,
		practiceMinutes: input.practiceMinutes,
		level: null,
		createdAt: event.at,
	};
	return ok({ ...state, skills: { ...state.skills, [skill.key]: skill } });
}

function skillSelfRated(state: KernelState, event: On<"SkillSelfRated">): ApplyResult {
	const skill = own(state.skills, event.skill);
	if (skill === undefined) return skillNotFound(state, event.skill);
	if (!isIntIn(event.level, 0, 5)) return illegal("invalid", `level = ${event.level}; legal: integer 0..5`);
	return ok(selfRated(state, skill, event.level, event.evidence, event.at));
}

function reviewRecorded(state: KernelState, event: On<"ReviewRecorded">): ApplyResult {
	if (own(state.skills, event.skill) === undefined) return skillNotFound(state, event.skill);
	return ok({ ...state, reviews: [...state.reviews, { skill: event.skill, recalled: event.recalled, at: event.at }] });
}

// ── Proposals (K1, K5, K6) ───────────────────────────────────────────────────

function planProposed(state: KernelState, event: On<"PlanProposed">): ApplyResult {
	const errors = validateDraft(state, event.draft);
	if (errors.length > 0) return invalid(errors);
	const id = `P${state.nextId}`;
	let proposals = state.proposals;
	if (event.supersedes !== null) {
		const old = own(proposals, event.supersedes);
		if (old === undefined) return proposalNotFound(event.supersedes);
		if (old.payload.kind !== "plan" || old.status !== "pending") {
			return illegal(
				"invalid",
				`supersedes = ${old.id} (${old.status} ${old.payload.kind} proposal); legal: a pending plan proposal or null`,
			);
		}
		proposals = { ...proposals, [old.id]: decided(old, "superseded", `replaced by ${id}`, event.at) };
	}
	const proposal: Proposal = {
		id,
		status: "pending",
		actor: event.actor,
		payload: { kind: "plan", draft: event.draft },
		supersedes: event.supersedes,
		note: "",
		createdAt: event.at,
		decidedAt: null,
	};
	return ok({ ...state, nextId: state.nextId + 1, proposals: { ...proposals, [id]: proposal } });
}

function levelProposed(state: KernelState, event: On<"LevelProposed">): ApplyResult {
	if (own(state.skills, event.skill) === undefined) return skillNotFound(state, event.skill);
	if (!isIntIn(event.level, 1, 5)) return illegal("invalid", `level = ${event.level}; legal: integer 1..5`);
	const id = `P${state.nextId}`;
	const proposal: Proposal = {
		id,
		status: "pending",
		actor: event.actor,
		payload: { kind: "level", skill: event.skill, level: event.level, evidence: event.evidence, fromTaskId: null },
		supersedes: null,
		note: "",
		createdAt: event.at,
		decidedAt: null,
	};
	return ok({ ...state, nextId: state.nextId + 1, proposals: { ...state.proposals, [id]: proposal } });
}

function proposalRejected(state: KernelState, event: On<"ProposalRejected">): ApplyResult {
	const proposal = own(state.proposals, event.proposalId);
	if (proposal === undefined) return proposalNotFound(event.proposalId);
	const denied = proposalTransitionDenied(proposal, "ProposalRejected");
	if (denied !== null) return denied;
	const rejected = decided(proposal, "rejected", event.reason, event.at);
	return ok({ ...state, proposals: { ...state.proposals, [proposal.id]: rejected } });
}

/** K5: only a pending plan commits, re-validated against the current state. */
function planApproved(state: KernelState, event: On<"PlanApproved">): ApplyResult {
	const proposal = own(state.proposals, event.proposalId);
	if (proposal === undefined) return proposalNotFound(event.proposalId);
	const { payload } = proposal;
	if (payload.kind !== "plan") {
		return illegal("invalid", `proposal ${proposal.id} is a ${payload.kind} proposal; legal: a plan proposal`);
	}
	const denied = proposalTransitionDenied(proposal, "PlanApproved");
	if (denied !== null) return denied;
	const { draft } = payload;
	const draftErrors = validateDraft(state, draft);
	if (draftErrors.length > 0) return invalid(draftErrors);
	const ratingErrors = ratingsErrors(state, draft.skills, event.ratings);
	if (ratingErrors.length > 0) return invalid(ratingErrors);

	let n = state.nextId;
	const goal: Goal = {
		id: `G${n++}`,
		title: draft.goal,
		summary: draft.summary,
		proposalId: proposal.id,
		createdAt: event.at,
	};
	const skills: Record<SkillKey, Skill> = { ...state.skills };
	for (const s of draft.skills) {
		if (own(skills, s.key) !== undefined) continue;
		skills[s.key] = {
			key: s.key,
			name: s.name,
			description: s.description,
			concepts: s.concepts,
			prerequisites: s.prerequisites,
			resources: s.resources,
			retrievalPrompts: s.retrievalPrompts,
			practiceMinutes: s.practiceMinutes,
			level: null,
			createdAt: event.at,
		};
	}
	let next: KernelState = { ...state, goals: { ...state.goals, [goal.id]: goal }, skills };
	for (const s of draft.skills) {
		const level = own(event.ratings, s.key);
		const skill = own(next.skills, s.key);
		if (level !== undefined && skill !== undefined) {
			next = selfRated(next, skill, level, PLAN_RATING_EVIDENCE, event.at);
		}
	}

	const idByRef = new Map<string, TaskId>();
	const created: Array<readonly [TaskId, DraftTask]> = [];
	const tasks: Record<TaskId, Task> = { ...next.tasks };
	for (const t of draft.tasks) {
		const id = `T${n++}`;
		idByRef.set(t.ref, id);
		created.push([id, t]);
		tasks[id] = {
			id,
			goalId: goal.id,
			title: t.title,
			notes: t.notes,
			doneWhen: t.doneWhen,
			category: t.category,
			estimateMinutes: t.estimateMinutes,
			importance: t.importance,
			urgency: t.urgency,
			status: "open",
			requirements: t.requires,
			...developsField(t.develops),
			learning: null,
			createdAt: event.at,
			updatedAt: event.at,
		};
	}
	const edges: Array<readonly [TaskId, TaskId]> = [];
	for (const [taskId, t] of created) {
		for (const ref of t.after) {
			const blockerId = idByRef.get(ref);
			if (blockerId === undefined) {
				return illegal("invalid", `task "${t.ref}" after = "${ref}"; legal: ${[...idByRef.keys()].join(", ")}`);
			}
			edges.push([taskId, blockerId]);
		}
	}
	next = { ...next, nextId: n, tasks, blockers: withEdges(next.blockers, edges) };
	next = withPlanned(
		next,
		planLearning(
			next,
			created.map(([id]) => id),
			event.at,
		),
	);
	const accepted = decided(proposal, "accepted", "", event.at);
	return ok({ ...next, proposals: { ...next.proposals, [proposal.id]: accepted } });
}

/** Every draft skill without a level must be rated; only draft skills may be rated, each 0..5. */
function ratingsErrors(
	state: KernelState,
	draftSkills: readonly DraftSkill[],
	ratings: Readonly<Record<SkillKey, Level>>,
): string[] {
	const keys = draftSkills.map((s) => s.key);
	const missing = keys.filter((k) => !Object.hasOwn(ratings, k) && (own(state.skills, k)?.level ?? null) === null);
	const extra = Object.keys(ratings).filter((k) => !keys.includes(k));
	const errors: string[] = [];
	if (missing.length > 0) errors.push(`ratings missing for unassessed skills: ${missing.join(", ")}; rate each 0..5`);
	if (extra.length > 0) {
		errors.push(`ratings has keys that are not draft skills: ${extra.join(", ")}; legal: ${keys.join(", ")}`);
	}
	for (const [key, level] of Object.entries(ratings)) {
		if (!isIntIn(level, 0, 5)) errors.push(`ratings["${key}"] = ${level}; legal: integer 0..5`);
	}
	return errors;
}

/** K1: a level changes only when the user confirms a pending proposal (or self-rates). */
function levelConfirmed(state: KernelState, event: On<"LevelConfirmed">): ApplyResult {
	const proposal = own(state.proposals, event.proposalId);
	if (proposal === undefined) return proposalNotFound(event.proposalId);
	const { payload } = proposal;
	if (payload.kind !== "level") {
		return illegal("invalid", `proposal ${proposal.id} is a ${payload.kind} proposal; legal: a level proposal`);
	}
	const denied = proposalTransitionDenied(proposal, "LevelConfirmed");
	if (denied !== null) return denied;
	const skill = own(state.skills, payload.skill);
	if (skill === undefined) return skillNotFound(state, payload.skill);
	const assessment: Assessment = {
		skill: skill.key,
		level: payload.level,
		evidence: event.evidence || payload.evidence,
		source: "confirmed",
		proposalId: proposal.id,
		at: event.at,
	};
	const proposals = supersedeLevelProposals(
		{ ...state.proposals, [proposal.id]: decided(proposal, "accepted", "", event.at) },
		skill.key,
		`superseded by confirmed ${proposal.id}`,
		event.at,
	);
	return ok({
		...state,
		skills:
			skill.level === payload.level
				? state.skills
				: { ...state.skills, [skill.key]: { ...skill, level: payload.level } },
		assessments: [...state.assessments, assessment],
		proposals,
	});
}

// ── Preferences ──────────────────────────────────────────────────────────────

function preferencesSet(state: KernelState, event: On<"PreferencesSet">): ApplyResult {
	const rank = event.criteriaRank;
	const permutation =
		rank.length === DEFAULT_CRITERIA_RANK.length && DEFAULT_CRITERIA_RANK.every((c) => rank.includes(c));
	if (!permutation) {
		return illegal(
			"invalid",
			`criteriaRank = [${rank.join(", ")}]; legal: a permutation of ${DEFAULT_CRITERIA_RANK.join(", ")}`,
		);
	}
	return ok({ ...state, preferences: { ...state.preferences, criteriaRank: rank } });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(state: KernelState): Applied {
	return { ok: true, state };
}

function illegal(code: IllegalCode, message: string): Illegal {
	return { ok: false, code, message };
}

function invalid(errors: readonly string[]): Illegal {
	return illegal("invalid", errors.join("; "));
}

/** Own-property lookup: ids and keys come from events, so prototype names must not resolve. */
function own<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isIntIn(value: number, min: number, max: number): boolean {
	return Number.isInteger(value) && value >= min && value <= max;
}

function taskNotFound(id: TaskId): Illegal {
	return illegal("not-found", `task "${id}" not found`);
}

function proposalNotFound(id: ProposalId): Illegal {
	return illegal("not-found", `proposal "${id}" not found`);
}

function skillNotFound(state: KernelState, key: SkillKey): Illegal {
	const known = Object.keys(state.skills).sort();
	return illegal("not-found", `skill "${key}" not found; known: ${known.length > 0 ? known.join(", ") : "(none)"}`);
}

function taskTransitionDenied(task: Task, transition: TaskTransition): Illegal | null {
	if (canTaskTransition(task.status, transition)) return null;
	const from = TASK_TRANSITIONS[transition].from.join(", ");
	return illegal("illegal-transition", `${transition}: task ${task.id} is "${task.status}"; legal from: ${from}`);
}

function proposalTransitionDenied(proposal: Proposal, transition: ProposalTransition): Illegal | null {
	const { from } = PROPOSAL_TRANSITIONS[transition];
	if ((from as readonly string[]).includes(proposal.status)) return null;
	return illegal(
		"illegal-transition",
		`${transition}: proposal ${proposal.id} is "${proposal.status}"; legal from: ${from.join(", ")}`,
	);
}

/** K4: no edge may be added to or removed from a closed task. */
function closedEdgeEnd(task: Task, blocker: Task): Illegal | null {
	for (const t of [task, blocker]) {
		if (t.status === "done" || t.status === "cancelled") {
			return illegal("closed-task-edge", `task ${t.id} is "${t.status}"; edges may only touch tasks in: open, doing`);
		}
	}
	return null;
}

function blockedMessage(state: KernelState, task: Task): string {
	const reasons: string[] = [];
	const open = openBlockers(state, task.id);
	if (open.length > 0) reasons.push(`open blockers: ${open.join(", ")}`);
	const gaps = skillGaps(state, task).map(
		(g) => `${g.skill} (required ${g.required}, current ${g.current ?? "unassessed"})`,
	);
	if (gaps.length > 0) reasons.push(`skill gaps: ${gaps.join(", ")}`);
	return `TaskStarted: task ${task.id} is blocked; ${reasons.join("; ")}`;
}

function moved(task: Task, transition: TaskTransition, at: Iso): Task {
	return { ...task, status: TASK_TRANSITIONS[transition].to, updatedAt: at };
}

/** `develops` is stored only when non-empty, so tasks replayed from logs that predate it keep their canonical form. */
function developsField(develops: readonly Requirement[] | undefined): Pick<Task, "develops"> {
	return develops === undefined || develops.length === 0 ? {} : { develops };
}

function withTask(state: KernelState, task: Task): KernelState {
	return { ...state, tasks: { ...state.tasks, [task.id]: task } };
}

/** Adds `[taskId, blockerId]` edges, skipping ones already present. */
function withEdges(blockers: Edges, edges: ReadonlyArray<readonly [TaskId, TaskId]>): Edges {
	if (edges.length === 0) return blockers;
	const next: Record<TaskId, readonly TaskId[]> = { ...blockers };
	for (const [taskId, blockerId] of edges) {
		const current = own(next, taskId) ?? [];
		if (!current.includes(blockerId)) next[taskId] = [...current, blockerId];
	}
	return next;
}

function withPlanned(state: KernelState, planned: PlannedLearning): KernelState {
	const tasks =
		planned.tasks.length === 0
			? state.tasks
			: { ...state.tasks, ...Object.fromEntries(planned.tasks.map((t) => [t.id, t] as const)) };
	return { ...state, nextId: planned.nextId, tasks, blockers: withEdges(state.blockers, planned.edges) };
}

function decided(proposal: Proposal, status: "accepted" | "rejected" | "superseded", note: string, at: Iso): Proposal {
	return { ...proposal, status, note, decidedAt: at };
}

/** A self-rating records an assessment, sets the level and supersedes pending level proposals for the skill. */
function selfRated(state: KernelState, skill: Skill, level: Level, evidence: string, at: Iso): KernelState {
	const assessment: Assessment = { skill: skill.key, level, evidence, source: "self", proposalId: null, at };
	return {
		...state,
		skills: skill.level === level ? state.skills : { ...state.skills, [skill.key]: { ...skill, level } },
		assessments: [...state.assessments, assessment],
		proposals: supersedeLevelProposals(state.proposals, skill.key, "superseded by self-rating", at),
	};
}

function supersedeLevelProposals(
	proposals: Readonly<Record<ProposalId, Proposal>>,
	skill: SkillKey,
	note: string,
	at: Iso,
): Readonly<Record<ProposalId, Proposal>> {
	let next: Record<ProposalId, Proposal> | null = null;
	for (const p of Object.values(proposals)) {
		if (p.status !== "pending" || p.payload.kind !== "level" || p.payload.skill !== skill) continue;
		next ??= { ...proposals };
		next[p.id] = decided(p, "superseded", note, at);
	}
	return next ?? proposals;
}

/**
 * Kernel domain types. Human-owned contract: every state change goes through `apply()`.
 * See docs/learning-model.md for the meaning and source of every level and constant.
 */

/** Dreyfus level. 0 = no exposure yet (product extension, not a Dreyfus stage); 1 novice … 5 expert. */
export type Level = 0 | 1 | 2 | 3 | 4 | 5;
/** A level a task can require or a learning step can target: novice … expert. */
export type TargetLevel = 1 | 2 | 3 | 4 | 5;
/** Five-point rating with anchored labels (importance, urgency). */
export type Likert = 1 | 2 | 3 | 4 | 5;
/** Who caused an event. Agents may only propose (K6). */
export type Actor = "user" | "agent" | "system";
/** ISO-8601 UTC timestamp, e.g. 2026-10-16T09:30:00.000Z. Supplied by the host clock, never read in core. */
export type Iso = string;

export type TaskId = string;
export type GoalId = string;
export type ProposalId = string;
/** Lowercase kebab-case, stable across goals so learning accumulates: e.g. `rust-ownership-borrowing`. */
export type SkillKey = string;

export type TaskStatus = "open" | "doing" | "done" | "cancelled";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "superseded";

/** MCDA criteria; their user ranking determines Rank-Order Centroid weights. */
export type Criterion = "importance" | "urgency" | "unblocks" | "effort" | "age";

/** Activity chosen by the target level (expertise reversal effect; see docs/learning-model.md §3). */
export type LearningActivity =
	| "worked-examples"
	| "guided-practice"
	| "independent-project"
	| "varied-cases"
	| "teach-and-extend";

export interface Resource {
	readonly title: string;
	readonly url: string;
}

export interface Requirement {
	readonly skill: SkillKey;
	readonly level: TargetLevel;
}

/** Present only on learning tasks: one Dreyfus step of one skill. */
export interface LearningSpec {
	readonly skill: SkillKey;
	readonly targetLevel: TargetLevel;
	readonly activity: LearningActivity;
	/** Application-ready artifact that proves the step (just-in-time, tied to the unblocked work). */
	readonly deliverable: string;
	/** Retrieval-practice prompts answered from memory at review time. */
	readonly retrievalPrompts: readonly string[];
	readonly resources: readonly Resource[];
}

export interface Task {
	readonly id: TaskId;
	readonly goalId: GoalId | null;
	readonly title: string;
	readonly notes: string;
	/** Verifiable completion criterion. */
	readonly doneWhen: string;
	readonly category: string;
	/** Raw baseline estimate in whole minutes (> 0). Adjusted estimates are derived, never stored. */
	readonly estimateMinutes: number;
	readonly importance: Likert;
	readonly urgency: Likert;
	readonly status: TaskStatus;
	readonly requirements: readonly Requirement[];
	/**
	 * Skills this task builds (study work: read a book and solve its exercises, write an essay). Never
	 * blocks and plans no learning steps; completing the task proposes each level. Absent when empty,
	 * so tasks from older event logs keep their canonical form.
	 */
	readonly develops?: readonly Requirement[];
	readonly learning: LearningSpec | null;
	readonly createdAt: Iso;
	readonly updatedAt: Iso;
}

/** Written in the same step that closes a task (K2). A task closed several times has several rows. */
export interface Completion {
	readonly taskId: TaskId;
	readonly status: "done" | "cancelled";
	/** Actual minutes; null when the user did not track time (excluded from estimate learning). */
	readonly actualMinutes: number | null;
	/** Raw estimate at closing time, so later edits never rewrite estimate history. */
	readonly estimateMinutes: number;
	readonly category: string;
	/** What was achieved or learned (done) or why it was abandoned (cancelled). */
	readonly outcome: string;
	readonly evidenceUrl: string | null;
	readonly at: Iso;
}

export interface Skill {
	readonly key: SkillKey;
	readonly name: string;
	readonly description: string;
	/** What the user needs to know: key concepts. */
	readonly concepts: readonly string[];
	/** Skills whose learning should come first. */
	readonly prerequisites: readonly SkillKey[];
	readonly resources: readonly Resource[];
	readonly retrievalPrompts: readonly string[];
	/** Planner's estimate of focused minutes for one level step; refined by the `learning` category history. */
	readonly practiceMinutes: number;
	/** Current level; null = never assessed. Changes only through user events (K1). */
	readonly level: Level | null;
	readonly createdAt: Iso;
}

export interface Assessment {
	readonly skill: SkillKey;
	readonly level: Level;
	readonly evidence: string;
	/** `self`: user self-rating; `confirmed`: user confirmed a pending level proposal. */
	readonly source: "self" | "confirmed";
	readonly proposalId: ProposalId | null;
	readonly at: Iso;
}

export interface Goal {
	readonly id: GoalId;
	readonly title: string;
	readonly summary: string;
	readonly proposalId: ProposalId | null;
	readonly createdAt: Iso;
}

/** Spaced retrieval review of a learned skill. */
export interface Review {
	readonly skill: SkillKey;
	readonly recalled: boolean;
	readonly at: Iso;
}

export interface DraftSkill {
	readonly key: SkillKey;
	readonly name: string;
	readonly description: string;
	readonly concepts: readonly string[];
	readonly prerequisites: readonly SkillKey[];
	readonly resources: readonly Resource[];
	readonly retrievalPrompts: readonly string[];
	readonly practiceMinutes: number;
}

export interface DraftTask {
	/** Unique within the draft; referenced by `after`. */
	readonly ref: string;
	readonly title: string;
	readonly notes: string;
	readonly doneWhen: string;
	readonly category: string;
	readonly estimateMinutes: number;
	readonly importance: Likert;
	readonly urgency: Likert;
	readonly requires: readonly Requirement[];
	/** Skills the task builds (see `Task.develops`); absent or non-empty. */
	readonly develops?: readonly Requirement[];
	/** Refs of draft tasks that must finish first. */
	readonly after: readonly string[];
}

/** A proposed decomposition of a goal. Agents produce it; only the user can approve it. */
export interface PlanDraft {
	readonly goal: string;
	readonly summary: string;
	readonly skills: readonly DraftSkill[];
	readonly tasks: readonly DraftTask[];
}

export type ProposalPayload =
	| { readonly kind: "plan"; readonly draft: PlanDraft }
	| {
			readonly kind: "level";
			readonly skill: SkillKey;
			readonly level: TargetLevel;
			readonly evidence: string;
			/** Learning or developing task whose completion triggered the proposal, if any. */
			readonly fromTaskId: TaskId | null;
	  };

export interface Proposal {
	readonly id: ProposalId;
	readonly status: ProposalStatus;
	readonly actor: Actor;
	readonly payload: ProposalPayload;
	readonly supersedes: ProposalId | null;
	/** Rejection reason or supersession note; empty while pending. */
	readonly note: string;
	readonly createdAt: Iso;
	readonly decidedAt: Iso | null;
}

export interface Preferences {
	/** Most important first; always a permutation of all five criteria. */
	readonly criteriaRank: readonly Criterion[];
}

export interface KernelState {
	/** Number of events applied so far. */
	readonly seq: number;
	/** Next numeric id suffix; ids are `G<n>`, `T<n>`, `P<n>` so replay is deterministic. */
	readonly nextId: number;
	readonly goals: Readonly<Record<GoalId, Goal>>;
	readonly tasks: Readonly<Record<TaskId, Task>>;
	/** task id → ids of tasks that must close first. Edges survive closing (K7). */
	readonly blockers: Readonly<Record<TaskId, readonly TaskId[]>>;
	readonly completions: readonly Completion[];
	readonly skills: Readonly<Record<SkillKey, Skill>>;
	readonly assessments: readonly Assessment[];
	readonly proposals: Readonly<Record<ProposalId, Proposal>>;
	readonly reviews: readonly Review[];
	readonly preferences: Preferences;
}

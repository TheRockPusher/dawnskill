import type {
	Actor,
	Criterion,
	GoalId,
	Iso,
	Level,
	Likert,
	PlanDraft,
	ProposalId,
	Requirement,
	Resource,
	SkillKey,
	TargetLevel,
	TaskId,
	KernelState,
} from "./types.ts";

/** Fields a user supplies for a new manual task. */
export interface NewTask {
	readonly goalId: GoalId | null;
	readonly title: string;
	readonly notes: string;
	readonly doneWhen: string;
	readonly category: string;
	readonly estimateMinutes: number;
	readonly importance: Likert;
	readonly urgency: Likert;
	readonly requirements: readonly Requirement[];
	/** Skills the task builds; omit or leave empty for none. */
	readonly develops?: readonly Requirement[];
}

/** Plain metadata edits; `status` and learning links are deliberately absent. `develops: []` removes the link. */
export interface TaskPatch {
	readonly goalId?: GoalId | null;
	readonly title?: string;
	readonly notes?: string;
	readonly doneWhen?: string;
	readonly category?: string;
	readonly estimateMinutes?: number;
	readonly importance?: Likert;
	readonly urgency?: Likert;
	readonly requirements?: readonly Requirement[];
	readonly develops?: readonly Requirement[];
}

export interface NewSkill {
	readonly key: SkillKey;
	readonly name: string;
	readonly description: string;
	readonly concepts: readonly string[];
	readonly prerequisites: readonly SkillKey[];
	readonly resources: readonly Resource[];
	readonly retrievalPrompts: readonly string[];
	readonly practiceMinutes: number;
}

export type EventBody =
	| { readonly type: "TaskCreated"; readonly task: NewTask }
	| { readonly type: "TaskEdited"; readonly taskId: TaskId; readonly patch: TaskPatch }
	| { readonly type: "TaskStarted"; readonly taskId: TaskId }
	| { readonly type: "TaskPaused"; readonly taskId: TaskId }
	| {
			readonly type: "TaskCompleted";
			readonly taskId: TaskId;
			readonly actualMinutes: number | null;
			readonly outcome: string;
			readonly evidenceUrl: string | null;
	  }
	| { readonly type: "TaskCancelled"; readonly taskId: TaskId; readonly reason: string }
	| { readonly type: "TaskReopened"; readonly taskId: TaskId }
	| { readonly type: "DependencyAdded"; readonly taskId: TaskId; readonly blockerId: TaskId }
	| { readonly type: "DependencyRemoved"; readonly taskId: TaskId; readonly blockerId: TaskId }
	/** Generate learning chains for the task's current skill gaps (same generator as plan approval). */
	| { readonly type: "LearningStepsAdded"; readonly taskId: TaskId }
	| { readonly type: "SkillCreated"; readonly skill: NewSkill }
	| { readonly type: "SkillSelfRated"; readonly skill: SkillKey; readonly level: Level; readonly evidence: string }
	| { readonly type: "PlanProposed"; readonly draft: PlanDraft; readonly supersedes: ProposalId | null }
	| {
			readonly type: "LevelProposed";
			readonly skill: SkillKey;
			readonly level: TargetLevel;
			readonly evidence: string;
	  }
	| { readonly type: "ProposalRejected"; readonly proposalId: ProposalId; readonly reason: string }
	/**
	 * Commit a pending plan. `ratings` self-rates every draft skill that has no level yet,
	 * so gaps are computed from real assessments.
	 */
	| {
			readonly type: "PlanApproved";
			readonly proposalId: ProposalId;
			readonly ratings: Readonly<Record<SkillKey, Level>>;
	  }
	| { readonly type: "LevelConfirmed"; readonly proposalId: ProposalId; readonly evidence: string }
	| { readonly type: "ReviewRecorded"; readonly skill: SkillKey; readonly recalled: boolean }
	| { readonly type: "PreferencesSet"; readonly criteriaRank: readonly Criterion[] };

export type EventType = EventBody["type"];

export interface Envelope {
	readonly at: Iso;
	readonly actor: Actor;
}

/** Events an agent may emit (K6): proposals only. */
export const AGENT_EVENTS = ["PlanProposed", "LevelProposed"] as const satisfies readonly EventType[];

/** Events that only an authenticated user handler may construct (PlanApproved / UserConfirmed). */
export const USER_CONFIRMATIONS = ["PlanApproved", "LevelConfirmed"] as const satisfies readonly EventType[];
export type UserConfirmationType = (typeof USER_CONFIRMATIONS)[number];

declare const userBrand: unique symbol;
/** Phantom brand: only `@dawnskill/core/user` (imported by the host's user handler) can produce it. */
export type UserConfirmed<E> = E & { readonly [userBrand]: true };

type Plain = Exclude<EventBody, { readonly type: UserConfirmationType }>;
type Confirmation = Extract<EventBody, { readonly type: UserConfirmationType }>;

export type KernelEvent = (Plain & Envelope) | UserConfirmed<Confirmation & Envelope>;

export type IllegalCode =
	| "not-found"
	| "illegal-transition"
	| "blocked"
	| "cycle"
	| "closed-task-edge"
	| "actor"
	| "invalid"
	| "duplicate";

export interface Illegal {
	readonly ok: false;
	readonly code: IllegalCode;
	/** Names the bad value and, where finite, the legal set (used as a repair message for agents). */
	readonly message: string;
}

export interface Applied {
	readonly ok: true;
	readonly state: KernelState;
}

export type ApplyResult = Applied | Illegal;

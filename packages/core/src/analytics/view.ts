import { isBlocked, openBlockers, skillGaps, type SkillGap } from "../kernel/readiness.ts";
import type {
	Assessment,
	Completion,
	Criterion,
	Goal,
	Iso,
	KernelState,
	Level,
	Proposal,
	ProposalId,
	Skill,
	SkillKey,
	TargetLevel,
	Task,
	TaskId,
} from "../kernel/types.ts";
import { adjustedMinutes, categoryStats, type CategoryStats } from "./estimates.ts";
import { dependentsIndex, rocWeights, scoreTasks, type TaskScore } from "./mcda.ts";
import { reviewSchedule, type ReviewItem } from "./reviews.ts";

export interface GoalView {
	readonly goal: Goal;
	readonly done: number;
	/** Non-cancelled tasks. */
	readonly total: number;
	readonly cancelled: number;
	readonly fraction: number;
	readonly taskIds: readonly TaskId[];
}

export interface TaskView {
	readonly task: Task;
	/** open|doing and not blocked. */
	readonly ready: boolean;
	/** Open blockers. */
	readonly blockedBy: readonly TaskId[];
	readonly gaps: readonly SkillGap[];
	/** Direct dependents, any status. */
	readonly dependents: readonly TaskId[];
	/** null when closed. */
	readonly score: TaskScore | null;
	readonly adjustedMinutes: number;
	readonly estimate: {
		readonly category: string;
		readonly samples: number;
		readonly applied: boolean;
		readonly medianRatio: number | null;
	};
	readonly completions: readonly Completion[];
}

export type SkillState = "unassessed" | "gap" | "learning" | "proposed" | "assessed";

export interface SkillView {
	readonly skill: Skill;
	readonly state: SkillState;
	/** Requirements by open/doing tasks. */
	readonly requiredBy: ReadonlyArray<{ readonly taskId: TaskId; readonly level: TargetLevel }>;
	readonly maxRequired: TargetLevel | null;
	readonly learningTaskIds: readonly TaskId[];
	/** Chronological. */
	readonly history: readonly Assessment[];
	readonly pendingProposalId: ProposalId | null;
	/** Skills listing this one as a prerequisite. */
	readonly dependents: readonly SkillKey[];
}

export interface FocusView {
	/** Ready non-learning tasks, ranked. */
	readonly next: readonly TaskId[];
	/** Ready learning tasks, ranked. */
	readonly learning: readonly TaskId[];
	readonly reviewsDue: readonly ReviewItem[];
	/** Pending level proposals. */
	readonly confirmations: readonly ProposalId[];
	/** Pending plan proposals. */
	readonly drafts: readonly ProposalId[];
}

export type JournalEntry =
	| {
			readonly kind: "learned";
			readonly at: Iso;
			readonly skill: SkillKey;
			readonly level: TargetLevel;
			readonly taskId: TaskId;
			readonly outcome: string;
			readonly evidenceUrl: string | null;
	  }
	| {
			readonly kind: "assessed";
			readonly at: Iso;
			readonly skill: SkillKey;
			readonly level: Level;
			readonly source: Assessment["source"];
			readonly evidence: string;
	  }
	| { readonly kind: "reviewed"; readonly at: Iso; readonly skill: SkillKey; readonly recalled: boolean }
	| {
			readonly kind: "completed";
			readonly at: Iso;
			readonly taskId: TaskId;
			readonly actualMinutes: number | null;
			readonly outcome: string;
	  };

export interface View {
	readonly seq: number;
	readonly now: Iso;
	readonly criteriaRank: readonly Criterion[];
	readonly weights: Readonly<Record<Criterion, number>>;
	readonly goals: readonly GoalView[];
	readonly tasks: readonly TaskView[];
	readonly skills: readonly SkillView[];
	readonly proposals: readonly Proposal[];
	readonly focus: FocusView;
	readonly journal: readonly JournalEntry[];
	readonly reviews: readonly ReviewItem[];
	readonly categories: Readonly<Record<string, CategoryStats>>;
}

const isActive = (task: Task): boolean => task.status === "open" || task.status === "doing";
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Read model served by the API: everything derived from state and the injected clock. */
export function deriveView(state: KernelState, now: Iso): View {
	const scores = scoreTasks(state, now);
	const categories = categoryStats(state);
	const reviews = reviewSchedule(state, now);
	const deps = dependentsIndex(state);
	const allTasks = Object.values(state.tasks);

	const rank = (a: Task, b: Task): number => {
		const sa = scores[a.id];
		const sb = scores[b.id];
		return (
			(sb?.effective ?? 0) - (sa?.effective ?? 0) ||
			(sb?.score ?? 0) - (sa?.score ?? 0) ||
			cmpStr(a.createdAt, b.createdAt) ||
			cmpStr(a.id, b.id)
		);
	};

	const completionsByTask = new Map<TaskId, Completion[]>();
	for (const c of state.completions) {
		const list = completionsByTask.get(c.taskId);
		if (list === undefined) completionsByTask.set(c.taskId, [c]);
		else list.push(c);
	}

	const active = allTasks.filter(isActive).sort(rank);
	const closed = allTasks
		.filter((t) => !isActive(t))
		.sort((a, b) => cmpStr(b.updatedAt, a.updatedAt) || cmpStr(a.id, b.id));
	const ready = new Set<TaskId>();
	const tasks: TaskView[] = [...active, ...closed].map((task) => {
		const live = isActive(task);
		const isReady = live && !isBlocked(state, task);
		if (isReady) ready.add(task.id);
		const stats = categories[task.category];
		return {
			task,
			ready: isReady,
			blockedBy: openBlockers(state, task.id),
			gaps: skillGaps(state, task),
			dependents: deps.get(task.id) ?? [],
			score: live ? (scores[task.id] ?? null) : null,
			adjustedMinutes: adjustedMinutes(stats, task.estimateMinutes),
			estimate: {
				category: task.category,
				samples: stats?.samples ?? 0,
				applied: stats?.applied ?? false,
				medianRatio: stats?.medianRatio ?? null,
			},
			completions: completionsByTask.get(task.id) ?? [],
		};
	});

	const goals: GoalView[] = Object.values(state.goals)
		.sort((a, b) => cmpStr(a.createdAt, b.createdAt) || cmpStr(a.id, b.id))
		.map((goal) => {
			let done = 0;
			let total = 0;
			let cancelled = 0;
			const taskIds: TaskId[] = [];
			for (const t of allTasks) {
				if (t.goalId !== goal.id) continue;
				taskIds.push(t.id);
				if (t.status === "cancelled") cancelled++;
				else {
					total++;
					if (t.status === "done") done++;
				}
			}
			return { goal, done, total, cancelled, fraction: total > 0 ? done / total : 0, taskIds };
		});

	const pendingLevel = new Map<SkillKey, ProposalId>();
	for (const p of Object.values(state.proposals)) {
		if (p.status === "pending" && p.payload.kind === "level") pendingLevel.set(p.payload.skill, p.id);
	}
	const skillDependents = new Map<SkillKey, SkillKey[]>();
	for (const s of Object.values(state.skills)) {
		for (const pre of s.prerequisites) {
			const list = skillDependents.get(pre);
			if (list === undefined) skillDependents.set(pre, [s.key]);
			else list.push(s.key);
		}
	}
	const skills: SkillView[] = Object.values(state.skills)
		.sort((a, b) => cmpStr(a.key, b.key))
		.map((skill) => {
			const requiredBy: Array<{ taskId: TaskId; level: TargetLevel }> = [];
			const learningTaskIds: TaskId[] = [];
			let maxRequired: TargetLevel | null = null;
			let learningOpen = false;
			for (const t of allTasks) {
				if (t.learning?.skill === skill.key) {
					learningTaskIds.push(t.id);
					if (isActive(t)) learningOpen = true;
				}
				if (!isActive(t)) continue;
				for (const r of t.requirements) {
					if (r.skill !== skill.key) continue;
					requiredBy.push({ taskId: t.id, level: r.level });
					if (maxRequired === null || r.level > maxRequired) maxRequired = r.level;
				}
			}
			const pendingProposalId = pendingLevel.get(skill.key) ?? null;
			const hasGap = maxRequired !== null && (skill.level === null || maxRequired > skill.level);
			const skillState: SkillState =
				pendingProposalId !== null
					? "proposed"
					: learningOpen
						? "learning"
						: hasGap
							? "gap"
							: skill.level === null
								? "unassessed"
								: "assessed";
			const history = state.assessments
				.map((a, order) => ({ a, order }))
				.filter(({ a }) => a.skill === skill.key)
				.sort((x, y) => cmpStr(x.a.at, y.a.at) || x.order - y.order)
				.map(({ a }) => a);
			return {
				skill,
				state: skillState,
				requiredBy,
				maxRequired,
				learningTaskIds,
				history,
				pendingProposalId,
				dependents: skillDependents.get(skill.key) ?? [],
			};
		});

	const proposalsAll = Object.values(state.proposals);
	const proposals = [...proposalsAll].sort(
		(a, b) =>
			Number(b.status === "pending") - Number(a.status === "pending") ||
			cmpStr(b.createdAt, a.createdAt) ||
			cmpStr(a.id, b.id),
	);
	const pendingByAge = proposalsAll
		.filter((p) => p.status === "pending")
		.sort((a, b) => cmpStr(a.createdAt, b.createdAt) || cmpStr(a.id, b.id));

	const focus: FocusView = {
		next: active.filter((t) => ready.has(t.id) && t.learning === null).map((t) => t.id),
		learning: active.filter((t) => ready.has(t.id) && t.learning !== null).map((t) => t.id),
		reviewsDue: reviews.filter((r) => r.due),
		confirmations: pendingByAge.filter((p) => p.payload.kind === "level").map((p) => p.id),
		drafts: pendingByAge.filter((p) => p.payload.kind === "plan").map((p) => p.id),
	};

	const journal: Array<{ e: JournalEntry; order: number }> = [];
	for (const c of state.completions) {
		if (c.status !== "done") continue;
		const learning = state.tasks[c.taskId]?.learning ?? null;
		const e: JournalEntry =
			learning !== null
				? {
						kind: "learned",
						at: c.at,
						skill: learning.skill,
						level: learning.targetLevel,
						taskId: c.taskId,
						outcome: c.outcome,
						evidenceUrl: c.evidenceUrl,
					}
				: { kind: "completed", at: c.at, taskId: c.taskId, actualMinutes: c.actualMinutes, outcome: c.outcome };
		journal.push({ e, order: journal.length });
	}
	for (const a of state.assessments) {
		journal.push({
			e: { kind: "assessed", at: a.at, skill: a.skill, level: a.level, source: a.source, evidence: a.evidence },
			order: journal.length,
		});
	}
	for (const r of state.reviews) {
		journal.push({ e: { kind: "reviewed", at: r.at, skill: r.skill, recalled: r.recalled }, order: journal.length });
	}
	journal.sort((x, y) => cmpStr(y.e.at, x.e.at) || y.order - x.order);

	return {
		seq: state.seq,
		now,
		criteriaRank: state.preferences.criteriaRank,
		weights: rocWeights(state.preferences.criteriaRank),
		goals,
		tasks,
		skills,
		proposals,
		focus,
		journal: journal.map(({ e }) => e),
		reviews,
		categories,
	};
}

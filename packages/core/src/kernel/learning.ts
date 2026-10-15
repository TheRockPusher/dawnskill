/**
 * Learning-step generation: one learning task per Dreyfus level step for every skill gap.
 * Activities and wording follow docs/learning-model.md §2–§4.
 */
import { skillGaps, wouldCycle } from "./readiness.ts";
import type {
	Iso,
	KernelState,
	LearningActivity,
	Level,
	Likert,
	Skill,
	SkillKey,
	TargetLevel,
	Task,
	TaskId,
} from "./types.ts";

export const LEVEL_NAMES: Readonly<Record<Level, string>> = {
	0: "No exposure",
	1: "Novice",
	2: "Advanced beginner",
	3: "Competent",
	4: "Proficient",
	5: "Expert",
};

/** Less guidance the higher the target level (expertise reversal effect, Kalyuga et al. 2003). */
export const ACTIVITY_BY_LEVEL: Readonly<Record<TargetLevel, LearningActivity>> = {
	1: "worked-examples",
	2: "guided-practice",
	3: "independent-project",
	4: "varied-cases",
	5: "teach-and-extend",
};

/**
 * What the user does for each activity and what proves it. `deliverable` frames the artifact
 * in the task the step unblocks (just-in-time learning, docs/learning-model.md §4).
 */
export const ACTIVITY_GUIDE: Readonly<
	Record<
		LearningActivity,
		{
			readonly label: string;
			readonly instruction: string;
			readonly deliverable: (skillName: string, unblocks: string) => string;
		}
	>
> = {
	"worked-examples": {
		label: "Study worked examples",
		instruction:
			"Study two or three complete worked examples of the capability, then reproduce one yourself without looking and explain each step in your own words.",
		deliverable: (skill, unblocks) =>
			`A running snippet that reproduces a worked example of ${skill}, with every step explained in your own words, ready to adapt for "${unblocks}".`,
	},
	"guided-practice": {
		label: "Guided practice with feedback",
		instruction:
			"Work through examples with more steps left out each time, filling in the missing steps yourself and checking each attempt against tests or a reference solution, until you solve a new variant unaided.",
		deliverable: (skill, unblocks) =>
			`A tested solution to an unseen variant of the ${skill} problem that "${unblocks}" poses, solved without a walkthrough.`,
	},
	"independent-project": {
		label: "Independent small project",
		instruction:
			"Plan and build a small but complete piece of work that uses the skill in a realistic setting, without a tutorial, and debug it yourself.",
		deliverable: (skill, unblocks) =>
			`A runnable commit, branch or PR that applies ${skill} to the part of "${unblocks}" that needs it, planned and debugged without a tutorial.`,
	},
	"varied-cases": {
		label: "Analyse varied real cases",
		instruction:
			"Analyse several varied real cases (other people's code, reviews, incidents), note what distinguishes them and where your own approach would fail, and reflect on the feedback you get.",
		deliverable: (skill, unblocks) =>
			`Review notes on at least three varied real ${skill} cases, each ending in a concrete change you will make in "${unblocks}".`,
	},
	"teach-and-extend": {
		label: "Teach and extend",
		instruction:
			"Explain the skill to others (write-up, talk or code review) and extend it to the edge cases where the usual rules break.",
		deliverable: (skill, unblocks) =>
			`A published explanation or set of review comments on ${skill}, covering where the usual rules break, using "${unblocks}" as the worked case.`,
	},
};

export interface PlannedLearning {
	readonly tasks: readonly Task[];
	readonly edges: ReadonlyArray<readonly [taskId: TaskId, blockerId: TaskId]>;
	readonly nextId: number;
}

interface SkillDemand {
	readonly skill: Skill;
	required: TargetLevel;
	readonly consumers: Task[];
	/** Each consumer's own required level for this skill. */
	readonly levels: Map<TaskId, TargetLevel>;
}

/**
 * Plan learning chains for the skill gaps of `taskIds` (open or doing only). Pure and idempotent:
 * existing non-cancelled steps are reused and existing edges are never repeated, so planning again
 * after applying the result yields nothing.
 */
export function planLearning(state: KernelState, taskIds: readonly TaskId[], at: Iso): PlannedLearning {
	const demands = collectDemands(state, taskIds);
	const existing = indexLearningTasks(state);
	let nextId = state.nextId;
	const created: Task[] = [];
	const chains = new Map<SkillKey, readonly Task[]>();

	for (const { skill, required, consumers, levels } of demands) {
		const steps: Task[] = [];
		for (let k = (skill.level ?? 0) + 1; k <= required; k++) {
			const level = k as TargetLevel;
			const reused = existing.byStep.get(`${skill.key}@${level}`);
			if (reused !== undefined) {
				steps.push(reused);
				continue;
			}
			// A step serves only the consumers that need at least its level.
			const served = consumers.filter((consumer) => (levels.get(consumer.id) ?? 0) >= level);
			const task = newStep(skill, level, served, served[0] as Task, `T${nextId}`, at);
			nextId++;
			created.push(task);
			steps.push(task);
		}
		chains.set(skill.key, steps);
	}

	const graph = new EdgeAccumulator(state);
	for (const { skill, consumers, levels } of demands) {
		const steps = chains.get(skill.key) ?? [];
		for (let i = 1; i < steps.length; i++) graph.add(steps[i] as Task, steps[i - 1] as Task);
		const firstOpen = steps.find(isOpen);
		if (firstOpen !== undefined) {
			for (const prerequisite of skill.prerequisites.toSorted()) {
				const blocker = lastOpenStep(chains.get(prerequisite), existing.openBySkill.get(prerequisite));
				if (blocker !== undefined) graph.add(firstOpen, blocker);
			}
		}
		// Each consumer waits on the step reaching its own level; if that step is closed, the gap still blocks.
		const from = (skill.level ?? 0) + 1;
		for (const consumer of consumers) {
			const step = steps[(levels.get(consumer.id) ?? from) - from];
			if (step !== undefined) graph.add(consumer, step);
		}
	}

	return { tasks: created, edges: graph.edges, nextId };
}

/** Gapped skills sorted by key; required = max over consumers; consumers sorted by id with their own level. */
function collectDemands(state: KernelState, taskIds: readonly TaskId[]): readonly SkillDemand[] {
	const bySkill = new Map<SkillKey, SkillDemand>();
	for (const id of [...new Set(taskIds)].sort(compareIds)) {
		const task = Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined;
		if (task === undefined || !isOpen(task)) continue;
		for (const gap of skillGaps(state, task)) {
			const skill = Object.hasOwn(state.skills, gap.skill) ? state.skills[gap.skill] : undefined;
			if (skill === undefined) continue;
			const demand = bySkill.get(gap.skill);
			if (demand === undefined) {
				bySkill.set(gap.skill, {
					skill,
					required: gap.required,
					consumers: [task],
					levels: new Map([[task.id, gap.required]]),
				});
				continue;
			}
			if (gap.required > demand.required) demand.required = gap.required;
			if (!demand.consumers.includes(task)) demand.consumers.push(task);
			if (gap.required > (demand.levels.get(task.id) ?? 0)) demand.levels.set(task.id, gap.required);
		}
	}
	return [...bySkill.values()].sort((a, b) => (a.skill.key < b.skill.key ? -1 : 1));
}

function newStep(skill: Skill, level: TargetLevel, consumers: readonly Task[], first: Task, id: TaskId, at: Iso): Task {
	const activity = ACTIVITY_BY_LEVEL[level];
	const guide = ACTIVITY_GUIDE[activity];
	const deliverable = guide.deliverable(skill.name, first.title);
	const notes = [
		`Key concepts: ${skill.concepts.join("; ")}.`,
		`${guide.label}: ${guide.instruction}`,
		`Unblocks: ${consumers.map((task) => `${task.id} "${task.title}"`).join(", ")}.`,
	].join("\n");
	return {
		id,
		goalId: first.goalId,
		title: `Learn ${skill.name}: reach L${level} ${LEVEL_NAMES[level]}`,
		notes,
		doneWhen: deliverable,
		category: "learning",
		estimateMinutes: skill.practiceMinutes,
		importance: Math.max(...consumers.map((task) => task.importance)) as Likert,
		urgency: Math.max(...consumers.map((task) => task.urgency)) as Likert,
		status: "open",
		requirements: [],
		learning: {
			skill: skill.key,
			targetLevel: level,
			activity,
			deliverable,
			retrievalPrompts: skill.retrievalPrompts,
			resources: skill.resources,
		},
		createdAt: at,
		updatedAt: at,
	};
}

interface LearningIndex {
	/** Reusable step per (skill, level): non-cancelled, open/doing preferred, then lowest id. */
	readonly byStep: ReadonlyMap<string, Task>;
	/** Open/doing learning tasks per skill. */
	readonly openBySkill: ReadonlyMap<SkillKey, readonly Task[]>;
}

function indexLearningTasks(state: KernelState): LearningIndex {
	const byStep = new Map<string, Task>();
	const openBySkill = new Map<SkillKey, Task[]>();
	const tasks = Object.values(state.tasks).sort((a, b) => compareIds(a.id, b.id));
	for (const task of tasks) {
		if (task.learning === null || task.status === "cancelled") continue;
		const key = `${task.learning.skill}@${task.learning.targetLevel}`;
		const current = byStep.get(key);
		if (current === undefined || (!isOpen(current) && isOpen(task))) byStep.set(key, task);
		if (isOpen(task)) {
			const list = openBySkill.get(task.learning.skill);
			if (list === undefined) openBySkill.set(task.learning.skill, [task]);
			else list.push(task);
		}
	}
	return { byStep, openBySkill };
}

/** The prerequisite's last open step in this plan, else its highest-level existing open step. */
function lastOpenStep(chain: readonly Task[] | undefined, existing: readonly Task[] | undefined): Task | undefined {
	const planned = chain?.findLast(isOpen);
	if (planned !== undefined) return planned;
	let best: Task | undefined;
	for (const task of existing ?? []) {
		if (best === undefined || (task.learning?.targetLevel ?? 0) > (best.learning?.targetLevel ?? 0)) best = task;
	}
	return best;
}

/** Edges collected against the state's graph plus everything planned so far. */
class EdgeAccumulator {
	readonly edges: (readonly [TaskId, TaskId])[] = [];
	private readonly blockers: Record<TaskId, readonly TaskId[]>;
	private readonly graph: KernelState;

	constructor(state: KernelState) {
		this.blockers = { ...state.blockers };
		this.graph = { ...state, blockers: this.blockers };
	}

	add(task: Task, blocker: Task): void {
		if (!isOpen(task) || !isOpen(blocker)) return;
		const current = Object.hasOwn(this.blockers, task.id) ? (this.blockers[task.id] ?? []) : [];
		if (current.includes(blocker.id) || wouldCycle(this.graph, task.id, blocker.id)) return;
		this.blockers[task.id] = [...current, blocker.id];
		this.edges.push([task.id, blocker.id]);
	}
}

function isOpen(task: Task): boolean {
	return task.status === "open" || task.status === "doing";
}

/** Orders `T2` before `T10`: shorter ids first, then lexicographic. */
function compareIds(a: string, b: string): number {
	return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { ACTIVITY_BY_LEVEL, ACTIVITY_GUIDE, LEVEL_NAMES, type PlannedLearning, planLearning } from "./learning.ts";
import { wouldCycle } from "./readiness.ts";
import type {
	KernelState,
	Level,
	Likert,
	Requirement,
	Skill,
	SkillKey,
	TargetLevel,
	Task,
	TaskId,
	TaskStatus,
} from "./types.ts";

const AT = "2026-10-16T09:30:00.000Z";
const EARLIER = "2026-10-01T08:00:00.000Z";

function skill(key: SkillKey, level: Level | null, prerequisites: readonly SkillKey[] = []): Skill {
	return {
		key,
		name: `Skill ${key}`,
		description: "",
		concepts: [`${key} concept one`, `${key} concept two`],
		prerequisites,
		resources: [{ title: `${key} docs`, url: `https://example.com/${key}` }],
		retrievalPrompts: [`Explain ${key} from memory.`],
		practiceMinutes: 90,
		level,
		createdAt: EARLIER,
	};
}

function task(id: TaskId, requirements: readonly Requirement[], overrides: Partial<Task> = {}): Task {
	return {
		id,
		goalId: "G1",
		title: `Ship feature ${id}`,
		notes: "",
		doneWhen: "merged",
		category: "feature",
		estimateMinutes: 120,
		importance: 3,
		urgency: 2,
		status: "open",
		requirements,
		learning: null,
		createdAt: EARLIER,
		updatedAt: EARLIER,
		...overrides,
	};
}

function learningTask(id: TaskId, key: SkillKey, targetLevel: TargetLevel, status: TaskStatus): Task {
	return task(id, [], {
		status,
		category: "learning",
		learning: {
			skill: key,
			targetLevel,
			activity: ACTIVITY_BY_LEVEL[targetLevel],
			deliverable: "existing deliverable",
			retrievalPrompts: [],
			resources: [],
		},
	});
}

function state(
	tasks: readonly Task[],
	skills: readonly Skill[],
	blockers: Readonly<Record<TaskId, readonly TaskId[]>> = {},
): KernelState {
	const maxId = Math.max(0, ...tasks.map((t) => Number(t.id.slice(1))));
	return {
		seq: 0,
		nextId: maxId + 1,
		goals: {},
		tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
		blockers,
		completions: [],
		skills: Object.fromEntries(skills.map((s) => [s.key, s])),
		assessments: [],
		proposals: {},
		reviews: [],
		preferences: { criteriaRank: ["importance", "urgency", "unblocks", "effort", "age"] },
	};
}

/** What the reducer does with a plan: add the tasks and append the edges. */
function merge(base: KernelState, planned: PlannedLearning): KernelState {
	const blockers: Record<TaskId, readonly TaskId[]> = { ...base.blockers };
	for (const [taskId, blockerId] of planned.edges) blockers[taskId] = [...(blockers[taskId] ?? []), blockerId];
	return {
		...base,
		nextId: planned.nextId,
		tasks: { ...base.tasks, ...Object.fromEntries(planned.tasks.map((t) => [t.id, t])) },
		blockers,
	};
}

const open = (s: KernelState, id: TaskId) => {
	const status = s.tasks[id]?.status;
	return status === "open" || status === "doing";
};

const levelArb = fc.constantFrom<TargetLevel>(1, 2, 3, 4, 5);
const likertArb = fc.constantFrom<Likert>(1, 2, 3, 4, 5);
const statusArb = fc.constantFrom<TaskStatus>("open", "doing", "done", "cancelled");
const KEYS = ["alpha", "beta", "gamma", "delta"] as const;

/**
 * Random but well-formed state: skills with acyclic prerequisites (only earlier keys), consumer
 * tasks with random requirements and statuses, pre-existing learning steps, and acyclic
 * blocker edges (a task is only blocked by tasks listed before it).
 */
const stateArb = fc
	.record({
		levels: fc.tuple(...KEYS.map(() => fc.option(fc.constantFrom<Level>(0, 1, 2, 3, 4, 5), { nil: null }))),
		prerequisites: fc.tuple(...KEYS.map((_, i) => fc.subarray(KEYS.slice(0, i) as SkillKey[]))),
		consumers: fc.array(
			fc.record({
				requires: fc.uniqueArray(fc.record({ skill: fc.constantFrom(...KEYS), level: levelArb }), {
					selector: (r) => r.skill,
					maxLength: 3,
				}),
				status: statusArb,
				importance: likertArb,
				urgency: likertArb,
			}),
			{ minLength: 1, maxLength: 5 },
		),
		steps: fc.array(fc.record({ skill: fc.constantFrom(...KEYS), level: levelArb, status: statusArb }), {
			maxLength: 6,
		}),
		order: fc.array(fc.nat(), { maxLength: 30 }),
		edges: fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 12 }),
	})
	.map(({ levels, prerequisites, consumers, steps, order, edges }) => {
		const skills = KEYS.map((key, i) => skill(key, levels[i] ?? null, prerequisites[i] ?? []));
		const all: Task[] = [
			...consumers.map((c) => task("", c.requires, { status: c.status, importance: c.importance, urgency: c.urgency })),
			...steps.map((s) => learningTask("", s.skill, s.level, s.status)),
		];
		// Shuffle so consumers and steps interleave in id order.
		for (let i = all.length - 1; i > 0; i--) {
			const j = (order[i] ?? 0) % (i + 1);
			[all[i], all[j]] = [all[j] as Task, all[i] as Task];
		}
		const tasks = all.map((t, i) => ({ ...t, id: `T${i + 1}` }));
		const blockers: Record<TaskId, TaskId[]> = {};
		for (const [a, b] of edges) {
			const later = Math.max(a % tasks.length, b % tasks.length);
			const earlier = Math.min(a % tasks.length, b % tasks.length);
			if (later === earlier) continue;
			const list = (blockers[`T${later + 1}`] ??= []);
			if (!list.includes(`T${earlier + 1}`)) list.push(`T${earlier + 1}`);
		}
		return state(tasks, skills, blockers);
	});

const allIds = (s: KernelState) => Object.keys(s.tasks);

describe("planLearning chains", () => {
	test.prop([levelArb, fc.option(fc.constantFrom<Level>(0, 1, 2, 3, 4), { nil: null })])(
		"creates one step per missing level, chained in level order, last one blocking the consumer",
		(required, current) => {
			const base = state([task("T1", [{ skill: "rust", level: required }])], [skill("rust", current)]);
			const planned = planLearning(base, ["T1"], AT);

			const from = (current ?? 0) + 1;
			const expectedLevels = Array.from({ length: Math.max(0, required - from + 1) }, (_, i) => from + i);
			expect(planned.tasks.map((t) => t.learning?.targetLevel)).toEqual(expectedLevels);
			expect(planned.tasks.map((t) => t.id)).toEqual(expectedLevels.map((_, i) => `T${base.nextId + i}`));
			expect(planned.nextId).toBe(base.nextId + expectedLevels.length);

			const ids = planned.tasks.map((t) => t.id);
			const chain = ids.slice(1).map((id, i) => [id, ids[i]] as const);
			const last = ids.at(-1);
			expect(planned.edges).toEqual(last === undefined ? [] : [...chain, ["T1", last]]);
		},
	);

	it("a fresh skill required at L3 yields worked examples, guided practice, then a project", () => {
		const consumer = task("T1", [{ skill: "rust", level: 3 }], { title: "Add --glob flag", importance: 4, urgency: 5 });
		const planned = planLearning(state([consumer], [skill("rust", null)]), ["T1"], AT);

		expect(planned.tasks.map((t) => t.learning?.activity)).toEqual([
			"worked-examples",
			"guided-practice",
			"independent-project",
		]);
		const [first] = planned.tasks;
		expect(first?.title).toBe(`Learn Skill rust: reach L1 ${LEVEL_NAMES[1]}`);
		for (const step of planned.tasks) {
			expect(step.doneWhen).toContain('"Add --glob flag"');
			expect(step.learning?.deliverable).toBe(step.doneWhen);
			expect(step.notes).toContain("rust concept one");
			expect(step.notes).toContain(ACTIVITY_GUIDE[step.learning?.activity ?? "worked-examples"].instruction);
			expect(step).toMatchObject({
				status: "open",
				category: "learning",
				estimateMinutes: 90,
				importance: 4,
				urgency: 5,
				goalId: "G1",
				requirements: [],
				createdAt: AT,
				updatedAt: AT,
			});
			expect(step.learning?.retrievalPrompts).toEqual(["Explain rust from memory."]);
		}
	});

	test.prop([fc.uniqueArray(levelArb, { minLength: 1, maxLength: 4 })])(
		"one chain per skill up to the max required level; each consumer waits only on the step reaching its own level",
		(levels) => {
			const consumers = levels.map((level, i) => task(`T${i + 1}`, [{ skill: "ts", level }], { importance: 1 }));
			const base = state(consumers, [skill("ts", null)]);
			const planned = planLearning(base, allIds(base), AT);
			expect(planned.tasks).toHaveLength(Math.max(...levels));
			const stepIds = new Set(planned.tasks.map((t) => t.id));
			for (const consumer of consumers) {
				const own = planned.tasks.find((t) => t.learning?.targetLevel === consumer.requirements[0]?.level)?.id;
				const consumerEdges = planned.edges.filter(
					([taskId, blockerId]) => taskId === consumer.id && stepIds.has(blockerId),
				);
				expect(consumerEdges).toEqual([[consumer.id, own]]);
			}
		},
	);

	it("a task needing L2 is blocked by the L2 step, a task needing L4 by the L4 step", () => {
		const low = task("T1", [{ skill: "ts", level: 2 }], { title: "Small fix", importance: 5, urgency: 1 });
		const high = task("T2", [{ skill: "ts", level: 4 }], { title: "Type-level DSL", importance: 2, urgency: 3 });
		const planned = planLearning(state([low, high], [skill("ts", null)]), ["T1", "T2"], AT);
		const step = (level: TargetLevel) => planned.tasks.find((t) => t.learning?.targetLevel === level) as Task;

		expect(planned.edges.filter(([taskId]) => taskId === "T1")).toEqual([["T1", step(2).id]]);
		expect(planned.edges.filter(([taskId]) => taskId === "T2")).toEqual([["T2", step(4).id]]);
		// Steps below L2 serve both tasks; L3 and L4 serve only the L4 task.
		expect([1, 2, 3, 4].map((l) => step(l as TargetLevel).importance)).toEqual([5, 5, 2, 2]);
		expect([1, 2, 3, 4].map((l) => step(l as TargetLevel).urgency)).toEqual([3, 3, 3, 3]);
		expect(step(2).doneWhen).toContain('"Small fix"');
		expect(step(3).doneWhen).toContain('"Type-level DSL"');
		expect(step(3).notes).not.toContain("Small fix");
	});

	it("generated text names the artifact and the unblocked task for every activity", () => {
		for (const level of [1, 2, 3, 4, 5] as const) {
			const text = ACTIVITY_GUIDE[ACTIVITY_BY_LEVEL[level]].deliverable("Rust: ownership", "Fix parser");
			expect(text).toContain("Rust: ownership");
			expect(text).toContain('"Fix parser"');
		}
	});

	it("closed, unknown and gap-free tasks get no learning", () => {
		const base = state(
			[
				task("T1", [{ skill: "a", level: 2 }], { status: "done" }),
				task("T2", [{ skill: "a", level: 2 }], { status: "cancelled" }),
				task("T3", [{ skill: "a", level: 1 }]),
			],
			[skill("a", 1)],
		);
		expect(planLearning(base, ["T1", "T2", "T3", "T404"], AT)).toEqual({ tasks: [], edges: [], nextId: base.nextId });
	});
});

describe("planLearning reuse and idempotence", () => {
	test.prop([
		levelArb,
		fc.subarray([1, 2, 3, 4, 5] as TargetLevel[]),
		fc.constantFrom<TaskStatus>("open", "doing", "done"),
	])("reuses existing non-cancelled steps instead of duplicating them", (required, existingLevels, status) => {
		const steps = existingLevels.map((level, i) => learningTask(`T${i + 2}`, "a", level, status));
		const base = state([task("T1", [{ skill: "a", level: required }]), ...steps], [skill("a", null)]);
		const planned = planLearning(base, ["T1"], AT);

		const reused = existingLevels.filter((level) => level <= required);
		expect(planned.tasks.map((t) => t.learning?.targetLevel ?? 0).sort((a, b) => a - b)).toEqual(
			[1, 2, 3, 4, 5].filter((l) => l <= required && !reused.includes(l as TargetLevel)),
		);
		const atRequired = steps.find((s) => s.learning?.targetLevel === required);
		if (atRequired !== undefined && status !== "done") expect(planned.edges).toContainEqual(["T1", atRequired.id]);
	});

	it("a cancelled step is not reused", () => {
		const base = state(
			[task("T1", [{ skill: "a", level: 1 }]), learningTask("T2", "a", 1, "cancelled")],
			[skill("a", null)],
		);
		const planned = planLearning(base, ["T1"], AT);
		expect(planned.tasks.map((t) => t.id)).toEqual(["T3"]);
		expect(planned.edges).toEqual([["T1", "T3"]]);
	});

	test.prop([stateArb])("planning again after applying the result yields nothing", (base) => {
		const first = planLearning(base, allIds(base), AT);
		const applied = merge(base, first);
		expect(planLearning(applied, allIds(applied), AT)).toEqual({ tasks: [], edges: [], nextId: applied.nextId });
	});

	test.prop([stateArb])("is deterministic and allocates consecutive fresh ids", (base) => {
		const planned = planLearning(base, allIds(base), AT);
		expect(planLearning(base, [...allIds(base)].reverse(), AT)).toEqual(planned);
		expect(planned.tasks.map((t) => t.id)).toEqual(planned.tasks.map((_, i) => `T${base.nextId + i}`));
		expect(planned.nextId).toBe(base.nextId + planned.tasks.length);
	});
});

describe("planLearning edges", () => {
	it("a skill's first step waits on its prerequisite's last step", () => {
		const base = state(
			[task("T1", [{ skill: "async", level: 2 }]), task("T2", [{ skill: "basics", level: 2 }])],
			[skill("async", null, ["basics"]), skill("basics", 0)],
		);
		const planned = planLearning(base, ["T1", "T2"], AT);
		const id = (key: SkillKey, level: TargetLevel) =>
			planned.tasks.find((t) => t.learning?.skill === key && t.learning.targetLevel === level)?.id;
		expect(planned.edges).toContainEqual([id("async", 1), id("basics", 2)]);
		expect(planned.edges).not.toContainEqual([id("async", 2), id("basics", 2)]);
	});

	it("an open learning step of a prerequisite outside the plan still gates the chain", () => {
		const base = state(
			[
				task("T1", [{ skill: "async", level: 1 }]),
				learningTask("T2", "basics", 1, "open"),
				learningTask("T3", "basics", 2, "doing"),
			],
			[skill("async", null, ["basics"]), skill("basics", 0)],
		);
		const planned = planLearning(base, ["T1"], AT);
		expect(planned.tasks.map((t) => t.id)).toEqual(["T4"]);
		expect(planned.edges).toEqual([
			["T4", "T3"],
			["T1", "T4"],
		]);
	});

	it("a satisfied prerequisite adds no edge", () => {
		const base = state(
			[task("T1", [{ skill: "async", level: 1 }])],
			[skill("async", null, ["basics"]), skill("basics", 5)],
		);
		expect(planLearning(base, ["T1"], AT).edges).toEqual([["T1", "T2"]]);
	});

	test.prop([stateArb])("never touches a closed task, never repeats an edge, never closes a cycle", (base) => {
		const planned = planLearning(base, allIds(base), AT);
		const applied = merge(base, planned);
		const seen = new Set<string>();
		for (const [taskId, blockerId] of planned.edges) {
			expect(open(applied, taskId) && open(applied, blockerId)).toBe(true);
			expect(base.blockers[taskId] ?? []).not.toContain(blockerId);
			expect(seen.has(`${taskId}<${blockerId}`)).toBe(false);
			seen.add(`${taskId}<${blockerId}`);
		}
		for (const [taskId, blockers] of Object.entries(applied.blockers)) {
			for (const blockerId of blockers) {
				const without = {
					...applied,
					blockers: { ...applied.blockers, [taskId]: blockers.filter((b) => b !== blockerId) },
				};
				expect(wouldCycle(without, taskId, blockerId)).toBe(false);
			}
		}
	});

	test.prop([stateArb])(
		"every open consumer with a gap waits on the step reaching its own level, never a higher one",
		(base) => {
			const planned = planLearning(base, allIds(base), AT);
			const applied = merge(base, planned);
			for (const consumer of Object.values(base.tasks)) {
				if (!open(base, consumer.id)) continue;
				for (const { skill: key, level } of consumer.requirements) {
					if ((base.skills[key]?.level ?? -1) >= level) continue;
					for (const [taskId, blockerId] of planned.edges) {
						const target = applied.tasks[blockerId]?.learning;
						if (taskId === consumer.id && target?.skill === key) expect(target.targetLevel).toBe(level);
					}
					const candidates = Object.values(applied.tasks).filter(
						(t) => t.learning?.skill === key && t.learning.targetLevel === level && t.status !== "cancelled",
					);
					const step = candidates.find((t) => open(applied, t.id)) ?? candidates[0];
					expect(step).toBeDefined();
					if (
						step !== undefined &&
						open(applied, step.id) &&
						!(applied.blockers[consumer.id] ?? []).includes(step.id)
					) {
						// Only a cycle may keep the edge out.
						expect(wouldCycle(applied, consumer.id, step.id)).toBe(true);
					}
				}
			}
		},
	);
});

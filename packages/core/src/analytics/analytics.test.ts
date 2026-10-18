import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { Completion, KernelState, Likert, Proposal, Review, Skill, Task, TaskStatus } from "../kernel/types.ts";
import { adjustedMinutes, categoryStats, MIN_ESTIMATE_SAMPLES } from "./estimates.ts";
import { rocWeights, scoreTasks } from "./mcda.ts";
import { reviewSchedule } from "./reviews.ts";
import { deriveView } from "./view.ts";

const T0 = "2026-10-01T00:00:00.000Z";
const NOW = "2026-10-16T00:00:00.000Z";
const DAY = 86_400_000;
const plusDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * DAY).toISOString();

function task(id: string, over: Partial<Task> = {}): Task {
	return {
		id,
		goalId: null,
		title: id,
		notes: "",
		doneWhen: "done",
		category: "code",
		estimateMinutes: 60,
		importance: 3,
		urgency: 3,
		status: "open",
		requirements: [],
		learning: null,
		createdAt: T0,
		updatedAt: T0,
		...over,
	};
}

function skill(key: string, over: Partial<Skill> = {}): Skill {
	return {
		key,
		name: key,
		description: "",
		concepts: [],
		prerequisites: [],
		resources: [],
		retrievalPrompts: ["explain it"],
		practiceMinutes: 60,
		level: 2,
		createdAt: T0,
		...over,
	};
}

function completion(taskId: string, over: Partial<Completion> = {}): Completion {
	return {
		taskId,
		status: "done",
		actualMinutes: 60,
		estimateMinutes: 60,
		category: "code",
		outcome: "ok",
		evidenceUrl: null,
		at: T0,
		...over,
	};
}

function stateOf(over: Partial<KernelState> & { taskList?: Task[]; skillList?: Skill[] } = {}): KernelState {
	const { taskList = [], skillList = [], ...rest } = over;
	return {
		seq: 0,
		nextId: 1,
		goals: {},
		tasks: Object.fromEntries(taskList.map((t) => [t.id, t])),
		blockers: {},
		completions: [],
		skills: Object.fromEntries(skillList.map((s) => [s.key, s])),
		assessments: [],
		proposals: {},
		reviews: [],
		preferences: { criteriaRank: ["importance", "urgency", "unblocks", "effort", "age"] },
		...rest,
	};
}

const likert = fc.constantFrom<Likert>(1, 2, 3, 4, 5);
const status = fc.constantFrom<TaskStatus>("open", "doing", "done", "cancelled");

/** Random DAG: task i may only be blocked by tasks with smaller index. */
const dagState = fc
	.array(
		fc.record({
			importance: likert,
			urgency: likert,
			status,
			estimate: fc.integer({ min: 1, max: 600 }),
			ageDays: fc.integer({ min: 0, max: 30 }),
			blockers: fc.array(fc.nat(), { maxLength: 3 }),
		}),
		{ minLength: 1, maxLength: 15 },
	)
	.map((rows) => {
		const taskList = rows.map((r, i) =>
			task(`T${i}`, {
				importance: r.importance,
				urgency: r.urgency,
				status: r.status,
				estimateMinutes: r.estimate,
				createdAt: plusDays(NOW, -r.ageDays),
			}),
		);
		const blockers: Record<string, string[]> = {};
		rows.forEach((r, i) => {
			if (i === 0) return;
			const ids = [...new Set(r.blockers.map((b) => `T${b % i}`))];
			if (ids.length > 0) blockers[`T${i}`] = ids;
		});
		return stateOf({ taskList, blockers });
	});

describe("rocWeights", () => {
	it("five criteria match the 4-decimal table and sum to 1", () => {
		const w = rocWeights(["importance", "urgency", "unblocks", "effort", "age"]);
		expect([w.importance, w.urgency, w.unblocks, w.effort, w.age].map((x) => x.toFixed(4))).toEqual([
			"0.4567",
			"0.2567",
			"0.1567",
			"0.0900",
			"0.0400",
		]);
		expect(w.importance + w.urgency + w.unblocks + w.effort + w.age).toBeCloseTo(1, 12);
	});

	test.prop([fc.shuffledSubarray(["importance", "urgency", "unblocks", "effort", "age"] as const, { minLength: 5 })])(
		"any ranking sums to 1 and is strictly decreasing by rank",
		(rank) => {
			const w = rocWeights(rank);
			const ordered = rank.map((c) => w[c]);
			expect(ordered.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
			for (let i = 1; i < ordered.length; i++) expect(ordered[i]).toBeLessThan(ordered[i - 1] as number);
		},
	);
});

describe("scoreTasks", () => {
	test.prop([dagState])("effective ≥ score and every blocker's effective ≥ each active dependent's", (state) => {
		const scores = scoreTasks(state, NOW);
		for (const s of Object.values(scores)) {
			expect(s.effective).toBeGreaterThanOrEqual(s.score);
			expect(s.score).toBeGreaterThanOrEqual(0);
			expect(s.score).toBeLessThanOrEqual(100);
			if (s.inheritedFrom !== null) expect(s.effective).toBe(scores[s.inheritedFrom]?.score);
			const sum = Object.values(s.components).reduce((acc, c) => acc + c.contribution, 0);
			expect(Math.round(sum * 10) / 10).toBe(s.score);
			for (const c of Object.values(s.components)) expect(c.contribution).toBeCloseTo(100 * c.weight * c.normalized, 9);
		}
		for (const [taskId, blockers] of Object.entries(state.blockers)) {
			const dep = scores[taskId];
			if (dep === undefined) continue;
			for (const b of blockers) {
				const blocker = scores[b];
				if (blocker !== undefined) expect(blocker.effective).toBeGreaterThanOrEqual(dep.effective);
			}
		}
		for (const t of Object.values(state.tasks)) {
			expect(t.id in scores).toBe(t.status === "open" || t.status === "doing");
		}
	});

	test.prop([dagState, fc.nat()])("raising importance of one task never lowers its score", (state, pick) => {
		const ids = Object.keys(state.tasks);
		const id = ids[pick % ids.length] as string;
		const t = state.tasks[id] as Task;
		if (t.importance === 5) return;
		const raised = { ...state, tasks: { ...state.tasks, [id]: { ...t, importance: (t.importance + 1) as Likert } } };
		const before = scoreTasks(state, NOW)[id];
		const after = scoreTasks(raised, NOW)[id];
		if (before === undefined) expect(after).toBeUndefined();
		else expect(after?.score).toBeGreaterThanOrEqual(before.score);
	});

	it("zero-range criteria contribute 0", () => {
		const state = stateOf({ taskList: [task("T1"), task("T2", { importance: 5 })] });
		const scores = scoreTasks(state, NOW);
		for (const s of Object.values(scores)) {
			for (const c of ["unblocks", "effort", "age"] as const) {
				expect(s.components[c].normalized).toBe(0);
				expect(s.components[c].contribution).toBe(0);
			}
		}
		// T2: importance 5 → 1·w1 + urgency 3 → 0.5·w2 = 137/300 + 77/600 → 58.5
		expect(scores.T2?.score).toBe(58.5);
	});

	it("transitive unblocks counts distinct active downstream tasks; learning task inherits", () => {
		// L blocks A; A blocks B and C; B blocks C; D closed downstream of A.
		const state = stateOf({
			taskList: [
				task("L", { importance: 1, urgency: 1 }),
				task("A", { importance: 1, urgency: 1 }),
				task("B"),
				task("C", { importance: 5, urgency: 5 }),
				task("D", { status: "done" }),
			],
			blockers: { A: ["L"], B: ["A"], C: ["A", "B"], D: ["A"] },
		});
		const s = scoreTasks(state, NOW);
		expect(s.L?.components.unblocks.raw).toBe(3);
		expect(s.A?.components.unblocks.raw).toBe(2);
		expect(s.C?.components.unblocks.raw).toBe(0);
		expect(s.L?.effective).toBe(s.C?.score);
		expect(s.L?.inheritedFrom).toBe("C");
		expect(s.C?.inheritedFrom).toBeNull();
	});
});

describe("estimates", () => {
	const ratioCompletions = (ratios: number[]): Completion[] =>
		ratios.map((r, i) => completion(`T${i}`, { estimateMinutes: 100, actualMinutes: 100 * r }));

	it("below MIN_ESTIMATE_SAMPLES the ratio is not applied", () => {
		const stats = categoryStats(stateOf({ completions: ratioCompletions([2, 2]) })).code;
		expect(stats?.samples).toBe(MIN_ESTIMATE_SAMPLES - 1);
		expect(stats?.applied).toBe(false);
		expect(adjustedMinutes(stats, 30)).toBe(30);
		expect(adjustedMinutes(undefined, 30)).toBe(30);
	});

	it("median and MAD on known data; excluded rows ignored", () => {
		const completions = [
			...ratioCompletions([1, 1.5, 2, 4]),
			completion("X1", { actualMinutes: null }),
			completion("X2", { status: "cancelled" }),
			completion("X3", { actualMinutes: 0 }),
		];
		const stats = categoryStats(stateOf({ completions })).code;
		expect(stats?.samples).toBe(4);
		expect(stats?.medianRatio).toBeCloseTo(1.75, 12);
		// deviations 0.75, 0.25, 0.25, 2.25 → median 0.5
		expect(stats?.mad).toBeCloseTo(0.5, 12);
		expect(stats?.applied).toBe(true);
	});

	it("ceil does not inflate float noise: 10 × 1.1 = 11", () => {
		const stats = categoryStats(stateOf({ completions: ratioCompletions([1.1, 1.1, 1.1]) })).code;
		expect(adjustedMinutes(stats, 10)).toBe(11);
		expect(adjustedMinutes(stats, 1)).toBe(2);
	});

	test.prop([
		fc.array(fc.double({ min: 0.01, max: 10, noNaN: true }), { minLength: 3, maxLength: 9 }),
		fc.integer({ min: 1, max: 1000 }),
	])("applied adjustment is ≥ 1 and within one minute of raw × median", (ratios, raw) => {
		const stats = categoryStats(stateOf({ completions: ratioCompletions(ratios) })).code;
		const adj = adjustedMinutes(stats, raw);
		const exact = raw * (stats?.medianRatio as number);
		expect(adj).toBeGreaterThanOrEqual(1);
		expect(adj).toBeGreaterThanOrEqual(exact - 1e-6);
		expect(adj).toBeLessThan(Math.max(exact, 1) + 1);
	});
});

describe("reviewSchedule", () => {
	const learnTask = task("L1", {
		status: "done",
		learning: {
			skill: "rust",
			targetLevel: 3,
			activity: "independent-project",
			deliverable: "d",
			retrievalPrompts: [],
			resources: [],
		},
	});
	const base = (reviews: Review[]): KernelState =>
		stateOf({
			taskList: [learnTask],
			skillList: [skill("rust", { retrievalPrompts: ["p1", "p2"] }), skill("idle")],
			completions: [completion("L1", { at: T0 })],
			reviews,
		});

	it("all recalled yields intervals 1, 6, 15, 38, 95", () => {
		const reviews: Review[] = [];
		let at = T0;
		const seen: number[] = [];
		for (let i = 0; i < 5; i++) {
			const [item] = reviewSchedule(base(reviews), NOW);
			seen.push(item?.intervalDays as number);
			expect(item?.dueAt).toBe(plusDays(at, item?.intervalDays as number));
			at = item?.dueAt as string;
			reviews.push({ skill: "rust", recalled: true, at });
		}
		expect(seen).toEqual([1, 6, 15, 38, 95]);
	});

	it("forgetting resets streak and interval to 1 day", () => {
		const r1 = plusDays(T0, 1);
		const r2 = plusDays(T0, 7);
		const r3 = plusDays(T0, 8);
		const [item] = reviewSchedule(
			base([
				{ skill: "rust", recalled: true, at: r1 },
				{ skill: "rust", recalled: true, at: r2 },
				{ skill: "rust", recalled: false, at: r3 },
			]),
			NOW,
		);
		expect(item?.streak).toBe(0);
		expect(item?.intervalDays).toBe(1);
		expect(item?.lastReviewAt).toBe(r3);
		expect(item?.dueAt).toBe(plusDays(r3, 1));
	});

	it("due flag at the boundary; only skills with done learning tasks; prompts from skill", () => {
		const dueAt = plusDays(T0, 1);
		const atDue = reviewSchedule(base([]), dueAt);
		expect(atDue.map((r) => r.skill)).toEqual(["rust"]);
		expect(atDue[0]?.due).toBe(true);
		expect(atDue[0]?.prompts).toEqual(["p1", "p2"]);
		expect(reviewSchedule(base([]), new Date(Date.parse(dueAt) - 1).toISOString())[0]?.due).toBe(false);
	});

	it("reviews before the anchor are ignored", () => {
		const [item] = reviewSchedule(base([{ skill: "rust", recalled: true, at: plusDays(T0, -3) }]), NOW);
		expect(item?.streak).toBe(0);
		expect(item?.lastReviewAt).toBeNull();
	});

	it("a done task that develops skills starts their reviews; open or cancelled ones do not", () => {
		const done = plusDays(T0, 2);
		const reviews = reviewSchedule(
			stateOf({
				taskList: [
					task("R1", {
						status: "done",
						category: "reading",
						develops: [
							{ skill: "proofs", level: 2 },
							{ skill: "logic", level: 1 },
						],
					}),
					task("R2", { status: "cancelled", develops: [{ skill: "topology", level: 1 }] }),
					task("R3", { status: "open", develops: [{ skill: "algebra", level: 1 }] }),
				],
				skillList: [
					skill("proofs", { retrievalPrompts: ["prove it"] }),
					skill("logic"),
					skill("topology"),
					skill("algebra"),
				],
				completions: [completion("R1", { at: done }), completion("R2", { status: "cancelled", at: done })],
			}),
			NOW,
		);
		expect(reviews.map((r) => [r.skill, r.dueAt, r.streak])).toEqual([
			["logic", plusDays(done, 1), 0],
			["proofs", plusDays(done, 1), 0],
		]);
		expect(reviews[1]?.prompts).toEqual(["prove it"]);
	});
});

describe("deriveView", () => {
	const learning = (skillKey: string, status: TaskStatus = "open") =>
		task(`L-${skillKey}`, {
			status,
			learning: {
				skill: skillKey,
				targetLevel: 3,
				activity: "independent-project",
				deliverable: "d",
				retrievalPrompts: [],
				resources: [],
			},
		});
	const levelProposal = (id: string, skillKey: string): Proposal => ({
		id,
		status: "pending",
		actor: "system",
		payload: { kind: "level", skill: skillKey, level: 3, evidence: "e", fromTaskId: null },
		supersedes: null,
		note: "",
		createdAt: T0,
		decidedAt: null,
	});

	it("skill state precedence: proposed > learning > gap > unassessed > assessed", () => {
		const state = stateOf({
			skillList: [
				skill("proposed", { level: 1 }),
				skill("learning", { level: 1 }),
				skill("gap", { level: 1 }),
				skill("gapnull", { level: null }),
				skill("unassessed", { level: null }),
				skill("assessed", { level: 2 }),
			],
			taskList: [
				task("W", {
					requirements: [
						{ skill: "proposed", level: 3 },
						{ skill: "learning", level: 3 },
						{ skill: "gap", level: 3 },
						{ skill: "gapnull", level: 1 },
						{ skill: "assessed", level: 2 },
					],
				}),
				learning("proposed"),
				learning("learning"),
				task("Old", { status: "done", requirements: [{ skill: "unassessed", level: 5 }] }),
			],
			proposals: { P1: levelProposal("P1", "proposed") },
		});
		const states = Object.fromEntries(deriveView(state, NOW).skills.map((s) => [s.skill.key, s.state]));
		expect(states).toEqual({
			proposed: "proposed",
			learning: "learning",
			gap: "gap",
			gapnull: "gap",
			unassessed: "unassessed",
			assessed: "assessed",
		});
	});

	it("focus excludes blocked and closed tasks and splits learning work", () => {
		const state = stateOf({
			skillList: [skill("rust", { level: 1 })],
			taskList: [
				task("Ready", { importance: 5 }),
				task("Ready2", { importance: 1 }),
				task("DepBlocked"),
				task("GapBlocked", { requirements: [{ skill: "rust", level: 3 }] }),
				task("Closed", { status: "done" }),
				task("Gone", { status: "cancelled" }),
				learning("rust"),
			],
			blockers: { DepBlocked: ["Ready"], GapBlocked: ["L-rust"] },
		});
		const view = deriveView(state, NOW);
		expect(view.focus.next).toEqual(["Ready", "Ready2"]);
		expect(view.focus.learning).toEqual(["L-rust"]);
		const byId = Object.fromEntries(view.tasks.map((t) => [t.task.id, t]));
		expect(byId.Closed?.score).toBeNull();
		expect(byId.DepBlocked?.blockedBy).toEqual(["Ready"]);
		expect(byId.Ready?.dependents).toEqual(["DepBlocked"]);
		expect(view.tasks.slice(-2).every((t) => t.task.status === "done" || t.task.status === "cancelled")).toBe(true);
	});

	test.prop([dagState])("focus is exactly the ready active tasks, ranked by effective desc", (state) => {
		const view = deriveView(state, NOW);
		const readyIds = view.tasks.filter((t) => t.ready).map((t) => t.task.id);
		expect([...view.focus.next].sort()).toEqual([...readyIds].sort());
		const eff = view.focus.next.map((id) => view.tasks.find((t) => t.task.id === id)?.score?.effective as number);
		for (let i = 1; i < eff.length; i++) expect(eff[i]).toBeLessThanOrEqual(eff[i - 1] as number);
	});
});

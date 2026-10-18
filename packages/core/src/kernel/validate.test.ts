import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { NewSkill, NewTask } from "./events.ts";
import type {
	DraftSkill,
	DraftTask,
	KernelState,
	Likert,
	PlanDraft,
	Requirement,
	Skill,
	TargetLevel,
	Task,
} from "./types.ts";
import { SKILL_KEY_PATTERN, validateDraft, validateNewSkill, validateNewTask, validateTaskPatch } from "./validate.ts";

const AT = "2026-10-16T09:30:00.000Z";

function state(skills: readonly Skill[] = [], goals: readonly string[] = []): KernelState {
	return {
		seq: 0,
		nextId: 1,
		goals: Object.fromEntries(goals.map((id) => [id, { id, title: id, summary: "", proposalId: null, createdAt: AT }])),
		tasks: {},
		blockers: {},
		completions: [],
		skills: Object.fromEntries(skills.map((s) => [s.key, s])),
		assessments: [],
		proposals: {},
		reviews: [],
		preferences: { criteriaRank: ["importance", "urgency", "unblocks", "effort", "age"] },
	};
}

function stateSkill(key: string, prerequisites: readonly string[] = []): Skill {
	return {
		key,
		name: key,
		description: "",
		concepts: ["c"],
		prerequisites,
		resources: [],
		retrievalPrompts: ["p"],
		practiceMinutes: 60,
		level: null,
		createdAt: AT,
	};
}

// ---------- valid-draft arbitrary ----------

const nonEmpty = (max: number) =>
	fc.string({ minLength: 1, maxLength: max }).filter((s) => s.trim().length > 0 && s.length <= max);
const text = (max: number) => fc.string({ maxLength: max }).filter((s) => s.length <= max);
const likert = fc.constantFrom<Likert>(1, 2, 3, 4, 5);
const level = fc.constantFrom<TargetLevel>(1, 2, 3, 4, 5);
const keyArb = fc
	.array(fc.stringMatching(/^[a-z0-9]{1,8}$/), { minLength: 1, maxLength: 4 })
	.map((parts) => parts.join("-"));

const skillArb = (key: string, earlier: readonly string[]): fc.Arbitrary<DraftSkill> =>
	fc.record({
		key: fc.constant(key),
		name: nonEmpty(120),
		description: text(200),
		concepts: fc.array(nonEmpty(30), { minLength: 1, maxLength: 12 }),
		prerequisites: fc.subarray([...earlier]),
		resources: fc.array(
			fc.record({
				title: nonEmpty(30),
				url: fc
					.tuple(fc.constantFrom("http", "https"), keyArb)
					.map(([scheme, path]) => `${scheme}://example.com/${path}`),
			}),
			{ maxLength: 3 },
		),
		retrievalPrompts: fc.array(nonEmpty(60), { minLength: 1, maxLength: 8 }),
		practiceMinutes: fc.integer({ min: 5, max: 2400 }),
	});

const taskArb = (ref: string, earlier: readonly string[], skillKeys: readonly string[]): fc.Arbitrary<DraftTask> =>
	fc
		.record({
			ref: fc.constant(ref),
			title: nonEmpty(200),
			notes: text(300),
			doneWhen: text(200),
			category: nonEmpty(40),
			estimateMinutes: fc.integer({ min: 1, max: 100_000 }),
			importance: likert,
			urgency: likert,
			requires: fc
				.subarray([...skillKeys], { maxLength: Math.min(4, skillKeys.length) })
				.chain((keys) => fc.tuple(...keys.map((skill) => level.map((l) => ({ skill, level: l }))))),
			after: fc.subarray([...earlier]),
		})
		.chain((task) =>
			// Any draft skill at any level, except a required one only above its required level.
			fc
				.subarray([...skillKeys], { maxLength: Math.min(3, skillKeys.length) })
				.chain((keys) =>
					fc.tuple(
						...keys.flatMap((skill): fc.Arbitrary<Requirement>[] => {
							const required = task.requires.find((r) => r.skill === skill)?.level ?? 0;
							if (required === 5) return [];
							return [fc.integer({ min: required + 1, max: 5 }).map((l) => ({ skill, level: l as TargetLevel }))];
						}),
					),
				)
				.map((develops): DraftTask => (develops.length === 0 ? task : { ...task, develops })),
		);

/** Valid drafts: prerequisites and `after` only point backwards, so both graphs are acyclic by construction. */
const draftArb = (extraSkills: readonly string[] = []): fc.Arbitrary<PlanDraft> =>
	fc
		.record({
			keys: fc.uniqueArray(
				keyArb.filter((k) => k.length <= 64),
				{ minLength: 1, maxLength: 5 },
			),
			refs: fc.uniqueArray(nonEmpty(12), { minLength: 1, maxLength: 6 }),
			goal: nonEmpty(200),
			summary: text(400),
		})
		.chain(({ keys, refs, goal, summary }) =>
			fc.record({
				goal: fc.constant(goal),
				summary: fc.constant(summary),
				skills: fc.tuple(...keys.map((key, i) => skillArb(key, keys.slice(0, i)))),
				tasks: fc.tuple(...refs.map((ref, i) => taskArb(ref, refs.slice(0, i), [...keys, ...extraSkills]))),
			}),
		);

// ---------- mutations: each breaks one listed rule and names the path its error must mention ----------

type Mutation = (draft: PlanDraft) => { readonly draft: PlanDraft; readonly path: string };

const bad = <T>(value: unknown): T => value as T;
const skill0 = (d: PlanDraft, patch: Partial<Record<keyof DraftSkill, unknown>>) => ({
	draft: {
		...d,
		skills: [{ ...(d.skills[0] as DraftSkill), ...bad<Partial<DraftSkill>>(patch) }, ...d.skills.slice(1)],
	},
	path: `skills[0].${Object.keys(patch)[0]}`,
});
const task0 = (d: PlanDraft, patch: Partial<Record<keyof DraftTask, unknown>>, path?: string) => ({
	draft: { ...d, tasks: [{ ...(d.tasks[0] as DraftTask), ...bad<Partial<DraftTask>>(patch) }, ...d.tasks.slice(1)] },
	path: path ?? `tasks[0].${Object.keys(patch)[0]}`,
});
const firstKey = (d: PlanDraft) => (d.skills[0] as DraftSkill).key;
/** Never generated: keyArb yields at most 4 segments, refs at most 12 chars. */
const ABSENT_KEY = "x-x-x-x-absent";
const ABSENT_REF = "absent-ref-0000";

const MUTATIONS: Readonly<Record<string, Mutation>> = {
	"empty goal": (d) => ({ draft: { ...d, goal: "  " }, path: "goal" }),
	"long goal": (d) => ({ draft: { ...d, goal: "g".repeat(201) }, path: "goal" }),
	"long summary": (d) => ({ draft: { ...d, summary: "s".repeat(2001) }, path: "summary" }),
	"no tasks": (d) => ({ draft: { ...d, tasks: [] }, path: "tasks" }),
	"1001 tasks": (d) => ({
		draft: {
			...d,
			tasks: Array.from({ length: 1001 }, (_, i) => ({ ...(d.tasks[0] as DraftTask), ref: `bulk-${i}`, after: [] })),
		},
		path: "tasks",
	}),
	"1001 skills": (d) => ({
		draft: {
			...d,
			skills: Array.from({ length: 1001 }, (_, i) => ({
				...(d.skills[0] as DraftSkill),
				key: `bulk-${i}`,
				prerequisites: [],
			})),
			tasks: d.tasks.map(({ develops: _develops, ...t }) => ({ ...t, requires: [] })),
		},
		path: "skills",
	}),
	"key not kebab-case": (d) => skill0(d, { key: "Rust_Ownership" }),
	"key too long": (d) => skill0(d, { key: "a".repeat(65) }),
	"duplicate key": (d) => ({
		draft: { ...d, skills: [...d.skills, { ...(d.skills[0] as DraftSkill), prerequisites: [] }] },
		path: `skills[${d.skills.length}].key`,
	}),
	"empty name": (d) => skill0(d, { name: "" }),
	"long name": (d) => skill0(d, { name: "n".repeat(121) }),
	"long description": (d) => skill0(d, { description: "d".repeat(2001) }),
	"no concepts": (d) => skill0(d, { concepts: [] }),
	"13 concepts": (d) => skill0(d, { concepts: Array.from({ length: 13 }, (_, i) => `c${i}`) }),
	"blank concept": (d) => skill0(d, { concepts: ["ok", " "] }),
	"no retrieval prompts": (d) => skill0(d, { retrievalPrompts: [] }),
	"9 retrieval prompts": (d) => skill0(d, { retrievalPrompts: Array.from({ length: 9 }, (_, i) => `p${i}`) }),
	"blank retrieval prompt": (d) => skill0(d, { retrievalPrompts: [""] }),
	"practice below 5": (d) => skill0(d, { practiceMinutes: 4 }),
	"practice above 2400": (d) => skill0(d, { practiceMinutes: 2401 }),
	"fractional practice": (d) => skill0(d, { practiceMinutes: 30.5 }),
	"resource without title": (d) => ({
		...skill0(d, { resources: [{ title: "", url: "https://example.com" }] }),
		path: "skills[0].resources[0].title",
	}),
	"resource ftp url": (d) => ({
		...skill0(d, { resources: [{ title: "t", url: "ftp://example.com/x" }] }),
		path: "skills[0].resources[0].url",
	}),
	"resource unparseable url": (d) => ({
		...skill0(d, { resources: [{ title: "t", url: "https://exa mple.com/x" }] }),
		path: "skills[0].resources[0].url",
	}),
	"unknown prerequisite": (d) => ({
		...skill0(d, { prerequisites: [ABSENT_KEY] }),
		path: "skills[0].prerequisites[0]",
	}),
	"self prerequisite": (d) => ({ ...skill0(d, { prerequisites: [firstKey(d)] }), path: "skills[0].prerequisites[0]" }),
	"prerequisite cycle": (d) => {
		const extra = (key: string, prerequisite: string): DraftSkill => ({
			...(d.skills[0] as DraftSkill),
			key,
			prerequisites: [prerequisite],
		});
		const n = d.skills.length;
		return {
			draft: {
				...d,
				skills: [...d.skills, extra(`${ABSENT_KEY}-1`, `${ABSENT_KEY}-2`), extra(`${ABSENT_KEY}-2`, `${ABSENT_KEY}-1`)],
			},
			path: `skills[${n}].prerequisites`,
		};
	},
	"empty ref": (d) => task0(d, { ref: "", after: [] }),
	"duplicate ref": (d) => ({
		draft: { ...d, tasks: [...d.tasks, { ...(d.tasks[0] as DraftTask), after: [] }] },
		path: `tasks[${d.tasks.length}].ref`,
	}),
	"empty title": (d) => task0(d, { title: "" }),
	"long title": (d) => task0(d, { title: "t".repeat(201) }),
	"long doneWhen": (d) => task0(d, { doneWhen: "w".repeat(1001) }),
	"long notes": (d) => task0(d, { notes: "n".repeat(4001) }),
	"empty category": (d) => task0(d, { category: "" }),
	"long category": (d) => task0(d, { category: "c".repeat(41) }),
	"zero estimate": (d) => task0(d, { estimateMinutes: 0 }),
	"huge estimate": (d) => task0(d, { estimateMinutes: 100_001 }),
	"fractional estimate": (d) => task0(d, { estimateMinutes: 1.5 }),
	"importance 0": (d) => task0(d, { importance: 0 }),
	"importance 6": (d) => task0(d, { importance: 6 }),
	"urgency 2.5": (d) => task0(d, { urgency: 2.5 }),
	"unknown required skill": (d) =>
		task0(d, { requires: [{ skill: ABSENT_KEY, level: 1 }] }, "tasks[0].requires[0].skill"),
	"required level 0": (d) => task0(d, { requires: [{ skill: firstKey(d), level: 0 }] }, "tasks[0].requires[0].level"),
	"required level 6": (d) => task0(d, { requires: [{ skill: firstKey(d), level: 6 }] }, "tasks[0].requires[0].level"),
	"duplicate required skill": (d) =>
		task0(
			d,
			{
				requires: [
					{ skill: firstKey(d), level: 1 },
					{ skill: firstKey(d), level: 2 },
				],
			},
			"tasks[0].requires[1].skill",
		),
	"empty develops": (d) => task0(d, { develops: [] }),
	"unknown developed skill": (d) =>
		task0(d, { develops: [{ skill: ABSENT_KEY, level: 1 }] }, "tasks[0].develops[0].skill"),
	"developed level 0": (d) =>
		task0(d, { requires: [], develops: [{ skill: firstKey(d), level: 0 }] }, "tasks[0].develops[0].level"),
	"developed level 6": (d) =>
		task0(d, { requires: [], develops: [{ skill: firstKey(d), level: 6 }] }, "tasks[0].develops[0].level"),
	"duplicate developed skill": (d) =>
		task0(
			d,
			{
				requires: [],
				develops: [
					{ skill: firstKey(d), level: 1 },
					{ skill: firstKey(d), level: 2 },
				],
			},
			"tasks[0].develops[1].skill",
		),
	"develops a required skill at the required level": (d) =>
		task0(
			d,
			{ requires: [{ skill: firstKey(d), level: 3 }], develops: [{ skill: firstKey(d), level: 3 }] },
			"tasks[0].develops[0].level",
		),
	"unknown after": (d) => task0(d, { after: [ABSENT_REF] }, "tasks[0].after[0]"),
	"self after": (d) => task0(d, { after: [(d.tasks[0] as DraftTask).ref] }, "tasks[0].after[0]"),
	"after cycle": (d) => {
		const n = d.tasks.length;
		const extra = (ref: string, after: string): DraftTask => ({ ...(d.tasks[0] as DraftTask), ref, after: [after] });
		const [a, b] = [`${ABSENT_REF}-a`, `${ABSENT_REF}-b`];
		return { draft: { ...d, tasks: [...d.tasks, extra(a, b), extra(b, a)] }, path: `tasks[${n}].after` };
	},
};

describe("validateDraft", () => {
	test.prop([draftArb()])("accepts generated valid drafts", (draft) => {
		expect(validateDraft(state(), draft)).toEqual([]);
	});

	test.prop([draftArb(["known-elsewhere"])])(
		"accepts requirements on state skills and draft skills already in state",
		(draft) => {
			const reused = (draft.skills[0] as DraftSkill).key;
			expect(validateDraft(state([stateSkill("known-elsewhere"), stateSkill(reused)]), draft)).toEqual([]);
		},
	);

	test.prop([draftArb(), fc.constantFrom(...Object.keys(MUTATIONS))])(
		"rejects every listed violation with a message naming the path",
		(valid, name) => {
			const { draft, path } = (MUTATIONS[name] as Mutation)(valid);
			const errors = validateDraft(state(), draft);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.includes(path))).toBe(true);
		},
	);

	it("unknown references list the known names", () => {
		const draft: PlanDraft = {
			goal: "g",
			summary: "",
			skills: [],
			tasks: [
				{
					ref: "a",
					title: "t",
					notes: "",
					doneWhen: "",
					category: "c",
					estimateMinutes: 10,
					importance: 3,
					urgency: 3,
					requires: [{ skill: "rust-x", level: 2 }],
					after: [],
				},
			],
		};
		expect(validateDraft(state([stateSkill("b"), stateSkill("a")]), draft)).toEqual([
			'tasks[0].requires[0].skill = "rust-x" not found; known: a, b',
		]);
	});

	it("a draft prerequisite closing a cycle through state skills is rejected", () => {
		const base = state([stateSkill("b", ["c"]), stateSkill("c")]);
		const draft: PlanDraft = {
			goal: "g",
			summary: "",
			skills: [{ ...stateSkill("c", ["b"]) }],
			tasks: [
				{
					ref: "a",
					title: "t",
					notes: "",
					doneWhen: "",
					category: "c",
					estimateMinutes: 10,
					importance: 3,
					urgency: 3,
					requires: [],
					after: [],
				},
			],
		};
		expect(validateDraft(base, draft)).toEqual([
			"skills[0].prerequisites form a cycle: c -> b -> c; legal: acyclic prerequisites",
		]);
	});

	it("non-array collections and non-object entries are reported instead of throwing", () => {
		expect(validateDraft(state(), bad<PlanDraft>({ goal: "g", summary: "", skills: null, tasks: [] }))).toEqual([
			"skills = null; legal: array of 0..1000 skills",
		]);
		const errors = validateDraft(state(), bad<PlanDraft>({ goal: "g", summary: "", skills: [7], tasks: [null] }));
		expect(errors).toContain("skills[0] = 7; legal: object");
		expect(errors).toContain("tasks[0] = null; legal: object");
	});

	test.prop([fc.string({ maxLength: 70 })])("SKILL_KEY_PATTERN accepts exactly lowercase kebab-case", (s) => {
		const segments = s.split("-");
		const kebab = segments.every((seg) => seg.length > 0 && /^[a-z0-9]+$/.test(seg));
		expect(SKILL_KEY_PATTERN.test(s)).toBe(kebab);
	});
});

const newTask: NewTask = {
	goalId: "G1",
	title: "Write parser",
	notes: "",
	doneWhen: "tests pass",
	category: "feature",
	estimateMinutes: 60,
	importance: 3,
	urgency: 4,
	requirements: [{ skill: "rust", level: 2 }],
};

describe("validateNewTask / validateTaskPatch", () => {
	const base = state([stateSkill("rust")], ["G1"]);
	const stored: Task = {
		...newTask,
		id: "T1",
		status: "open",
		learning: null,
		createdAt: AT,
		updatedAt: AT,
	};

	it("accepts a well-formed task", () => {
		expect(validateNewTask(base, newTask)).toEqual([]);
	});

	test.prop([fc.integer({ min: -3, max: 9 }), fc.constantFrom("importance", "urgency")])(
		"likert fields accept exactly the integers 1..5",
		(value, field) => {
			const errors = validateNewTask(base, bad<NewTask>({ ...newTask, [field]: value }));
			expect(errors.length === 0).toBe(value >= 1 && value <= 5);
			if (errors.length > 0) expect(errors).toEqual([`${field} = ${value}; legal: integer 1..5`]);
		},
	);

	it("requirement skills must exist in state; goals must exist or be null", () => {
		expect(validateNewTask(base, { ...newTask, goalId: null, requirements: [{ skill: "go", level: 1 }] })).toEqual([
			'requirements[0].skill = "go" not found; known: rust',
		]);
		expect(validateNewTask(base, { ...newTask, goalId: "G9" })).toEqual([
			'goalId = "G9" not found; legal: null or one of G1',
		]);
	});

	it("missing required fields are errors on a new task", () => {
		const { title: _title, ...rest } = newTask;
		expect(validateNewTask(base, bad<NewTask>(rest))).toEqual([
			"title = undefined; legal: non-empty string of at most 200 chars",
		]);
	});

	it("a patch checks only the fields it carries", () => {
		expect(validateTaskPatch(base, {}, stored)).toEqual([]);
		expect(validateTaskPatch(base, { notes: "fine" }, stored)).toEqual([]);
		expect(validateTaskPatch(base, { estimateMinutes: 0, category: "" }, stored)).toEqual([
			'category = ""; legal: non-empty string of at most 40 chars',
			"estimateMinutes = 0; legal: integer 1..100000",
		]);
		expect(validateTaskPatch(base, { requirements: [{ skill: "rust", level: bad<TargetLevel>(9) }] }, stored)).toEqual([
			"requirements[0].level = 9; legal: integer 1..5",
		]);
	});

	it("develops entries must name existing skills once, at levels 1..5", () => {
		const twoSkills = state([stateSkill("rust"), stateSkill("proofs")], ["G1"]);
		expect(validateNewTask(twoSkills, { ...newTask, develops: [{ skill: "proofs", level: 2 }] })).toEqual([]);
		expect(validateNewTask(twoSkills, { ...newTask, develops: [] })).toEqual([]);
		expect(validateNewTask(twoSkills, { ...newTask, develops: [{ skill: "topology", level: 2 }] })).toEqual([
			'develops[0].skill = "topology" not found; known: proofs, rust',
		]);
		expect(
			validateNewTask(twoSkills, {
				...newTask,
				develops: [
					{ skill: "proofs", level: 2 },
					{ skill: "proofs", level: bad<TargetLevel>(0) },
				],
			}),
		).toEqual([
			'develops[1].skill = "proofs" duplicates develops[0]; legal: one entry per skill',
			"develops[1].level = 0; legal: integer 1..5",
		]);
		expect(validateTaskPatch(twoSkills, { develops: bad<Requirement[]>("proofs") }, stored)).toEqual([
			'develops = "proofs"; legal: array of {skill, level}',
		]);
	});

	it("a task can only develop a skill it requires beyond the required level", () => {
		expect(validateNewTask(base, { ...newTask, develops: [{ skill: "rust", level: 3 }] })).toEqual([]);
		expect(validateNewTask(base, { ...newTask, develops: [{ skill: "rust", level: 2 }] })).toEqual([
			'develops[0].level = 2 does not exceed requirements[0].level = 2 for "rust"; legal: integer 3..5',
		]);
		expect(
			validateNewTask(base, {
				...newTask,
				requirements: [{ skill: "rust", level: 5 }],
				develops: [{ skill: "rust", level: 5 }],
			}),
		).toEqual([
			'develops[0].level = 5 does not exceed requirements[0].level = 5 for "rust"; legal: remove the entry (requirements[0] already requires level 5)',
		]);
		// Either side of the pair may be the patched one; the other comes from the stored task.
		const developing: Task = { ...stored, develops: [{ skill: "rust", level: 3 }] };
		expect(validateTaskPatch(base, { requirements: [{ skill: "rust", level: 3 }] }, developing)).toEqual([
			'develops[0].level = 3 does not exceed requirements[0].level = 3 for "rust"; legal: integer 4..5',
		]);
		expect(validateTaskPatch(base, { develops: [{ skill: "rust", level: 1 }] }, stored)).toEqual([
			'develops[0].level = 1 does not exceed requirements[0].level = 2 for "rust"; legal: integer 3..5',
		]);
		expect(validateTaskPatch(base, { requirements: [] }, developing)).toEqual([]);
	});

	it("a learning task cannot develop skills; removing develops is always allowed", () => {
		const step: Task = {
			...stored,
			requirements: [],
			learning: {
				skill: "rust",
				targetLevel: 2,
				activity: "guided-practice",
				deliverable: "a parser",
				retrievalPrompts: ["p"],
				resources: [],
			},
		};
		expect(validateTaskPatch(base, { develops: [{ skill: "rust", level: 3 }] }, step)).toEqual([
			'develops = array(1); legal: [] (task T1 is a learning task for "rust")',
		]);
		expect(validateTaskPatch(base, { develops: [] }, step)).toEqual([]);
	});
});

const newSkill: NewSkill = {
	key: "rust-async",
	name: "Rust: async",
	description: "",
	concepts: ["futures"],
	prerequisites: ["rust"],
	resources: [{ title: "Async book", url: "https://rust-lang.github.io/async-book/" }],
	retrievalPrompts: ["What does poll return?"],
	practiceMinutes: 120,
};

describe("validateNewSkill", () => {
	it("accepts a skill whose prerequisites exist", () => {
		expect(validateNewSkill(state([stateSkill("rust")]), newSkill)).toEqual([]);
	});

	it("prerequisites must exist in state and not reference the skill", () => {
		expect(validateNewSkill(state([stateSkill("go")]), newSkill)).toEqual([
			'prerequisites[0] = "rust" not found; known: go',
		]);
		expect(validateNewSkill(state([stateSkill("rust")]), { ...newSkill, prerequisites: ["rust-async"] })).toEqual([
			'prerequisites[0] = "rust-async" references the skill itself; legal: another skill key',
		]);
	});

	it("redefining an existing skill may not close a prerequisite cycle", () => {
		const base = state([stateSkill("rust", ["rust-async"]), stateSkill("rust-async")]);
		expect(validateNewSkill(base, newSkill)).toEqual([
			"prerequisites form a cycle: rust-async -> rust -> rust-async; legal: acyclic prerequisites",
		]);
	});

	test.prop([fc.integer({ min: 0, max: 3000 })])("practiceMinutes accepts exactly 5..2400", (minutes) => {
		const errors = validateNewSkill(state([stateSkill("rust")]), { ...newSkill, practiceMinutes: minutes });
		expect(errors.length === 0).toBe(minutes >= 5 && minutes <= 2400);
	});
});

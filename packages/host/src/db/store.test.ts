import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
	ApplyResult,
	Criterion,
	EventBody,
	EventType,
	KernelEvent,
	KernelState,
	Level,
	PlanDraft,
	SkillKey,
	TargetLevel,
	TaskStatus,
} from "@dawnskill/core";
import {
	AGENT_EVENTS,
	PROPOSAL_STATUSES,
	PROPOSAL_STATUS_EDGES,
	TASK_STATUSES,
	TASK_STATUS_EDGES,
} from "@dawnskill/core";
import { userEvent } from "@dawnskill/core/user";
import { fc, test } from "@fast-check/vitest";
// `test` from @fast-check/vitest is only used as `test.prop`; deterministic examples use vitest's `it`.
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "./schema.ts";
import type { Store } from "./store.ts";
import { createStore, openStore, stateHash } from "./store.ts";

const START = Date.parse("2026-10-16T09:00:00.000Z");
const T0 = new Date(START).toISOString();
const T1 = new Date(START + 60_000).toISOString();

/** Injected clock: one minute per step. */
function at(step: number): string {
	return new Date(START + step * 60_000).toISOString();
}

/** Agent events carry the agent actor; everything else is the user's (with the UserConfirmed brand). */
function eventAt(body: EventBody, step: number): KernelEvent {
	return (AGENT_EVENTS as readonly EventType[]).includes(body.type)
		? ({ ...body, actor: "agent", at: at(step) } as KernelEvent)
		: userEvent(body, at(step));
}

function column(db: DatabaseSync, sql: string): string[] {
	return db
		.prepare(sql)
		.all()
		.map((row) => String(row.v));
}

function count(db: DatabaseSync, table: string): number {
	return Number(db.prepare(`SELECT count(*) AS v FROM ${table}`).get()?.v);
}

// ── Raw seeding for trigger tests ────────────────────────────────────────────

function seedTask(db: DatabaseSync, id: string, status: TaskStatus): void {
	db.prepare(
		`INSERT INTO tasks (id, goal_id, title, notes, done_when, category, estimate_minutes, importance, urgency, status,
			learning, created_at, updated_at) VALUES (?, NULL, ?, '', '', 'feature', 30, 3, 3, ?, NULL, ?, ?)`,
	).run(id, `Task ${id}`, status, T0, T0);
}

function seedCompletion(db: DatabaseSync, taskId: string, status: "done" | "cancelled", when: string): void {
	db.prepare(
		`INSERT INTO completions (task_id, status, actual_minutes, estimate_minutes, category, outcome, evidence_url, at)
		VALUES (?, ?, NULL, 30, 'feature', '', NULL, ?)`,
	).run(taskId, status, when);
}

function seedSkill(db: DatabaseSync, key: string): void {
	db.prepare(
		`INSERT INTO skills (key, name, description, concepts, resources, retrieval_prompts, practice_minutes, created_at)
		VALUES (?, ?, '', '[]', '[]', '[]', 30, ?)`,
	).run(key, key, T0);
}

function seedAssessment(db: DatabaseSync, skill: string, level: Level, when: string): void {
	db.prepare(
		"INSERT INTO assessments (skill, level, evidence, source, proposal_id, at) VALUES (?, ?, '', 'self', NULL, ?)",
	).run(skill, level, when);
}

function closeTask(db: DatabaseSync, id: string, status: "done" | "cancelled", when: string): void {
	seedCompletion(db, id, status, when);
	db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, when, id);
}

/** Every ordered pair of distinct statuses; rewriting the same status is not a transition. */
function orderedPairs<S extends string>(statuses: readonly S[]): ReadonlyArray<readonly [S, S]> {
	return statuses.flatMap((from) => statuses.filter((to) => to !== from).map((to) => [from, to] as const));
}

// ── (a) Trigger tests generated from the transition tables ───────────────────

describe("generated triggers", () => {
	it("allowed_transitions holds exactly the kernel edges", () => {
		const db = openDatabase(":memory:");
		expect(
			column(db, "SELECT entity || ' ' || from_status || ' ' || to_status AS v FROM allowed_transitions ORDER BY v"),
		).toEqual(
			[
				...TASK_STATUS_EDGES.map(([from, to]) => `task ${from} ${to}`),
				...PROPOSAL_STATUS_EDGES.map(([from, to]) => `proposal ${from} ${to}`),
			].sort(),
		);
		db.close();
	});

	for (const [from, to] of orderedPairs(TASK_STATUSES)) {
		const legal = TASK_STATUS_EDGES.some(([f, t]) => f === from && t === to);
		it(`task ${from} -> ${to} is ${legal ? "accepted" : "rejected"}`, () => {
			const db = openDatabase(":memory:");
			seedTask(db, "T1", from);
			// The completion precondition holds, so only the transition table decides.
			if (to === "done" || to === "cancelled") seedCompletion(db, "T1", to, T1);
			const update = () => db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = 'T1'").run(to, T1);
			if (legal) update();
			else expect(update).toThrow(`illegal task transition ${from}->${to}`);
			expect(column(db, "SELECT status AS v FROM tasks")).toEqual([legal ? to : from]);
			db.close();
		});
	}

	for (const [from, to] of orderedPairs(PROPOSAL_STATUSES)) {
		const legal = PROPOSAL_STATUS_EDGES.some(([f, t]) => f === from && t === to);
		it(`proposal ${from} -> ${to} is ${legal ? "accepted" : "rejected"}`, () => {
			const db = openDatabase(":memory:");
			db.prepare(
				`INSERT INTO proposals (id, status, actor, payload, supersedes, note, created_at, decided_at)
				VALUES ('P1', ?, 'agent', '{"kind":"level"}', NULL, '', ?, NULL)`,
			).run(from, T0);
			const update = () => db.prepare("UPDATE proposals SET status = ?, decided_at = ? WHERE id = 'P1'").run(to, T1);
			if (legal) update();
			else expect(update).toThrow(`illegal proposal transition ${from}->${to}`);
			expect(column(db, "SELECT status AS v FROM proposals")).toEqual([legal ? to : from]);
			db.close();
		});
	}

	it("rewriting the same status is not a transition", () => {
		const db = openDatabase(":memory:");
		TASK_STATUSES.forEach((status, i) => seedTask(db, `T${i}`, status));
		db.exec("UPDATE tasks SET status = status, title = 'renamed'");
		expect(column(db, "SELECT status AS v FROM tasks ORDER BY id")).toEqual([...TASK_STATUSES]);
		db.close();
	});

	it("closing needs the task's latest completion row with the same status at updated_at (K2)", () => {
		const db = openDatabase(":memory:");
		seedTask(db, "T1", "doing");
		const close = (status: string) =>
			db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = 'T1'").run(status, T1);
		expect(() => close("done")).toThrow("task T1 entering done needs its latest completion row");
		seedCompletion(db, "T1", "done", T0);
		expect(() => close("done")).toThrow("needs its latest completion row"); // wrong time
		seedCompletion(db, "T1", "done", T1);
		seedCompletion(db, "T1", "cancelled", T1);
		expect(() => close("done")).toThrow("needs its latest completion row"); // not the latest row
		close("cancelled");
		expect(column(db, "SELECT status AS v FROM tasks")).toEqual(["cancelled"]);
		db.close();
	});

	it("skills are inserted unrated and a level changes only with its latest assessment (K1)", () => {
		const db = openDatabase(":memory:");
		expect(() =>
			db
				.prepare(
					`INSERT INTO skills (key, name, description, concepts, resources, retrieval_prompts, practice_minutes, level, created_at)
					VALUES ('rust', 'Rust', '', '[]', '[]', '[]', 30, 3, ?)`,
				)
				.run(T0),
		).toThrow("skill rust must be inserted unrated");
		seedSkill(db, "rust");
		const rate = (level: Level, when: string) =>
			db.prepare("UPDATE skills SET level = ?, level_at = ? WHERE key = 'rust'").run(level, when);
		expect(() => rate(3, T0)).toThrow("skill rust level NULL->3 needs its latest assessment row");
		seedAssessment(db, "rust", 3, T0);
		seedAssessment(db, "rust", 1, T1);
		expect(() => rate(3, T0)).toThrow("needs its latest assessment row"); // a stale assessment
		rate(1, T1);
		expect(column(db, "SELECT level AS v FROM skills")).toEqual(["1"]);
		db.close();
	});

	it("dependencies are added and removed only between open tasks (K4, K7)", () => {
		const db = openDatabase(":memory:");
		for (const id of ["T1", "T2", "T3"]) seedTask(db, id, "open");
		const add = (taskId: string, blockerId: string) =>
			db.prepare("INSERT INTO dependencies (task_id, blocker_id) VALUES (?, ?)").run(taskId, blockerId);
		add("T1", "T2");
		closeTask(db, "T2", "done", T1);
		closeTask(db, "T3", "cancelled", T1);
		expect(() => add("T1", "T3")).toThrow("dependency T3 blocks T1 touches a closed task");
		expect(() => add("T3", "T1")).toThrow("touches a closed task");
		expect(() => db.exec("DELETE FROM dependencies")).toThrow("closing keeps edges (K7)");
		expect(count(db, "dependencies")).toBe(1);
		db.close();
	});
});

// ── Random scenarios: an approved plan, then random events ───────────────────

const SKILL_KEYS = ["sql-joins", "rust-traits", "ts-generics"] as const;
const NEW_SKILL = "go-channels";
const CRITERIA: readonly Criterion[] = ["importance", "urgency", "unblocks", "effort", "age"];

function draftSkill(key: SkillKey, prerequisites: readonly SkillKey[]): PlanDraft["skills"][number] {
	return {
		key,
		name: key,
		description: `${key} for the reporting service`,
		concepts: [`${key} basics`],
		prerequisites,
		resources: [{ title: `${key} guide`, url: `https://example.com/${key}` }],
		retrievalPrompts: [`Explain ${key} from memory.`],
		practiceMinutes: 45,
	};
}

function draftTask(ref: string, requires: PlanDraft["tasks"][number]["requires"], after: readonly string[]) {
	return {
		ref,
		title: `Build ${ref}`,
		notes: "",
		doneWhen: `${ref} merged`,
		category: "feature",
		estimateMinutes: 60,
		importance: 3,
		urgency: 3,
		requires,
		after,
	} as const satisfies PlanDraft["tasks"][number];
}

/** A follow-up plan: a new skill on top of the first plan's first skill. */
const REPLAN: PlanDraft = {
	goal: "Stream the reports",
	summary: "",
	skills: [draftSkill(NEW_SKILL, [SKILL_KEYS[0]])],
	tasks: [draftTask("stream", [{ skill: NEW_SKILL, level: 2 }], [])],
};

function pick(list: readonly string[], n: number): string {
	return list[n % list.length] ?? "missing";
}

function taskIds(s: KernelState, ...statuses: readonly TaskStatus[]): string[] {
	return Object.values(s.tasks)
		.filter((task) => statuses.length === 0 || statuses.includes(task.status))
		.map((task) => task.id);
}

/** Usually a task in `statuses`; every fifth pick is any task, so illegal transitions are tried too. */
function taskIn(s: KernelState, a: number, b: number, ...statuses: readonly TaskStatus[]): string {
	return pick(b % 5 === 0 ? taskIds(s) : taskIds(s, ...statuses), a);
}

function pendingIds(s: KernelState, kind?: "plan" | "level"): string[] {
	return Object.values(s.proposals)
		.filter((p) => p.status === "pending" && (kind === undefined || p.payload.kind === kind))
		.map((p) => p.id);
}

const STEPS = {
	start: (s, a, b) => ({ type: "TaskStarted", taskId: taskIn(s, a, b, "open") }),
	pause: (s, a, b) => ({ type: "TaskPaused", taskId: taskIn(s, a, b, "doing") }),
	complete: (s, a, b) => ({
		type: "TaskCompleted",
		taskId: taskIn(s, a, b, "open", "doing"),
		actualMinutes: b % 3 === 0 ? null : (b % 120) + 1,
		outcome: "worked through it",
		evidenceUrl: b % 2 === 0 ? null : `https://example.com/pr/${b}`,
	}),
	cancel: (s, a, b) => ({ type: "TaskCancelled", taskId: taskIn(s, a, b, "open", "doing"), reason: "descoped" }),
	reopen: (s, a, b) => ({ type: "TaskReopened", taskId: taskIn(s, a, b, "done", "cancelled") }),
	depAdd: (s, a, b) => ({ type: "DependencyAdded", taskId: pick(taskIds(s), a), blockerId: pick(taskIds(s), b) }),
	depRemove: (s, a) => {
		const edges = Object.entries(s.blockers).flatMap(([taskId, ids]) => ids.map((blockerId) => [taskId, blockerId]));
		const [taskId = "missing", blockerId = "missing"] = edges[a % edges.length] ?? [];
		return { type: "DependencyRemoved", taskId, blockerId };
	},
	learn: (s, a, b) => ({ type: "LearningStepsAdded", taskId: taskIn(s, a, b, "open", "doing") }),
	create: (s, a, b) => ({
		type: "TaskCreated",
		task: {
			goalId: Object.keys(s.goals)[a % 3] ?? null,
			title: `Manual ${b}`,
			notes: "",
			doneWhen: "done",
			category: "chore",
			estimateMinutes: (b % 90) + 1,
			importance: 2,
			urgency: 4,
			requirements: b % 2 === 0 ? [] : [{ skill: pick(Object.keys(s.skills), a), level: ((b % 3) + 1) as TargetLevel }],
		},
	}),
	edit: (s, a, b) => ({
		type: "TaskEdited",
		taskId: pick(taskIds(s), a),
		patch:
			b % 2 === 0
				? { title: `Edited ${b}` }
				: { requirements: [{ skill: pick(Object.keys(s.skills), b), level: ((b % 3) + 1) as TargetLevel }] },
	}),
	selfRate: (s, a, b) => ({
		type: "SkillSelfRated",
		skill: pick(Object.keys(s.skills), a),
		level: (b % 6) as Level,
		evidence: "quiz",
	}),
	propose: (s, a, b) => ({
		type: "LevelProposed",
		skill: pick(Object.keys(s.skills), a),
		level: ((b % 5) + 1) as TargetLevel,
		evidence: "demo",
	}),
	confirm: (s, a) => ({ type: "LevelConfirmed", proposalId: pick(pendingIds(s, "level"), a), evidence: "" }),
	reject: (s, a) => ({ type: "ProposalRejected", proposalId: pick(pendingIds(s), a), reason: "not now" }),
	replan: (s, _a, b) => ({
		type: "PlanProposed",
		draft: REPLAN,
		supersedes: b % 2 === 0 ? (pendingIds(s, "plan")[0] ?? null) : null,
	}),
	approve: (s, a, b) => ({
		type: "PlanApproved",
		proposalId: pick(pendingIds(s, "plan"), a),
		ratings: { [NEW_SKILL]: (b % 6) as Level },
	}),
	review: (s, a, b) => ({ type: "ReviewRecorded", skill: pick(Object.keys(s.skills), a), recalled: b % 2 === 0 }),
	prefs: (_s, a) => ({ type: "PreferencesSet", criteriaRank: [...CRITERIA.slice(a % 5), ...CRITERIA.slice(0, a % 5)] }),
} satisfies Record<string, (s: KernelState, a: number, b: number) => EventBody>;

type StepKind = keyof typeof STEPS;
const KINDS = Object.keys(STEPS) as StepKind[];

interface Scenario {
	readonly draft: PlanDraft;
	readonly ratings: Readonly<Record<SkillKey, Level>>;
	readonly steps: ReadonlyArray<{ readonly kind: StepKind; readonly a: number; readonly b: number }>;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
	.record({
		skillCount: fc.integer({ min: 1, max: SKILL_KEYS.length }),
		chained: fc.boolean(),
		tasks: fc.array(
			fc.record({
				// Required level per skill index; null = not required.
				requires: fc.array(fc.constantFrom<TargetLevel | null>(null, 1, 2, 3), {
					minLength: SKILL_KEYS.length,
					maxLength: SKILL_KEYS.length,
				}),
				after: fc.array(fc.nat(), { maxLength: 2 }),
			}),
			{ minLength: 1, maxLength: 4 },
		),
		ratings: fc.array(fc.constantFrom<Level>(0, 1, 2, 3, 4, 5), {
			minLength: SKILL_KEYS.length,
			maxLength: SKILL_KEYS.length,
		}),
		steps: fc.array(fc.record({ kind: fc.constantFrom(...KINDS), a: fc.nat(1000), b: fc.nat(1000) }), {
			maxLength: 30,
		}),
	})
	.map(({ skillCount, chained, tasks, ratings, steps }) => {
		const keys = SKILL_KEYS.slice(0, skillCount);
		const draft: PlanDraft = {
			goal: "Ship the reporting service",
			summary: "A small service with typed queries",
			skills: keys.map((key, i) => draftSkill(key, chained && i > 0 ? keys.slice(i - 1, i) : [])),
			tasks: tasks.map(({ requires, after }, i) =>
				draftTask(
					`t${i}`,
					keys.flatMap((skill, k) => {
						const level = requires[k] ?? null;
						return level === null ? [] : [{ skill, level }];
					}),
					i === 0 ? [] : [...new Set(after.map((n) => `t${n % i}`))],
				),
			),
		};
		return { draft, ratings: Object.fromEntries(keys.map((key, i) => [key, ratings[i] ?? 0])), steps };
	});

/** Agent proposes the plan, the user approves it with ratings, then the random steps follow. */
function play(
	store: Store,
	scenario: Scenario,
	check: (prev: KernelState, result: ApplyResult, kind: StepKind | null) => void,
): void {
	const step = (body: EventBody, i: number, kind: StepKind | null): void => {
		const prev = store.state;
		check(prev, store.apply(eventAt(body, i)), kind);
	};
	step({ type: "PlanProposed", draft: scenario.draft, supersedes: null }, 0, null);
	step({ type: "PlanApproved", proposalId: "P1", ratings: scenario.ratings }, 1, null);
	scenario.steps.forEach(({ kind, a, b }, i) => {
		step(STEPS[kind](store.state, a, b), i + 2, kind);
	});
	expect(
		store
			.events(0)
			.slice(0, 2)
			.map((e) => e.body.type),
	).toEqual(["PlanProposed", "PlanApproved"]);
}

// ── (b) SQL invariant oracles: each query must return zero rows ──────────────

const ORACLES: Readonly<Record<string, string>> = {
	closedWithoutMatchingCompletion: `
		SELECT t.id AS v FROM tasks t
		LEFT JOIN completions c ON c.id = (SELECT max(id) FROM completions WHERE task_id = t.id)
		WHERE t.status IN ('done', 'cancelled') AND c.status IS NOT t.status`,
	dependencyOnMissingTask: `
		SELECT task_id || '<-' || blocker_id AS v FROM dependencies
		WHERE task_id NOT IN (SELECT id FROM tasks) OR blocker_id NOT IN (SELECT id FROM tasks)`,
	levelDiffersFromLatestAssessment: `
		SELECT s.key AS v FROM skills s
		LEFT JOIN assessments a ON a.id = (SELECT max(id) FROM assessments WHERE skill = s.key)
		WHERE s.level IS NOT a.level`,
	dependencyCycle: `
		WITH RECURSIVE reach (origin, node) AS (
			SELECT task_id, blocker_id FROM dependencies
			UNION
			SELECT r.origin, d.blocker_id FROM reach r JOIN dependencies d ON d.task_id = r.node
		)
		SELECT origin AS v FROM reach WHERE origin = node`,
	// Explicit decisions in log order: an accepted proposal was accepted after it was created, and no
	// proposal is decided twice, so it was pending when accepted. Implicit supersessions (self-rating,
	// a sibling confirmation) name no proposal; the transition trigger covers those.
	acceptedWithoutPending: `
		WITH decisions (seq, id, accept) AS (
			SELECT seq, body ->> '$.proposalId', type <> 'ProposalRejected' FROM kernel_events
			WHERE type IN ('PlanApproved', 'LevelConfirmed', 'ProposalRejected')
			UNION ALL
			SELECT seq, body ->> '$.supersedes', 0 FROM kernel_events
			WHERE type = 'PlanProposed' AND body ->> '$.supersedes' IS NOT NULL
		)
		SELECT p.id AS v FROM proposals p
		WHERE p.status = 'accepted' AND NOT EXISTS (
			SELECT 1 FROM decisions d JOIN kernel_events e ON e.seq = d.seq
			WHERE d.id = p.id AND d.accept AND e.at >= p.created_at
		)
		UNION ALL
		SELECT id FROM decisions GROUP BY id HAVING count(*) > 1`,
};

function violations(db: DatabaseSync): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(ORACLES)
			.map(([name, sql]) => [name, column(db, sql)] as const)
			.filter(([, rows]) => rows.length > 0),
	);
}

/** The projection rows, rendered so they compare with `expectedProjection`. */
function projection(db: DatabaseSync): Record<string, string[]> {
	return {
		tasks: column(
			db,
			`SELECT id || ' ' || status || ' ' || updated_at || ' ' || coalesce(goal_id, '-') || ' ' ||
				coalesce(learning ->> '$.skill', '-') AS v FROM tasks ORDER BY v`,
		),
		requirements: column(db, "SELECT task_id || ' ' || skill || ' ' || level AS v FROM task_requirements ORDER BY v"),
		dependencies: column(db, "SELECT task_id || ' ' || blocker_id AS v FROM dependencies ORDER BY v"),
		skills: column(db, "SELECT key || ' ' || coalesce(level, '-') AS v FROM skills ORDER BY v"),
		prerequisites: column(db, "SELECT skill || ' ' || prerequisite AS v FROM skill_prerequisites ORDER BY v"),
		proposals: column(
			db,
			"SELECT id || ' ' || status || ' ' || coalesce(decided_at, '-') AS v FROM proposals ORDER BY v",
		),
		goals: column(db, "SELECT id AS v FROM goals ORDER BY v"),
		completions: column(
			db,
			"SELECT id || ' ' || task_id || ' ' || status || ' ' || at AS v FROM completions ORDER BY id",
		),
		assessments: column(db, "SELECT id || ' ' || skill || ' ' || level || ' ' || at AS v FROM assessments ORDER BY id"),
		reviews: column(db, "SELECT id || ' ' || skill || ' ' || recalled AS v FROM reviews ORDER BY id"),
		preferences: column(db, "SELECT criteria_rank AS v FROM preferences"),
	};
}

function expectedProjection(s: KernelState): Record<string, string[]> {
	const tasks = Object.values(s.tasks);
	const skills = Object.values(s.skills);
	return {
		tasks: tasks.map((t) => `${t.id} ${t.status} ${t.updatedAt} ${t.goalId ?? "-"} ${t.learning?.skill ?? "-"}`).sort(),
		requirements: tasks.flatMap((t) => t.requirements.map((r) => `${t.id} ${r.skill} ${r.level}`)).sort(),
		dependencies: Object.entries(s.blockers)
			.flatMap(([taskId, ids]) => ids.map((blockerId) => `${taskId} ${blockerId}`))
			.sort(),
		skills: skills.map((k) => `${k.key} ${k.level ?? "-"}`).sort(),
		prerequisites: [...new Set(skills.flatMap((k) => k.prerequisites.map((p) => `${k.key} ${p}`)))].sort(),
		proposals: Object.values(s.proposals)
			.map((p) => `${p.id} ${p.status} ${p.decidedAt ?? "-"}`)
			.sort(),
		goals: Object.keys(s.goals).sort(),
		completions: s.completions.map((c, i) => `${i + 1} ${c.taskId} ${c.status} ${c.at}`),
		assessments: s.assessments.map((a, i) => `${i + 1} ${a.skill} ${a.level} ${a.at}`),
		reviews: s.reviews.map((r, i) => `${i + 1} ${r.skill} ${r.recalled ? 1 : 0}`),
		preferences: s.seq === 0 ? [] : [JSON.stringify(s.preferences.criteriaRank)],
	};
}

describe("store: random event sequences", () => {
	const applied = new Set<StepKind>();

	test.prop([scenarioArb])(
		"after every step the SQL oracles return no rows and the projection mirrors the state",
		(scenario) => {
			const db = openDatabase(":memory:");
			const store = createStore(db);
			try {
				play(store, scenario, (prev, result, kind) => {
					if (!result.ok) {
						// (d) A rejected event writes nothing and keeps the state.
						expect(store.state).toBe(prev);
						expect(count(db, "kernel_events")).toBe(prev.seq);
						return;
					}
					if (kind !== null) applied.add(kind);
					expect(store.state).toBe(result.state);
					expect(count(db, "kernel_events")).toBe(result.state.seq);
					expect(violations(db)).toEqual({});
					expect(projection(db)).toEqual(expectedProjection(result.state));
				});
			} finally {
				store.close();
			}
		},
		60_000,
	);

	// Guards against a vacuous generator: across all runs every step kind was applied at least once.
	afterAll(() => {
		if (applied.size === 0) return; // the property was filtered out
		expect(KINDS.filter((kind) => !applied.has(kind))).toEqual([]);
	});
});

// ── (c) K8: replay from a file reproduces the state and its hash ─────────────

describe("store: K8 replay", () => {
	const dir = mkdtempSync(join(tmpdir(), "dawnskill-store-"));
	let files = 0;
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test.prop([scenarioArb])(
		"close and reopen: the replayed state deep-equals the closed one and the hashes match",
		(scenario) => {
			const file = join(dir, `replay-${files++}.sqlite`);
			const store = openStore(file);
			play(store, scenario, () => {});
			const before = store.state;
			const stored = store.events().at(-1)?.stateHash;
			store.close();
			const reopened = openStore(file);
			try {
				expect(reopened.state).toEqual(before);
				expect(stateHash(reopened.state)).toBe(stateHash(before));
				expect(stored).toBe(stateHash(before));
				expect(reopened.events().length).toBe(before.seq);
			} finally {
				reopened.close();
			}
		},
		60_000,
	);

	it("refuses to open a log whose last state hash does not match the replay", () => {
		const file = join(dir, "tampered.sqlite");
		const store = openStore(file);
		store.apply(eventAt({ type: "PreferencesSet", criteriaRank: [...CRITERIA].reverse() }, 0));
		store.close();
		const db = openDatabase(file);
		db.exec("UPDATE kernel_events SET state_hash = 'tampered'");
		db.close();
		expect(() => openStore(file)).toThrow("state hash after seq 1");
	});
});

// ── (d), (e) and rollback examples ───────────────────────────────────────────

/** In-memory store with an approved plan: T3 needs nothing, T4 waits on T3. */
function approvedStore(): { readonly db: DatabaseSync; readonly store: Store } {
	const db = openDatabase(":memory:");
	const store = createStore(db);
	const draft: PlanDraft = {
		goal: "Ship the reporting service",
		summary: "",
		skills: [draftSkill("sql-joins", [])],
		tasks: [draftTask("schema", [], []), draftTask("report", [{ skill: "sql-joins", level: 1 }], ["schema"])],
	};
	expect(store.apply(eventAt({ type: "PlanProposed", draft, supersedes: null }, 0)).ok).toBe(true);
	expect(store.apply(eventAt({ type: "PlanApproved", proposalId: "P1", ratings: { "sql-joins": 2 } }, 1)).ok).toBe(
		true,
	);
	expect(store.state.blockers).toEqual({ T4: ["T3"] });
	return { db, store };
}

describe("store: examples", () => {
	it("a rejected event writes nothing and notifies no one", () => {
		const { db, store } = approvedStore();
		const seqs: number[] = [];
		store.subscribe((seq) => seqs.push(seq));
		const prev = store.state;
		const rejected = [
			eventAt({ type: "TaskStarted", taskId: "T404" }, 2),
			eventAt({ type: "TaskStarted", taskId: "T4" }, 2), // blocked by T3
			{ ...eventAt({ type: "TaskStarted", taskId: "T3" }, 2), actor: "agent" } as KernelEvent,
			eventAt({ type: "TaskReopened", taskId: "T3" }, 2),
		];
		for (const event of rejected) expect(store.apply(event).ok).toBe(false);
		expect(store.state).toBe(prev);
		expect(count(db, "kernel_events")).toBe(2);
		expect(seqs).toEqual([]);
		expect(store.apply(eventAt({ type: "TaskStarted", taskId: "T3" }, 3)).ok).toBe(true);
		expect(seqs).toEqual([3]);
		store.close();
	});

	it("raw SQL that bypasses the kernel is aborted by the triggers", () => {
		const { db, store } = approvedStore();
		expect(store.apply(eventAt({ type: "TaskCancelled", taskId: "T3", reason: "merged elsewhere" }, 2)).ok).toBe(true);
		expect(() => db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = 'T4'").run(at(3))).toThrow(
			"task T4 entering done needs its latest completion row",
		);
		expect(() => db.exec("UPDATE tasks SET status = 'doing' WHERE id = 'T3'")).toThrow(
			"illegal task transition cancelled->doing",
		);
		expect(() => db.prepare("UPDATE skills SET level = 5, level_at = ? WHERE key = 'sql-joins'").run(at(3))).toThrow(
			"skill sql-joins level 2->5 needs its latest assessment row",
		);
		expect(() => db.exec("UPDATE proposals SET status = 'pending' WHERE id = 'P1'")).toThrow(
			"illegal proposal transition accepted->pending",
		);
		expect(() => db.exec("DELETE FROM dependencies WHERE task_id = 'T4'")).toThrow("closing keeps edges (K7)");
		expect(projection(db)).toEqual(expectedProjection(store.state));
		store.close();
	});

	it("a projection write the triggers abort rolls back and keeps the state", () => {
		const { db, store } = approvedStore();
		const extra: EventBody = {
			type: "TaskCreated",
			task: {
				goalId: null,
				title: "Extra",
				notes: "",
				doneWhen: "",
				category: "chore",
				estimateMinutes: 15,
				importance: 2,
				urgency: 2,
				requirements: [],
			},
		};
		expect(store.apply(eventAt(extra, 2)).ok).toBe(true);
		// Close T5 behind the kernel's back: the kernel still sees it open and accepts the edge.
		closeTask(db, "T5", "done", at(3));
		const seqs: number[] = [];
		store.subscribe((seq) => seqs.push(seq));
		const prev = store.state;
		expect(() => store.apply(eventAt({ type: "DependencyAdded", taskId: "T5", blockerId: "T3" }, 4))).toThrow(
			"touches a closed task",
		);
		expect(store.state).toBe(prev);
		expect(count(db, "kernel_events")).toBe(3);
		expect(count(db, "dependencies")).toBe(1);
		expect(seqs).toEqual([]);
		store.close();
	});
});

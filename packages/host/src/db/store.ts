/**
 * The one writer of kernel tables (PLAN.md §5). `apply` runs the pure kernel, then writes the changed
 * projection rows and the `kernel_events` row in one transaction; the generated triggers back it up.
 * State is rebuilt by replaying `kernel_events` on open (K8), so the projection is never read back.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Actor, ApplyResult, EventBody, KernelEvent, KernelState, SkillKey, Task, TaskId } from "@dawnskill/core";
import { apply as applyKernel, initialState } from "@dawnskill/core";
import { openDatabase } from "./schema.ts";

interface StoredEvent {
	readonly seq: number;
	readonly at: string;
	readonly actor: Actor;
	readonly body: EventBody;
	readonly stateHash: string;
}

export interface Store {
	/** Current in-memory state (replayed on open). */
	readonly state: KernelState;
	/** core.apply; when ok, one transaction writes projection rows + the kernel_events row, then subscribers hear the seq. */
	apply(event: KernelEvent): ApplyResult;
	events(afterSeq?: number): readonly StoredEvent[];
	subscribe(listener: (seq: number) => void): () => void;
	close(): void;
}

/** Opens or creates the database at `path` (`":memory:"` allowed) and replays its events. */
export function openStore(path: string): Store {
	const db = openDatabase(path);
	try {
		return createStore(db);
	} catch (error) {
		db.close();
		throw error;
	}
}

/** Store over a database already opened by `openDatabase`; closing the store closes it. */
export function createStore(db: DatabaseSync): Store {
	const writer = projectionWriter(db);
	const insertEvent = db.prepare(
		"INSERT INTO kernel_events (seq, at, actor, type, body, state_hash) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const selectEvents = db.prepare(
		"SELECT seq, at, actor, body, state_hash FROM kernel_events WHERE seq > ? ORDER BY seq",
	);
	const begin = db.prepare("BEGIN IMMEDIATE");
	const commit = db.prepare("COMMIT");
	const rollback = db.prepare("ROLLBACK");
	const listeners = new Set<(seq: number) => void>();
	let state = replay(selectEvents.iterate(0) as unknown as Iterable<EventRow>);

	return {
		get state(): KernelState {
			return state;
		},
		apply(event: KernelEvent): ApplyResult {
			const prev = state;
			const result = applyKernel(prev, event);
			if (!result.ok) return result;
			const next = result.state;
			const { at, actor, ...body } = event;
			begin.run();
			try {
				writer(prev, next);
				insertEvent.run(next.seq, at, actor, event.type, JSON.stringify(body), stateHash(next));
				commit.run();
			} catch (error) {
				if (db.isTransaction) rollback.run();
				throw error;
			}
			state = next;
			for (const listener of listeners) {
				try {
					listener(next.seq);
				} catch (error) {
					// The event is committed; one failing subscriber must not fail the writer or the others.
					console.error(`store subscriber failed at seq ${next.seq}`, error);
				}
			}
			return result;
		},
		events(afterSeq = 0): readonly StoredEvent[] {
			return (selectEvents.all(afterSeq) as unknown as EventRow[]).map((row) => ({
				seq: row.seq,
				at: row.at,
				actor: row.actor,
				body: JSON.parse(row.body) as EventBody,
				stateHash: row.state_hash,
			}));
		},
		subscribe(listener: (seq: number) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close(): void {
			listeners.clear();
			db.close();
		},
	};
}

interface EventRow {
	readonly seq: number;
	readonly at: string;
	readonly actor: Actor;
	readonly body: string;
	readonly state_hash: string;
}

/** K8: rebuild the state from the log and check it against the last stored hash. */
function replay(rows: Iterable<EventRow>): KernelState {
	let state = initialState();
	let last: EventRow | null = null;
	for (const row of rows) {
		// The UserConfirmed brand is phantom: a stored event was legal when it was applied.
		const event = { ...(JSON.parse(row.body) as EventBody), at: row.at, actor: row.actor } as KernelEvent;
		const result = applyKernel(state, event);
		if (!result.ok) {
			throw new Error(`kernel_events replay failed at seq ${row.seq} (${event.type}): ${result.message}`);
		}
		if (result.state.seq !== row.seq) {
			throw new Error(`kernel_events replay: row seq ${row.seq} replayed as state seq ${result.state.seq}`);
		}
		state = result.state;
		last = row;
	}
	if (last !== null) {
		const replayed = stateHash(state);
		if (replayed !== last.state_hash) {
			throw new Error(
				`kernel_events replay: state hash after seq ${last.seq} is ${replayed}, stored ${last.state_hash}; the log or the kernel changed`,
			);
		}
	}
	return state;
}

// ── State hash ───────────────────────────────────────────────────────────────

/** Kernel state is immutable and keeps unchanged entities by reference, so their JSON is computed once. */
const canonicalCache = new WeakMap<object, string>();

/**
 * JSON with sorted object keys; `undefined` members are dropped as JSON.stringify does. Pieces are
 * joined once per container so large records are copied once instead of once per member.
 */
function canonical(value: unknown): string {
	if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
	const cached = canonicalCache.get(value);
	if (cached !== undefined) return cached;
	const parts: string[] = [];
	if (Array.isArray(value)) {
		for (const item of value) parts.push(parts.length === 0 ? "[" : ",", canonical(item));
		parts.push(parts.length === 0 ? "[]" : "]");
	} else {
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record).sort()) {
			const member = record[key];
			if (member === undefined) continue;
			parts.push(parts.length === 0 ? "{" : ",", JSON.stringify(key), ":", canonical(member));
		}
		parts.push(parts.length === 0 ? "{}" : "}");
	}
	const json = parts.join("");
	canonicalCache.set(value, json);
	return json;
}

/** sha256 (hex) of the canonical JSON of the state; stored with every event and checked on open. */
export function stateHash(state: KernelState): string {
	return createHash("sha256").update(canonical(state)).digest("hex");
}

// ── Projection ───────────────────────────────────────────────────────────────

type Writer = (prev: KernelState, next: KernelState) => void;

/** Pairs `[next, prev]` of entities whose reference changed; the kernel never deletes these entities. */
function changed<V>(
	prev: Readonly<Record<string, V>>,
	next: Readonly<Record<string, V>>,
): Array<readonly [V, V | undefined]> {
	const out: Array<readonly [V, V | undefined]> = [];
	if (prev === next) return out;
	for (const key of Object.keys(next)) {
		const value = next[key] as V;
		const old = Object.hasOwn(prev, key) ? prev[key] : undefined;
		if (old !== value) out.push([value, old]);
	}
	return out;
}

/**
 * Diffs prev/next by object identity and writes only what changed, ordered so the triggers pass:
 * proposals → goals → skills (inserted unrated) → prerequisites → assessments → skill levels →
 * new tasks → completions → changed tasks (status after its completion row) → dependencies → reviews
 * → preferences. Foreign keys hold at every step.
 */
function projectionWriter(db: DatabaseSync): Writer {
	const insertProposal = db.prepare(
		"INSERT INTO proposals (id, status, actor, payload, supersedes, note, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const updateProposal = db.prepare(
		"UPDATE proposals SET status = ?, actor = ?, payload = ?, supersedes = ?, note = ?, created_at = ?, decided_at = ? WHERE id = ?",
	);
	const upsertGoal = db.prepare(
		`INSERT INTO goals (id, title, summary, proposal_id, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET title = excluded.title, summary = excluded.summary,
			proposal_id = excluded.proposal_id, created_at = excluded.created_at`,
	);
	const insertSkill = db.prepare(
		"INSERT INTO skills (key, name, description, concepts, resources, retrieval_prompts, practice_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const updateSkill = db.prepare(
		"UPDATE skills SET name = ?, description = ?, concepts = ?, resources = ?, retrieval_prompts = ?, practice_minutes = ?, created_at = ? WHERE key = ?",
	);
	const updateSkillLevel = db.prepare("UPDATE skills SET level = ?, level_at = ? WHERE key = ?");
	const deletePrerequisites = db.prepare("DELETE FROM skill_prerequisites WHERE skill = ?");
	// Draft validation does not reject a repeated prerequisite; the row set keeps one.
	const insertPrerequisite = db.prepare(
		"INSERT OR IGNORE INTO skill_prerequisites (skill, prerequisite) VALUES (?, ?)",
	);
	const insertAssessment = db.prepare(
		"INSERT INTO assessments (id, skill, level, evidence, source, proposal_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const insertTask = db.prepare(
		`INSERT INTO tasks (id, goal_id, title, notes, done_when, category, estimate_minutes, importance, urgency, status,
			learning, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateTask = db.prepare(
		`UPDATE tasks SET goal_id = ?, title = ?, notes = ?, done_when = ?, category = ?, estimate_minutes = ?,
			importance = ?, urgency = ?, status = ?, learning = ?, created_at = ?, updated_at = ? WHERE id = ?`,
	);
	const deleteRequirements = db.prepare("DELETE FROM task_requirements WHERE task_id = ?");
	const insertRequirement = db.prepare("INSERT INTO task_requirements (task_id, skill, level) VALUES (?, ?, ?)");
	const deleteDevelops = db.prepare("DELETE FROM task_develops WHERE task_id = ?");
	const insertDevelops = db.prepare("INSERT INTO task_develops (task_id, skill, level) VALUES (?, ?, ?)");
	const insertCompletion = db.prepare(
		`INSERT INTO completions (id, task_id, status, actual_minutes, estimate_minutes, category, outcome, evidence_url, at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertDependency = db.prepare("INSERT INTO dependencies (task_id, blocker_id) VALUES (?, ?)");
	const deleteDependency = db.prepare("DELETE FROM dependencies WHERE task_id = ? AND blocker_id = ?");
	const insertReview = db.prepare("INSERT INTO reviews (id, skill, recalled, at) VALUES (?, ?, ?, ?)");
	const upsertPreferences = db.prepare(
		"INSERT INTO preferences (id, criteria_rank) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET criteria_rank = excluded.criteria_rank",
	);

	const writeRequirements = (task: Task, old: Task | undefined): void => {
		if (old?.requirements === task.requirements) return;
		if (old !== undefined) deleteRequirements.run(task.id);
		for (const { skill, level } of task.requirements) insertRequirement.run(task.id, skill, level);
	};
	const writeDevelops = (task: Task, old: Task | undefined): void => {
		if (old !== undefined && old.develops === task.develops) return;
		if (old !== undefined) deleteDevelops.run(task.id);
		for (const { skill, level } of task.develops ?? []) insertDevelops.run(task.id, skill, level);
	};
	// INSERT and UPDATE bind the task columns in this one order.
	const taskColumns = (t: Task) =>
		[
			t.goalId,
			t.title,
			t.notes,
			t.doneWhen,
			t.category,
			t.estimateMinutes,
			t.importance,
			t.urgency,
			t.status,
			t.learning === null ? null : JSON.stringify(t.learning),
			t.createdAt,
			t.updatedAt,
		] as const;

	return (prev, next) => {
		for (const [p, old] of changed(prev.proposals, next.proposals)) {
			const payload = JSON.stringify(p.payload);
			const columns = [p.status, p.actor, payload, p.supersedes, p.note, p.createdAt, p.decidedAt] as const;
			if (old === undefined) insertProposal.run(p.id, ...columns);
			else updateProposal.run(...columns, p.id);
		}

		for (const [goal] of changed(prev.goals, next.goals)) {
			upsertGoal.run(goal.id, goal.title, goal.summary, goal.proposalId, goal.createdAt);
		}

		const skills = changed(prev.skills, next.skills);
		for (const [s, old] of skills) {
			const columns = [
				s.name,
				s.description,
				JSON.stringify(s.concepts),
				JSON.stringify(s.resources),
				JSON.stringify(s.retrievalPrompts),
				s.practiceMinutes,
				s.createdAt,
			] as const;
			if (old === undefined) insertSkill.run(s.key, ...columns);
			else updateSkill.run(...columns, s.key);
		}
		for (const [s, old] of skills) {
			if (old?.prerequisites === s.prerequisites) continue;
			if (old !== undefined) deletePrerequisites.run(s.key);
			for (const prerequisite of s.prerequisites) insertPrerequisite.run(s.key, prerequisite);
		}

		const levelAt = new Map<SkillKey, string>();
		for (let i = prev.assessments.length; i < next.assessments.length; i++) {
			const a = next.assessments[i];
			if (a === undefined) continue;
			insertAssessment.run(i + 1, a.skill, a.level, a.evidence, a.source, a.proposalId, a.at);
			levelAt.set(a.skill, a.at);
		}
		for (const [s, old] of skills) {
			// A level change without an assessment in this step gets a null level_at, which the trigger rejects.
			if (s.level !== (old?.level ?? null)) updateSkillLevel.run(s.level, levelAt.get(s.key) ?? null, s.key);
		}

		const tasks = changed(prev.tasks, next.tasks);
		for (const [task, old] of tasks) {
			if (old !== undefined) continue;
			insertTask.run(task.id, ...taskColumns(task));
			writeRequirements(task, undefined);
			writeDevelops(task, undefined);
		}
		for (let i = prev.completions.length; i < next.completions.length; i++) {
			const c = next.completions[i];
			if (c === undefined) continue;
			insertCompletion.run(
				i + 1,
				c.taskId,
				c.status,
				c.actualMinutes,
				c.estimateMinutes,
				c.category,
				c.outcome,
				c.evidenceUrl,
				c.at,
			);
		}
		for (const [task, old] of tasks) {
			if (old === undefined) continue;
			updateTask.run(...taskColumns(task), task.id);
			writeRequirements(task, old);
			writeDevelops(task, old);
		}

		if (prev.blockers !== next.blockers) {
			const none: readonly TaskId[] = [];
			for (const [taskId, before] of Object.entries(prev.blockers)) {
				const after = Object.hasOwn(next.blockers, taskId) ? (next.blockers[taskId] ?? none) : none;
				if (after === before) continue;
				for (const blockerId of before) if (!after.includes(blockerId)) deleteDependency.run(taskId, blockerId);
			}
			for (const [taskId, after] of Object.entries(next.blockers)) {
				const before = Object.hasOwn(prev.blockers, taskId) ? (prev.blockers[taskId] ?? none) : none;
				if (after === before) continue;
				for (const blockerId of after) if (!before.includes(blockerId)) insertDependency.run(taskId, blockerId);
			}
		}

		for (let i = prev.reviews.length; i < next.reviews.length; i++) {
			const r = next.reviews[i];
			if (r !== undefined) insertReview.run(i + 1, r.skill, r.recalled ? 1 : 0, r.at);
		}

		// The first event also writes the default so the singleton row exists from then on.
		if (prev.preferences !== next.preferences || prev.seq === 0) {
			upsertPreferences.run(JSON.stringify(next.preferences.criteriaRank));
		}
	};
}

/**
 * SQLite schema: versioned migrations tracked by `PRAGMA user_version`, plus the generated kernel
 * triggers (triggers.ts), reinstalled on every open so they always match the transition tables.
 * Tables are a projection of the kernel state; `kernel_events` is the source of truth (K8).
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { TRIGGERS_SQL_PATH } from "./triggers.ts";

/** Append-only: never edit a shipped migration, add the next one. Index i upgrades version i to i + 1. */
const MIGRATIONS: readonly string[] = [
	`
CREATE TABLE kernel_events (
	seq INTEGER PRIMARY KEY CHECK (seq >= 1),
	at TEXT NOT NULL,
	actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
	type TEXT NOT NULL,
	body TEXT NOT NULL CHECK (json_valid(body)),
	state_hash TEXT NOT NULL
) STRICT;

CREATE TABLE proposals (
	id TEXT PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
	actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
	payload TEXT NOT NULL CHECK (json_valid(payload)),
	supersedes TEXT REFERENCES proposals (id),
	note TEXT NOT NULL,
	created_at TEXT NOT NULL,
	decided_at TEXT
) STRICT;

CREATE TABLE goals (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	summary TEXT NOT NULL,
	proposal_id TEXT REFERENCES proposals (id),
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE skills (
	key TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	concepts TEXT NOT NULL CHECK (json_valid(concepts)),
	resources TEXT NOT NULL CHECK (json_valid(resources)),
	retrieval_prompts TEXT NOT NULL CHECK (json_valid(retrieval_prompts)),
	practice_minutes INTEGER NOT NULL CHECK (practice_minutes >= 1),
	level INTEGER CHECK (level BETWEEN 0 AND 5),
	level_at TEXT,
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE skill_prerequisites (
	skill TEXT NOT NULL REFERENCES skills (key),
	prerequisite TEXT NOT NULL REFERENCES skills (key),
	PRIMARY KEY (skill, prerequisite)
) STRICT, WITHOUT ROWID;

CREATE TABLE assessments (
	id INTEGER PRIMARY KEY,
	skill TEXT NOT NULL REFERENCES skills (key),
	level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 5),
	evidence TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('self', 'confirmed')),
	proposal_id TEXT REFERENCES proposals (id),
	at TEXT NOT NULL,
	CHECK ((source = 'confirmed') = (proposal_id IS NOT NULL))
) STRICT;
CREATE INDEX assessments_skill ON assessments (skill, id);

CREATE TABLE tasks (
	id TEXT PRIMARY KEY,
	goal_id TEXT REFERENCES goals (id),
	title TEXT NOT NULL,
	notes TEXT NOT NULL,
	done_when TEXT NOT NULL,
	category TEXT NOT NULL,
	estimate_minutes INTEGER NOT NULL CHECK (estimate_minutes >= 1),
	importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
	urgency INTEGER NOT NULL CHECK (urgency BETWEEN 1 AND 5),
	status TEXT NOT NULL CHECK (status IN ('open', 'doing', 'done', 'cancelled')),
	learning TEXT CHECK (learning IS NULL OR json_valid(learning)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE task_requirements (
	task_id TEXT NOT NULL REFERENCES tasks (id),
	skill TEXT NOT NULL REFERENCES skills (key),
	level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
	PRIMARY KEY (task_id, skill)
) STRICT, WITHOUT ROWID;

CREATE TABLE dependencies (
	task_id TEXT NOT NULL REFERENCES tasks (id),
	blocker_id TEXT NOT NULL REFERENCES tasks (id),
	PRIMARY KEY (task_id, blocker_id),
	CHECK (task_id <> blocker_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX dependencies_blocker ON dependencies (blocker_id);

CREATE TABLE completions (
	id INTEGER PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks (id),
	status TEXT NOT NULL CHECK (status IN ('done', 'cancelled')),
	actual_minutes INTEGER CHECK (actual_minutes >= 1),
	estimate_minutes INTEGER NOT NULL CHECK (estimate_minutes >= 1),
	category TEXT NOT NULL,
	outcome TEXT NOT NULL,
	evidence_url TEXT,
	at TEXT NOT NULL
) STRICT;
CREATE INDEX completions_task ON completions (task_id, id);

CREATE TABLE reviews (
	id INTEGER PRIMARY KEY,
	skill TEXT NOT NULL REFERENCES skills (key),
	recalled INTEGER NOT NULL CHECK (recalled IN (0, 1)),
	at TEXT NOT NULL
) STRICT;

CREATE TABLE preferences (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	criteria_rank TEXT NOT NULL CHECK (json_valid(criteria_rank) AND json_array_length(criteria_rank) = 5)
) STRICT;

CREATE TABLE allowed_transitions (
	entity TEXT NOT NULL CHECK (entity IN ('task', 'proposal')),
	from_status TEXT NOT NULL,
	to_status TEXT NOT NULL,
	PRIMARY KEY (entity, from_status, to_status)
) STRICT, WITHOUT ROWID;
`,
	`
CREATE TABLE task_develops (
	task_id TEXT NOT NULL REFERENCES tasks (id),
	skill TEXT NOT NULL REFERENCES skills (key),
	level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
	PRIMARY KEY (task_id, skill)
) STRICT, WITHOUT ROWID;
`,
];

/** Opens (creating if needed) and migrates a database; `":memory:"` gives a private in-memory one. */
export function openDatabase(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	try {
		db.exec(`
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;`);
		migrate(db);
	} catch (error) {
		db.close();
		throw error;
	}
	return db;
}

function migrate(db: DatabaseSync): void {
	const triggers = readFileSync(TRIGGERS_SQL_PATH, "utf8");
	db.exec("BEGIN IMMEDIATE");
	try {
		const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (version > MIGRATIONS.length) {
			throw new Error(`database schema version ${version} is newer than this build supports (${MIGRATIONS.length})`);
		}
		for (const sql of MIGRATIONS.slice(version)) db.exec(sql);
		db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
		db.exec(triggers);
		db.exec("COMMIT");
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}

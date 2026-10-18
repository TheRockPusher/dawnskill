import {
	ACTIVITY_GUIDE,
	canTaskTransition,
	LEVEL_NAMES,
	MIN_ESTIMATE_SAMPLES,
	type EventBody,
	type Likert,
	type Requirement,
	type TargetLevel,
	type Task,
	type TaskPatch,
	type TaskStatus,
	type TaskView,
	type View,
} from "@dawnskill/core";
import { useState } from "preact/hooks";
import { sendEvent } from "../api.ts";
import { ActionButton, LevelBadge, minutes, ScoreBreakdown, SkillLink, TaskLink, taskById, when } from "../ui.tsx";
import "./catalog.css";

// ── Shared helpers (also used by skills.tsx) ────────────────────────────────

/** Sends one event from a form; keeps the kernel's refusal message for inline display. */
export function useSend() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const send = async (body: EventBody): Promise<boolean> => {
		setBusy(true);
		const result = await sendEvent(body);
		setBusy(false);
		setError(result.ok ? null : result.message);
		return result.ok;
	};
	return { busy, error, setError, send };
}

export function isActive(status: TaskStatus): boolean {
	return status === "open" || status === "doing";
}

export function StatusChip({ status }: { readonly status: TaskStatus }) {
	return <span class={`chip status-${status}`}>{status}</span>;
}

const TARGET_LEVELS = [1, 2, 3, 4, 5] as const satisfies readonly TargetLevel[];
const LIKERTS = [1, 2, 3, 4, 5] as const satisfies readonly Likert[];

/** The member of `list` whose string form is `value`, else `fallback` (typed parse of a <select> value). */
export function pick<T extends number>(list: readonly T[], value: string, fallback: T): T {
	return list.find((n) => String(n) === value) ?? fallback;
}

/** Same anchors the planner uses (packages/agents/src/prompt.ts). */
const IMPORTANCE_ANCHORS: Readonly<Record<Likert, string>> = {
	1: "trivial: nice to have",
	2: "minor: improves the result",
	3: "moderate: expected, could be trimmed",
	4: "major: a core part of the goal",
	5: "critical: the goal fails without it",
};

const URGENCY_ANCHORS: Readonly<Record<Likert, string>> = {
	1: "someday: no time pressure",
	2: "within months",
	3: "within weeks",
	4: "this week",
	5: "now: within days, or others are waiting",
};

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function goalTitle(view: View, goalId: string | null): string | null {
	if (goalId === null) return null;
	return view.goals.find((g) => g.goal.id === goalId)?.goal.title ?? goalId;
}

function KindLabel({ task }: { readonly task: Task }) {
	return task.learning === null ? (
		<span class="kind kind-work">work</span>
	) : (
		<span class="kind kind-learning">learning</span>
	);
}

// ── Task list ───────────────────────────────────────────────────────────────

const STATUS_FILTERS = ["active", "open", "doing", "done", "cancelled", "all"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const KIND_FILTERS = ["all", "work", "learning"] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

function matchesStatus(filter: StatusFilter, status: TaskStatus): boolean {
	if (filter === "all") return true;
	if (filter === "active") return isActive(status);
	return filter === status;
}

export function Tasks({ view }: { readonly view: View }) {
	const [status, setStatus] = useState<StatusFilter>("active");
	const [kind, setKind] = useState<KindFilter>("all");
	const [goal, setGoal] = useState("all");
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	const rows = view.tasks.filter(
		({ task }) =>
			matchesStatus(status, task.status) &&
			(kind === "all" || (kind === "learning") === (task.learning !== null)) &&
			(goal === "all" || (goal === "none" ? task.goalId === null : task.goalId === goal)) &&
			(q === "" ||
				`${task.id} ${task.title} ${task.notes} ${task.doneWhen} ${task.category}`.toLowerCase().includes(q)),
	);
	const ready = rows.filter((t) => t.ready).length;
	return (
		<div class="stack">
			<h1>Tasks</h1>
			<form class="row filters" onSubmit={(e) => e.preventDefault()}>
				<label>
					Status
					<select value={status} onChange={(e) => setStatus(pickString(STATUS_FILTERS, e.currentTarget.value))}>
						{STATUS_FILTERS.map((s) => (
							<option key={s} value={s}>
								{s} ({view.tasks.filter((t) => matchesStatus(s, t.task.status)).length})
							</option>
						))}
					</select>
				</label>
				<label>
					Kind
					<select value={kind} onChange={(e) => setKind(pickString(KIND_FILTERS, e.currentTarget.value))}>
						{KIND_FILTERS.map((k) => (
							<option key={k} value={k}>
								{k}
							</option>
						))}
					</select>
				</label>
				<label>
					Goal
					<select value={goal} onChange={(e) => setGoal(e.currentTarget.value)}>
						<option value="all">all goals</option>
						<option value="none">no goal</option>
						{view.goals.map((g) => (
							<option key={g.goal.id} value={g.goal.id}>
								{g.goal.title}
							</option>
						))}
					</select>
				</label>
				<label class="grow">
					Search
					<input
						type="search"
						value={query}
						placeholder="title, notes, category, id"
						onInput={(e) => setQuery(e.currentTarget.value)}
					/>
				</label>
			</form>
			<p class="muted">
				{rows.length} of {view.tasks.length} tasks · {ready} ready. Active tasks are ranked by effective priority
				(highest first), closed tasks by last change.
			</p>
			{rows.length === 0 ? (
				<p class="muted">No tasks match these filters.</p>
			) : (
				<table class="list tasks-table">
					<thead>
						<tr>
							<th>Task</th>
							<th>Kind</th>
							<th>Status</th>
							<th>Ready</th>
							<th title="Adjusted by your history when the category has enough samples, else your raw estimate">
								Estimate
							</th>
							<th title="Own MCDA score, 0–100">Score</th>
							<th title="max(own score, effective score of open tasks it unblocks); ↑ = inherited">Effective</th>
							<th>Goal</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((tv) => (
							<TaskRow key={tv.task.id} view={view} tv={tv} />
						))}
					</tbody>
				</table>
			)}
			<details class="panel">
				<summary>New task</summary>
				<NewTaskForm view={view} />
			</details>
		</div>
	);
}

function pickString<T extends string>(list: readonly T[], value: string): T {
	return list.find((s) => s === value) ?? (list[0] as T);
}

function TaskRow({ view, tv }: { readonly view: View; readonly tv: TaskView }) {
	const { task, score } = tv;
	return (
		<tr>
			<td>
				<TaskLink view={view} id={task.id} />
			</td>
			<td>
				<KindLabel task={task} />
			</td>
			<td>
				<StatusChip status={task.status} />
			</td>
			<td>
				<ReadyCell tv={tv} />
			</td>
			<td class="num">
				<EstimateCell tv={tv} />
			</td>
			<td class="num">{score ? score.score.toFixed(1) : "—"}</td>
			<td class="num">
				{score ? (
					<>
						{score.effective.toFixed(1)}
						{score.inheritedFrom ? (
							<span
								class="inherited"
								title={`Inherited from "${taskById(view, score.inheritedFrom)?.task.title ?? score.inheritedFrom}", which this task unblocks`}
							>
								↑
							</span>
						) : null}
					</>
				) : (
					"—"
				)}
			</td>
			<td>{goalTitle(view, task.goalId) ?? <span class="muted">—</span>}</td>
		</tr>
	);
}

function ReadyCell({ tv }: { readonly tv: TaskView }) {
	if (!isActive(tv.task.status)) return <span class="muted">—</span>;
	if (tv.ready) return <span class="ready">ready</span>;
	const why = [
		tv.blockedBy.length > 0 ? plural(tv.blockedBy.length, "blocker") : null,
		tv.gaps.length > 0 ? plural(tv.gaps.length, "skill gap") : null,
	]
		.filter((s) => s !== null)
		.join(" · ");
	return (
		<span class="blocked" title={`Blocked by ${why}`}>
			blocked <small>{why}</small>
		</span>
	);
}

function EstimateCell({ tv }: { readonly tv: TaskView }) {
	const { estimate, adjustedMinutes, task } = tv;
	if (!estimate.applied || estimate.medianRatio === null) {
		return (
			<span
				title={`Raw estimate; "${estimate.category}" has ${plural(estimate.samples, "sample")}, calibration starts at ${MIN_ESTIMATE_SAMPLES}`}
			>
				{minutes(task.estimateMinutes)}
			</span>
		);
	}
	return (
		<span
			title={`Raw ${minutes(task.estimateMinutes)} × median ratio ${estimate.medianRatio.toFixed(2)} from ${plural(estimate.samples, "sample")} in "${estimate.category}"`}
		>
			{minutes(adjustedMinutes)} <small class="muted">×{estimate.medianRatio.toFixed(2)}</small>
		</span>
	);
}

// ── Task form (new + edit) ──────────────────────────────────────────────────

interface Draft {
	readonly title: string;
	readonly doneWhen: string;
	readonly notes: string;
	readonly category: string;
	readonly estimate: string;
	readonly importance: Likert;
	readonly urgency: Likert;
	/** "" = no goal. */
	readonly goalId: string;
	readonly requirements: readonly Requirement[];
}

const EMPTY_DRAFT: Draft = {
	title: "",
	doneWhen: "",
	notes: "",
	category: "",
	estimate: "30",
	importance: 3,
	urgency: 3,
	goalId: "",
	requirements: [],
};

function draftOf(task: Task): Draft {
	return {
		title: task.title,
		doneWhen: task.doneWhen,
		notes: task.notes,
		category: task.category,
		estimate: String(task.estimateMinutes),
		importance: task.importance,
		urgency: task.urgency,
		goalId: task.goalId ?? "",
		requirements: task.requirements,
	};
}

/** Whole minutes ≥ 1, or null. */
function parseMinutes(value: string): number | null {
	const n = Number(value.trim());
	return value.trim() !== "" && Number.isInteger(n) && n >= 1 ? n : null;
}

function TaskFields({
	view,
	idPrefix,
	draft,
	set,
}: {
	readonly view: View;
	readonly idPrefix: string;
	readonly draft: Draft;
	readonly set: (patch: Partial<Draft>) => void;
}) {
	const listId = `${idPrefix}-categories`;
	return (
		<>
			<label>
				Title
				<input required maxLength={200} value={draft.title} onInput={(e) => set({ title: e.currentTarget.value })} />
			</label>
			<label>
				Done when <span class="muted">(a verifiable completion criterion)</span>
				<textarea
					rows={2}
					maxLength={1000}
					value={draft.doneWhen}
					onInput={(e) => set({ doneWhen: e.currentTarget.value })}
				/>
			</label>
			<label>
				Notes
				<textarea
					rows={3}
					maxLength={4000}
					value={draft.notes}
					onInput={(e) => set({ notes: e.currentTarget.value })}
				/>
			</label>
			<div class="grid">
				<label>
					Category <span class="muted">(calibrates estimates)</span>
					<input
						required
						maxLength={40}
						list={listId}
						placeholder="e.g. coding"
						value={draft.category}
						onInput={(e) => set({ category: e.currentTarget.value })}
					/>
					<datalist id={listId}>
						{[...new Set([...Object.keys(view.categories), ...view.tasks.map((t) => t.task.category)])]
							.sort()
							.map((c) => (
								<option key={c} value={c} />
							))}
					</datalist>
				</label>
				<label>
					Estimate (minutes)
					<input
						type="number"
						required
						min={1}
						step={1}
						value={draft.estimate}
						onInput={(e) => set({ estimate: e.currentTarget.value })}
					/>
				</label>
				<label>
					Importance
					<select
						value={String(draft.importance)}
						onChange={(e) => set({ importance: pick(LIKERTS, e.currentTarget.value, draft.importance) })}
					>
						{LIKERTS.map((n) => (
							<option key={n} value={String(n)}>
								{n} — {IMPORTANCE_ANCHORS[n]}
							</option>
						))}
					</select>
				</label>
				<label>
					Urgency
					<select
						value={String(draft.urgency)}
						onChange={(e) => set({ urgency: pick(LIKERTS, e.currentTarget.value, draft.urgency) })}
					>
						{LIKERTS.map((n) => (
							<option key={n} value={String(n)}>
								{n} — {URGENCY_ANCHORS[n]}
							</option>
						))}
					</select>
				</label>
				<label>
					Goal
					<select value={draft.goalId} onChange={(e) => set({ goalId: e.currentTarget.value })}>
						<option value="">No goal</option>
						{view.goals.map((g) => (
							<option key={g.goal.id} value={g.goal.id}>
								{g.goal.title}
							</option>
						))}
					</select>
				</label>
			</div>
			<RequirementsEditor view={view} value={draft.requirements} onChange={(requirements) => set({ requirements })} />
		</>
	);
}

function RequirementsEditor({
	view,
	value,
	onChange,
}: {
	readonly view: View;
	readonly value: readonly Requirement[];
	readonly onChange: (next: readonly Requirement[]) => void;
}) {
	const used = new Set(value.map((r) => r.skill));
	const free = view.skills.find((s) => !used.has(s.skill.key));
	const replace = (i: number, next: Requirement) => onChange(value.map((r, j) => (j === i ? next : r)));
	return (
		<fieldset class="stack">
			<legend>Required skills</legend>
			{value.length === 0 ? (
				<p class="muted">None. A required level above yours is a skill gap: it blocks the task until learned.</p>
			) : null}
			{value.map((r, i) => (
				<div class="row" key={r.skill}>
					<label>
						Skill
						<select value={r.skill} onChange={(e) => replace(i, { skill: e.currentTarget.value, level: r.level })}>
							{view.skills
								.filter((s) => s.skill.key === r.skill || !used.has(s.skill.key))
								.map((s) => (
									<option key={s.skill.key} value={s.skill.key}>
										{s.skill.name}
									</option>
								))}
						</select>
					</label>
					<label>
						Level
						<select
							value={String(r.level)}
							onChange={(e) =>
								replace(i, { skill: r.skill, level: pick(TARGET_LEVELS, e.currentTarget.value, r.level) })
							}
						>
							{TARGET_LEVELS.map((l) => (
								<option key={l} value={String(l)}>
									L{l} {LEVEL_NAMES[l]}
								</option>
							))}
						</select>
					</label>
					<button type="button" class="secondary" onClick={() => onChange(value.filter((_, j) => j !== i))}>
						Remove
					</button>
				</div>
			))}
			{free ? (
				<div>
					<button
						type="button"
						class="secondary"
						onClick={() => onChange([...value, { skill: free.skill.key, level: 2 }])}
					>
						Add required skill
					</button>
				</div>
			) : view.skills.length === 0 ? (
				<p class="muted">
					No skills yet: create one on <a href="#/skills">Skills</a>.
				</p>
			) : null}
		</fieldset>
	);
}

function NewTaskForm({ view }: { readonly view: View }) {
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	const [created, setCreated] = useState(false);
	const { busy, error, setError, send } = useSend();
	const submit = async () => {
		const estimateMinutes = parseMinutes(draft.estimate);
		if (estimateMinutes === null) {
			setError("Estimate must be a whole number of minutes, at least 1.");
			return;
		}
		const ok = await send({
			type: "TaskCreated",
			task: {
				goalId: draft.goalId === "" ? null : draft.goalId,
				title: draft.title.trim(),
				notes: draft.notes,
				doneWhen: draft.doneWhen,
				category: draft.category.trim(),
				estimateMinutes,
				importance: draft.importance,
				urgency: draft.urgency,
				requirements: draft.requirements,
			},
		});
		setCreated(ok);
		if (ok) setDraft(EMPTY_DRAFT);
	};
	return (
		<form
			class="stack"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<TaskFields
				view={view}
				idPrefix="new-task"
				draft={draft}
				set={(patch) => {
					setCreated(false);
					setDraft((d) => ({ ...d, ...patch }));
				}}
			/>
			<div class="row">
				<button type="submit" class="primary" disabled={busy}>
					Create task
				</button>
				{error ? <span class="error">{error}</span> : null}
				{created ? <span class="muted">Created.</span> : null}
			</div>
		</form>
	);
}

function sameRequirements(a: readonly Requirement[], b: readonly Requirement[]): boolean {
	return a.length === b.length && a.every((r, i) => r.skill === b[i]?.skill && r.level === b[i]?.level);
}

function EditTaskForm({ view, task }: { readonly view: View; readonly task: Task }) {
	const [draft, setDraft] = useState<Draft>(() => draftOf(task));
	const { busy, error, setError, send } = useSend();
	const submit = async () => {
		const estimateMinutes = parseMinutes(draft.estimate);
		if (estimateMinutes === null) {
			setError("Estimate must be a whole number of minutes, at least 1.");
			return;
		}
		const title = draft.title.trim();
		const category = draft.category.trim();
		const goalId = draft.goalId === "" ? null : draft.goalId;
		const patch: TaskPatch = {
			...(title !== task.title ? { title } : {}),
			...(draft.doneWhen !== task.doneWhen ? { doneWhen: draft.doneWhen } : {}),
			...(draft.notes !== task.notes ? { notes: draft.notes } : {}),
			...(category !== task.category ? { category } : {}),
			...(estimateMinutes !== task.estimateMinutes ? { estimateMinutes } : {}),
			...(draft.importance !== task.importance ? { importance: draft.importance } : {}),
			...(draft.urgency !== task.urgency ? { urgency: draft.urgency } : {}),
			...(goalId !== task.goalId ? { goalId } : {}),
			...(sameRequirements(draft.requirements, task.requirements) ? {} : { requirements: draft.requirements }),
		};
		if (Object.keys(patch).length === 0) {
			setError("Nothing changed.");
			return;
		}
		await send({ type: "TaskEdited", taskId: task.id, patch });
	};
	return (
		<form
			class="stack"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<TaskFields
				view={view}
				idPrefix={`edit-${task.id}`}
				draft={draft}
				set={(patch) => setDraft((d) => ({ ...d, ...patch }))}
			/>
			<div class="row">
				<button type="submit" class="primary" disabled={busy}>
					Save changes
				</button>
				<button type="button" class="secondary" onClick={() => setDraft(draftOf(task))}>
					Revert
				</button>
				{error ? <span class="error">{error}</span> : null}
			</div>
		</form>
	);
}

// ── Task detail ─────────────────────────────────────────────────────────────

export function TaskDetail({ view, id }: { readonly view: View; readonly id: string }) {
	const tv = taskById(view, id);
	if (tv === undefined) {
		return (
			<div class="stack">
				<p>
					<a href="#/tasks">← Tasks</a>
				</p>
				<p class="error">No task with id {id}.</p>
			</div>
		);
	}
	const { task } = tv;
	return (
		<div class="stack">
			<p>
				<a href="#/tasks">← Tasks</a>
			</p>
			<section class="panel stack">
				<div class="row">
					<StatusChip status={task.status} />
					<KindLabel task={task} />
					<span class="muted">{task.id}</span>
				</div>
				<h1 class="title">{task.title}</h1>
				<TaskActions tv={tv} />
			</section>
			{isActive(task.status) ? <ReadinessPanel view={view} tv={tv} /> : null}
			<DetailsPanel view={view} tv={tv} />
			{task.learning ? <LearningPanel view={view} task={task} /> : null}
			{task.requirements.length > 0 ? <RequirementsPanel view={view} task={task} /> : null}
			{task.develops !== undefined && task.develops.length > 0 ? (
				<DevelopsPanel view={view} develops={task.develops} />
			) : null}
			<section class="panel">
				<h2>Priority (MCDA)</h2>
				{tv.score ? (
					<>
						<p class="muted">
							Score = 100 × Σ weight × normalized value. Weights are Rank-Order Centroid weights of your criteria
							ranking ({view.criteriaRank.join(" > ")}), set in <a href="#/settings">Settings</a>.
						</p>
						<ScoreBreakdown view={view} score={tv.score} />
					</>
				) : (
					<p class="muted">Closed tasks are not scored.</p>
				)}
			</section>
			<DependenciesPanel view={view} tv={tv} />
			<HistoryPanel tv={tv} />
			<details class="panel">
				<summary>Edit task</summary>
				<EditTaskForm key={task.updatedAt} view={view} task={task} />
			</details>
		</div>
	);
}

function TaskActions({ tv }: { readonly tv: TaskView }) {
	const { task } = tv;
	const status = task.status;
	const [mode, setMode] = useState<"complete" | "cancel" | null>(null);
	return (
		<div class="stack">
			<div class="row">
				{canTaskTransition(status, "TaskStarted") ? (
					tv.ready ? (
						<ActionButton kind="primary" event={{ type: "TaskStarted", taskId: task.id }}>
							Start
						</ActionButton>
					) : (
						<button type="button" class="primary" disabled title="Blocked: see why below">
							Start
						</button>
					)
				) : null}
				{canTaskTransition(status, "TaskPaused") ? (
					<ActionButton event={{ type: "TaskPaused", taskId: task.id }}>Pause</ActionButton>
				) : null}
				{canTaskTransition(status, "TaskCompleted") ? (
					<button
						type="button"
						class={status === "doing" ? "primary" : "secondary"}
						aria-expanded={mode === "complete"}
						onClick={() => setMode(mode === "complete" ? null : "complete")}
					>
						Complete…
					</button>
				) : null}
				{canTaskTransition(status, "TaskCancelled") ? (
					<button
						type="button"
						class="danger"
						aria-expanded={mode === "cancel"}
						onClick={() => setMode(mode === "cancel" ? null : "cancel")}
					>
						Cancel task…
					</button>
				) : null}
				{canTaskTransition(status, "TaskReopened") ? (
					<ActionButton event={{ type: "TaskReopened", taskId: task.id }}>Reopen</ActionButton>
				) : null}
			</div>
			{mode === "complete" && canTaskTransition(status, "TaskCompleted") ? (
				<CompleteForm task={task} onDone={() => setMode(null)} />
			) : null}
			{mode === "cancel" && canTaskTransition(status, "TaskCancelled") ? (
				<CancelForm task={task} onDone={() => setMode(null)} />
			) : null}
		</div>
	);
}

function CompleteForm({ task, onDone }: { readonly task: Task; readonly onDone: () => void }) {
	const [actual, setActual] = useState("");
	const [outcome, setOutcome] = useState("");
	const [evidence, setEvidence] = useState("");
	const { busy, error, setError, send } = useSend();
	const learning = task.learning !== null;
	const develops = task.develops ?? [];
	// Learning steps and tasks that build a skill turn the outcome into level-proposal evidence.
	const needsOutcome = learning || develops.length > 0;
	const submit = async () => {
		const actualMinutes = actual.trim() === "" ? null : parseMinutes(actual);
		if (actual.trim() !== "" && actualMinutes === null) {
			setError("Actual minutes must be a whole number, at least 1, or empty.");
			return;
		}
		if (needsOutcome && outcome.trim() === "") {
			setError(
				learning
					? "Say what you learned: it becomes the evidence for the level proposal."
					: "Say what you produced or learned: it becomes the evidence for the skill level proposal.",
			);
			return;
		}
		const url = evidence.trim();
		const ok = await send({
			type: "TaskCompleted",
			taskId: task.id,
			actualMinutes,
			outcome: outcome.trim(),
			evidenceUrl: url === "" ? null : url,
		});
		if (ok) onDone();
	};
	return (
		<form
			class="stack inset"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<label>
				Actual minutes <span class="muted">(optional; calibrates "{task.category}" estimates)</span>
				<input
					type="number"
					min={1}
					step={1}
					placeholder={`estimate ${task.estimateMinutes}`}
					value={actual}
					onInput={(e) => setActual(e.currentTarget.value)}
				/>
			</label>
			<label>
				{learning
					? "What did you learn? (required)"
					: needsOutcome
						? "What did you produce or learn? (required)"
						: "Outcome"}
				<textarea rows={3} required={needsOutcome} value={outcome} onInput={(e) => setOutcome(e.currentTarget.value)} />
			</label>
			<label>
				Evidence URL <span class="muted">(optional: commit, PR, notes)</span>
				<input type="url" placeholder="https://" value={evidence} onInput={(e) => setEvidence(e.currentTarget.value)} />
			</label>
			{task.learning ? (
				<p class="muted">
					Completing proposes L{task.learning.targetLevel} {LEVEL_NAMES[task.learning.targetLevel]} for this skill. Your
					level changes only when you confirm it.
				</p>
			) : null}
			{develops.length > 0 ? (
				<p class="muted">
					The outcome is the evidence for the skill proposal: completing proposes{" "}
					{develops.map((d) => `L${d.level} ${LEVEL_NAMES[d.level]} in ${d.skill}`).join(", ")} for any skill below that
					level. Your level changes only when you confirm it after evaluating.
				</p>
			) : null}
			<div class="row">
				<button type="submit" class="primary" disabled={busy}>
					Mark done
				</button>
				{error ? <span class="error">{error}</span> : null}
			</div>
		</form>
	);
}

function CancelForm({ task, onDone }: { readonly task: Task; readonly onDone: () => void }) {
	const [reason, setReason] = useState("");
	const { busy, error, send } = useSend();
	return (
		<form
			class="stack inset"
			onSubmit={(e) => {
				e.preventDefault();
				void send({ type: "TaskCancelled", taskId: task.id, reason: reason.trim() }).then((ok) => {
					if (ok) onDone();
				});
			}}
		>
			<label>
				Why cancel?
				<textarea rows={2} required value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
			</label>
			<div class="row">
				<button type="submit" class="danger" disabled={busy}>
					Cancel task
				</button>
				{error ? <span class="error">{error}</span> : null}
			</div>
		</form>
	);
}

function ReadinessPanel({ view, tv }: { readonly view: View; readonly tv: TaskView }) {
	const { task } = tv;
	if (tv.ready) {
		return (
			<section class="panel ready-panel">
				<h2>Ready</h2>
				<p class="muted">No open blockers, and every required skill level is met.</p>
			</section>
		);
	}
	const learningFor = (skill: string) =>
		view.tasks.filter((t) => t.task.learning?.skill === skill && isActive(t.task.status));
	const uncovered = tv.gaps.filter(
		(g) => !learningFor(g.skill).some((t) => (t.task.learning?.targetLevel ?? 0) >= g.required),
	);
	return (
		<section class="panel blocked-panel stack">
			<h2>Blocked</h2>
			{tv.blockedBy.length > 0 ? (
				<div>
					<p class="muted">Waiting for {plural(tv.blockedBy.length, "open task")}:</p>
					<ul>
						{tv.blockedBy.map((b) => {
							const blocker = taskById(view, b);
							return (
								<li key={b}>
									<TaskLink view={view} id={b} /> {blocker ? <StatusChip status={blocker.task.status} /> : null}
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
			{tv.gaps.length > 0 ? (
				<div>
					<p class="muted">Skill gaps (your confirmed level is below the required level):</p>
					<ul>
						{tv.gaps.map((g) => {
							const steps = learningFor(g.skill);
							return (
								<li key={g.skill}>
									<SkillLink view={view} skillKey={g.skill} />: you <LevelBadge level={g.current} />, needed{" "}
									<LevelBadge level={g.required} /> {LEVEL_NAMES[g.required]}
									{steps.length > 0 ? (
										<>
											{" "}
											· learning:{" "}
											{steps.map((s, i) => (
												<span key={s.task.id}>
													{i > 0 ? ", " : null}
													<TaskLink view={view} id={s.task.id} /> (to L{s.task.learning?.targetLevel})
												</span>
											))}
										</>
									) : null}
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
			{uncovered.length > 0 ? (
				<div class="row">
					<ActionButton kind="primary" event={{ type: "LearningStepsAdded", taskId: task.id }}>
						Add learning steps
					</ActionButton>
					<span class="muted">
						One learning task per level step for {plural(uncovered.length, "uncovered gap")}; they block this task.
					</span>
				</div>
			) : null}
		</section>
	);
}

function DetailsPanel({ view, tv }: { readonly view: View; readonly tv: TaskView }) {
	const { task, estimate } = tv;
	const stats = view.categories[task.category];
	return (
		<section class="panel">
			<h2>Details</h2>
			<dl class="facts">
				<dt>Done when</dt>
				<dd class="pre">{task.doneWhen || <span class="muted">not set</span>}</dd>
				<dt>Notes</dt>
				<dd class="pre">{task.notes || <span class="muted">none</span>}</dd>
				<dt>Goal</dt>
				<dd>{goalTitle(view, task.goalId) ?? <span class="muted">none</span>}</dd>
				<dt>Category</dt>
				<dd>{task.category}</dd>
				<dt>Importance</dt>
				<dd>
					{task.importance} — {IMPORTANCE_ANCHORS[task.importance]}
				</dd>
				<dt>Urgency</dt>
				<dd>
					{task.urgency} — {URGENCY_ANCHORS[task.urgency]}
				</dd>
				<dt>Estimate</dt>
				<dd>
					<div>
						Raw {minutes(task.estimateMinutes)} · adjusted <strong>{minutes(tv.adjustedMinutes)}</strong>
					</div>
					<div class="muted">
						"{estimate.category}": {plural(estimate.samples, "done task")} with tracked time
						{estimate.medianRatio !== null ? (
							<>
								, median actual/estimate ratio {estimate.medianRatio.toFixed(2)}
								{stats !== undefined && stats.mad !== null ? ` (MAD ${stats.mad.toFixed(2)})` : null}
							</>
						) : null}
						.{" "}
						{estimate.applied
							? `Applied: adjusted = ⌈raw × ${estimate.medianRatio?.toFixed(2) ?? "?"}⌉.`
							: `Not applied: calibration needs at least ${MIN_ESTIMATE_SAMPLES} samples, so the raw estimate is used.`}
					</div>
				</dd>
				<dt>Created</dt>
				<dd>{when(task.createdAt)}</dd>
				<dt>Updated</dt>
				<dd>{when(task.updatedAt)}</dd>
			</dl>
		</section>
	);
}

function LearningPanel({ view, task }: { readonly view: View; readonly task: Task }) {
	const spec = task.learning;
	if (spec === null) return null;
	const guide = ACTIVITY_GUIDE[spec.activity];
	return (
		<section class="panel stack">
			<h2>Learning step</h2>
			<p>
				<SkillLink view={view} skillKey={spec.skill} /> → <LevelBadge level={spec.targetLevel} />{" "}
				{LEVEL_NAMES[spec.targetLevel]}
			</p>
			<div>
				<h3>{guide.label}</h3>
				<p>{guide.instruction}</p>
			</div>
			<div>
				<h3>Deliverable</h3>
				<p class="pre">{spec.deliverable}</p>
			</div>
			{spec.retrievalPrompts.length > 0 ? (
				<div>
					<h3>Retrieval prompts</h3>
					<p class="muted">Answer from memory, without notes, when you finish and at each spaced review.</p>
					<ol>
						{spec.retrievalPrompts.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ol>
				</div>
			) : null}
			{spec.resources.length > 0 ? (
				<div>
					<h3>Resources</h3>
					<ul>
						{spec.resources.map((r) => (
							<li key={r.url}>
								<a href={r.url} target="_blank" rel="noreferrer">
									{r.title}
								</a>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}

function RequirementsPanel({ view, task }: { readonly view: View; readonly task: Task }) {
	return (
		<section class="panel">
			<h2>Required skills</h2>
			<table class="list">
				<thead>
					<tr>
						<th>Skill</th>
						<th>Required</th>
						<th>You</th>
						<th>Status</th>
					</tr>
				</thead>
				<tbody>
					{task.requirements.map((r) => {
						const current = view.skills.find((s) => s.skill.key === r.skill)?.skill.level ?? null;
						const met = current !== null && current >= r.level;
						return (
							<tr key={r.skill}>
								<td>
									<SkillLink view={view} skillKey={r.skill} />
								</td>
								<td>
									<LevelBadge level={r.level} /> {LEVEL_NAMES[r.level]}
								</td>
								<td>
									<LevelBadge level={current} /> {current === null ? "not assessed" : LEVEL_NAMES[current]}
								</td>
								<td>{met ? <span class="ready">met</span> : <span class="blocked">gap</span>}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</section>
	);
}

/** Skills the task builds: never a blocker; completing it proposes the level for each skill still below it. */
function DevelopsPanel({ view, develops }: { readonly view: View; readonly develops: readonly Requirement[] }) {
	return (
		<section class="panel">
			<h2>Builds skills</h2>
			<p class="muted">
				Doing this task develops these skills; it never waits on them. Completing it proposes each level you do not have
				yet, with your outcome as evidence, and you confirm after evaluating.
			</p>
			<table class="list">
				<thead>
					<tr>
						<th>Skill</th>
						<th>Builds to</th>
						<th>You</th>
					</tr>
				</thead>
				<tbody>
					{develops.map((d) => {
						const current = view.skills.find((s) => s.skill.key === d.skill)?.skill.level ?? null;
						return (
							<tr key={d.skill}>
								<td>
									<SkillLink view={view} skillKey={d.skill} />
								</td>
								<td>
									<LevelBadge level={d.level} /> {LEVEL_NAMES[d.level]}
								</td>
								<td>
									<LevelBadge level={current} /> {current === null ? "not assessed" : LEVEL_NAMES[current]}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</section>
	);
}

/** Tasks that `id` blocks, transitively: adding any of them as a blocker of `id` would close a cycle. */
function downstreamOf(view: View, id: string): ReadonlySet<string> {
	const seen = new Set<string>();
	const stack = [id];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		for (const d of taskById(view, current)?.dependents ?? []) {
			if (!seen.has(d)) {
				seen.add(d);
				stack.push(d);
			}
		}
	}
	return seen;
}

function DependenciesPanel({ view, tv }: { readonly view: View; readonly tv: TaskView }) {
	const { task } = tv;
	const [choice, setChoice] = useState("");
	const blockers = view.tasks.filter((t) => t.dependents.includes(task.id));
	const dependents = tv.dependents.map((d) => taskById(view, d)).filter((t) => t !== undefined);
	const active = isActive(task.status);
	const blockerIds = new Set(blockers.map((b) => b.task.id));
	const downstream = downstreamOf(view, task.id);
	const candidates = active
		? view.tasks.filter(
				(t) =>
					isActive(t.task.status) && t.task.id !== task.id && !blockerIds.has(t.task.id) && !downstream.has(t.task.id),
			)
		: [];
	const selected = candidates.some((c) => c.task.id === choice) ? choice : "";
	const edgeRow = (other: TaskView, event: EventBody) => (
		<li key={other.task.id}>
			<TaskLink view={view} id={other.task.id} /> <StatusChip status={other.task.status} />{" "}
			{active && isActive(other.task.status) ? (
				<ActionButton event={event}>Remove</ActionButton>
			) : (
				<span class="muted" title="Edges touching a closed task are kept as history">
					(kept)
				</span>
			)}
		</li>
	);
	return (
		<section class="panel stack">
			<h2>Dependencies</h2>
			<div class="grid">
				<div>
					<h3>Blocked by</h3>
					{blockers.length === 0 ? (
						<p class="muted">Nothing.</p>
					) : (
						<ul>
							{blockers.map((b) => edgeRow(b, { type: "DependencyRemoved", taskId: task.id, blockerId: b.task.id }))}
						</ul>
					)}
				</div>
				<div>
					<h3>Blocks</h3>
					{dependents.length === 0 ? (
						<p class="muted">Nothing.</p>
					) : (
						<ul>
							{dependents.map((d) => edgeRow(d, { type: "DependencyRemoved", taskId: d.task.id, blockerId: task.id }))}
						</ul>
					)}
				</div>
			</div>
			{active ? (
				candidates.length > 0 ? (
					<div class="row">
						<label>
							Add blocker
							<select value={selected} onChange={(e) => setChoice(e.currentTarget.value)}>
								<option value="">Choose an open task…</option>
								{candidates.map((c) => (
									<option key={c.task.id} value={c.task.id}>
										{c.task.title}
									</option>
								))}
							</select>
						</label>
						<ActionButton
							event={() => (selected === "" ? null : { type: "DependencyAdded", taskId: task.id, blockerId: selected })}
							onDone={(r) => {
								if (r.ok) setChoice("");
							}}
						>
							Add
						</ActionButton>
					</div>
				) : (
					<p class="muted">No other open task can block this one without creating a cycle.</p>
				)
			) : null}
		</section>
	);
}

function HistoryPanel({ tv }: { readonly tv: TaskView }) {
	if (tv.completions.length === 0) return null;
	return (
		<section class="panel">
			<h2>Completion history</h2>
			<table class="list">
				<thead>
					<tr>
						<th>When</th>
						<th>Status</th>
						<th>Actual / estimate</th>
						<th>Outcome</th>
						<th>Evidence</th>
					</tr>
				</thead>
				<tbody>
					{tv.completions.map((c) => (
						<tr key={c.at}>
							<td>{when(c.at)}</td>
							<td>
								<StatusChip status={c.status} />
							</td>
							<td>
								{c.actualMinutes === null ? "not tracked" : minutes(c.actualMinutes)} / {minutes(c.estimateMinutes)}
								{c.actualMinutes !== null ? (
									<small class="muted"> ×{(c.actualMinutes / c.estimateMinutes).toFixed(2)}</small>
								) : null}
							</td>
							<td class="pre">{c.outcome || <span class="muted">—</span>}</td>
							<td>
								{c.evidenceUrl ? (
									<a href={c.evidenceUrl} target="_blank" rel="noreferrer">
										link
									</a>
								) : (
									<span class="muted">—</span>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

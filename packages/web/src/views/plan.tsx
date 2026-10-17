import {
	ACTIVITY_BY_LEVEL,
	ACTIVITY_GUIDE,
	type DraftSkill,
	type DraftTask,
	type KernelState,
	LEVEL_NAMES,
	type Level,
	type Likert,
	MIN_ESTIMATE_SAMPLES,
	type PlanDraft,
	type Proposal,
	type Resource,
	SKILL_KEY_PATTERN,
	type Skill,
	type SkillKey,
	type TargetLevel,
	type Task,
	type TaskId,
	type View,
	adjustedMinutes,
	planLearning,
	validateDraft,
} from "@dawnskill/core";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type PlanRun, sendEvent, startPlan, useApp } from "../api.ts";
import {
	ActionButton,
	CancelRunButton,
	LEVEL_ANCHORS,
	LevelBadge,
	RunLive,
	RunStatusChip,
	SkillLink,
	TaskLink,
	minutes,
	when,
} from "../ui.tsx";
import "./plan.css";

const DOCS = "https://github.com/TheRockPusher/dawnskill/blob/main/docs/learning-model.md";
const LEVELS: readonly Level[] = [0, 1, 2, 3, 4, 5];
const TARGET_LEVELS: readonly TargetLevel[] = [1, 2, 3, 4, 5];
const LIKERT: readonly Likert[] = [1, 2, 3, 4, 5];
const LIKERT_LABEL: Readonly<Record<Likert, string>> = {
	1: "1 very low",
	2: "2 low",
	3: "3 medium",
	4: "4 high",
	5: "5 very high",
};

type Ratings = Readonly<Record<SkillKey, Level>>;
type PlanProposal = Proposal & { readonly payload: { readonly kind: "plan"; readonly draft: PlanDraft } };

function isPlan(p: Proposal): p is PlanProposal {
	return p.payload.kind === "plan";
}

const byNewest = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

/** Next kernel id suffix as far as the view shows: ids are `G<n>`, `T<n>`, `P<n>` from one counter. */
function nextIdOf(view: View): number {
	let max = 0;
	const bump = (id: string): void => {
		const n = Number(id.slice(1));
		if (Number.isInteger(n) && n > max) max = n;
	};
	for (const t of view.tasks) bump(t.task.id);
	for (const g of view.goals) bump(g.goal.id);
	for (const p of view.proposals) bump(p.id);
	return max + 1;
}

/** Minimal kernel state for `validateDraft`: the skills a draft may reference; other collections empty. */
function draftState(view: View): KernelState {
	return {
		seq: view.seq,
		nextId: nextIdOf(view),
		goals: {},
		tasks: {},
		blockers: {},
		completions: [],
		skills: Object.fromEntries(view.skills.map((s) => [s.skill.key, s.skill])),
		assessments: [],
		proposals: {},
		reviews: [],
		preferences: { criteriaRank: view.criteriaRank },
	};
}

/** Orders `T2` before `T10`, like the kernel. */
function compareIds(a: string, b: string): number {
	return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

const isOpen = (t: Task): boolean => t.status === "open" || t.status === "doing";

interface PreviewStep {
	readonly level: TargetLevel;
	/** Existing learning task the kernel reuses for this step; null = approval creates it. */
	readonly existing: Task | null;
	readonly minutes: number;
	/** Draft tasks that wait directly on this step. */
	readonly unblocks: readonly DraftTask[];
	/** Steps of prerequisite skills this step waits on. */
	readonly waitsFor: readonly Task[];
}

interface PreviewSkill {
	readonly key: SkillKey;
	readonly name: string;
	readonly known: boolean;
	readonly inDraft: boolean;
	readonly current: Level | null;
	readonly rated: boolean;
	readonly required: TargetLevel;
	readonly requiredBy: ReadonlyArray<{ readonly task: DraftTask; readonly level: TargetLevel }>;
	readonly steps: readonly PreviewStep[];
}

/**
 * Learning that approval would insert: replays the kernel's approval on a state rebuilt from the view
 * (skills with ratings applied, existing tasks and edges, draft tasks with their `after` edges) and runs
 * the kernel's own `planLearning` on it.
 */
function previewLearning(view: View, draft: PlanDraft, ratings: Ratings): readonly PreviewSkill[] {
	const base = draftState(view);
	const skills: Record<SkillKey, Skill> = { ...base.skills };
	for (const s of draft.skills) {
		if (!Object.hasOwn(skills, s.key)) skills[s.key] = { ...s, level: null, createdAt: view.now };
	}
	for (const [key, level] of Object.entries(ratings)) {
		const s = skills[key];
		if (s !== undefined) skills[key] = { ...s, level };
	}

	const tasks: Record<TaskId, Task> = {};
	const blockers: Record<TaskId, TaskId[]> = {};
	for (const tv of view.tasks) {
		tasks[tv.task.id] = tv.task;
		for (const dependent of tv.dependents) (blockers[dependent] ??= []).push(tv.task.id);
	}
	const goalId = `G${base.nextId}`;
	let n = base.nextId + 1;
	const idByRef = new Map<string, TaskId>();
	const draftById = new Map<TaskId, DraftTask>();
	for (const t of draft.tasks) {
		const id = `T${n++}`;
		idByRef.set(t.ref, id);
		draftById.set(id, t);
		tasks[id] = {
			id,
			goalId,
			title: t.title,
			notes: t.notes,
			doneWhen: t.doneWhen,
			category: t.category,
			estimateMinutes: t.estimateMinutes,
			importance: t.importance,
			urgency: t.urgency,
			status: "open",
			requirements: t.requires,
			learning: null,
			createdAt: view.now,
			updatedAt: view.now,
		};
	}
	for (const [id, t] of draftById) {
		for (const ref of t.after) {
			const blocker = idByRef.get(ref);
			if (blocker !== undefined) (blockers[id] ??= []).push(blocker);
		}
	}
	const planned = planLearning({ ...base, nextId: n, skills, tasks, blockers }, [...draftById.keys()], view.now);

	const stepById = new Map<TaskId, Task>();
	const created = new Map<string, Task>();
	for (const t of planned.tasks) {
		stepById.set(t.id, t);
		if (t.learning !== null) created.set(`${t.learning.skill}@${t.learning.targetLevel}`, t);
	}
	// Same reuse rule as the kernel: non-cancelled step, open preferred, then lowest id.
	const existing = new Map<string, Task>();
	for (const t of view.tasks.map((v) => v.task).sort((a, b) => compareIds(a.id, b.id))) {
		if (t.learning === null) continue;
		stepById.set(t.id, t);
		if (t.status === "cancelled") continue;
		const key = `${t.learning.skill}@${t.learning.targetLevel}`;
		const current = existing.get(key);
		if (current === undefined || (!isOpen(current) && isOpen(t))) existing.set(key, t);
	}
	const unblocks = new Map<TaskId, DraftTask[]>();
	const waits = new Map<TaskId, Task[]>();
	for (const [taskId, blockerId] of planned.edges) {
		const consumer = draftById.get(taskId);
		if (consumer !== undefined) {
			const list = unblocks.get(blockerId);
			if (list === undefined) unblocks.set(blockerId, [consumer]);
			else list.push(consumer);
		}
		const step = stepById.get(taskId);
		const blocker = stepById.get(blockerId);
		if (step?.learning && blocker?.learning && step.learning.skill !== blocker.learning.skill) {
			const list = waits.get(taskId);
			if (list === undefined) waits.set(taskId, [blocker]);
			else list.push(blocker);
		}
	}

	const demand = new Map<SkillKey, Array<{ task: DraftTask; level: TargetLevel }>>();
	for (const t of draft.tasks) {
		for (const r of t.requires) {
			const list = demand.get(r.skill);
			if (list === undefined) demand.set(r.skill, [{ task: t, level: r.level }]);
			else list.push({ task: t, level: r.level });
		}
	}
	const draftKeys = new Set(draft.skills.map((s) => s.key));
	return [...demand.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([key, requiredBy]) => {
			const skill = Object.hasOwn(skills, key) ? skills[key] : undefined;
			const required = Math.max(...requiredBy.map((r) => r.level)) as TargetLevel;
			const current = skill?.level ?? null;
			const steps: PreviewStep[] = [];
			if (skill !== undefined) {
				for (let k = (current ?? 0) + 1; k <= required; k++) {
					const level = k as TargetLevel;
					const fresh = created.get(`${key}@${level}`);
					const reused = fresh === undefined ? (existing.get(`${key}@${level}`) ?? null) : null;
					const id = fresh?.id ?? reused?.id ?? "";
					steps.push({
						level,
						existing: reused,
						minutes: fresh?.estimateMinutes ?? reused?.estimateMinutes ?? skill.practiceMinutes,
						unblocks: unblocks.get(id) ?? [],
						waitsFor: waits.get(id) ?? [],
					});
				}
			}
			return {
				key,
				name: skill?.name ?? key,
				known: skill !== undefined,
				inDraft: draftKeys.has(key),
				current,
				rated: Object.hasOwn(ratings, key),
				required,
				requiredBy,
				steps,
			};
		});
}

/** Trims text and drops blank list lines kept while editing. */
function cleanDraft(d: PlanDraft): PlanDraft {
	const lines = (xs: readonly string[]): string[] => xs.map((s) => s.trim()).filter((s) => s.length > 0);
	return {
		goal: d.goal.trim(),
		summary: d.summary.trim(),
		skills: d.skills.map((s) => ({
			key: s.key.trim(),
			name: s.name.trim(),
			description: s.description.trim(),
			concepts: lines(s.concepts),
			prerequisites: s.prerequisites,
			resources: s.resources
				.map((r) => ({ title: r.title.trim(), url: r.url.trim() }))
				.filter((r) => r.title.length > 0 || r.url.length > 0),
			retrievalPrompts: lines(s.retrievalPrompts),
			practiceMinutes: s.practiceMinutes,
		})),
		tasks: d.tasks.map((t) => ({
			ref: t.ref,
			title: t.title.trim(),
			notes: t.notes.trim(),
			doneWhen: t.doneWhen.trim(),
			category: t.category.trim(),
			estimateMinutes: t.estimateMinutes,
			importance: t.importance,
			urgency: t.urgency,
			requires: t.requires,
			after: t.after,
		})),
	};
}

function newTask(ref: string): DraftTask {
	return {
		ref,
		title: "",
		notes: "",
		doneWhen: "",
		category: "",
		estimateMinutes: 60,
		importance: 3,
		urgency: 3,
		requires: [],
		after: [],
	};
}

export function Plan({ view, proposalId }: { readonly view: View; readonly proposalId: string | null }) {
	return proposalId === null ? (
		<PlanIndex view={view} />
	) : (
		<ProposalPage key={proposalId} view={view} proposalId={proposalId} />
	);
}

// ── Index ────────────────────────────────────────────────────────────────

function StatusChip({ status }: { readonly status: Proposal["status"] }) {
	const cls =
		status === "pending"
			? "state-proposed"
			: status === "accepted"
				? "state-assessed"
				: status === "rejected"
					? "state-gap"
					: "state-unassessed";
	return <span class={`chip ${cls}`}>{status}</span>;
}

function DraftCounts({ draft }: { readonly draft: PlanDraft }) {
	const total = draft.tasks.reduce((sum, t) => sum + t.estimateMinutes, 0);
	return (
		<span class="muted">
			{draft.tasks.length} task{draft.tasks.length === 1 ? "" : "s"} · {draft.skills.length} new skill
			{draft.skills.length === 1 ? "" : "s"} · {minutes(total)} estimated work
		</span>
	);
}

function PlanIndex({ view }: { readonly view: View }) {
	const { runs } = useApp();
	const [manual, setManual] = useState(false);
	if (manual) {
		return (
			<DraftEditor
				view={view}
				initial={{ goal: "", summary: "", skills: [], tasks: [newTask("t1")] }}
				supersedes={null}
				onCancel={() => setManual(false)}
			/>
		);
	}
	const plans = view.proposals.filter(isPlan);
	const pending = plans.filter((p) => p.status === "pending");
	const decided = plans
		.filter((p) => p.status !== "pending")
		.sort((a, b) => byNewest(a.decidedAt ?? a.createdAt, b.decidedAt ?? b.createdAt))
		.slice(0, 10);
	return (
		<div class="stack plan">
			<section class="panel stack">
				<h2>New goal</h2>
				<p class="muted">
					Describe what you want to achieve. The planner drafts tasks and the skills they need; nothing changes until
					you review and approve the draft.
				</p>
				<PlannerForm supersedes={null} goal={null} />
				<p class="muted">
					No model, or you prefer to plan yourself?{" "}
					<button type="button" class="secondary" onClick={() => setManual(true)}>
						Write a draft manually
					</button>
				</p>
			</section>

			<PlanRuns view={view} runs={runs} />

			<section class="panel stack">
				<h2>Drafts awaiting review ({pending.length})</h2>
				{pending.length === 0 ? (
					<p class="muted">No pending drafts.</p>
				) : (
					<ul class="plan-list">
						{pending.map((p) => (
							<li key={p.id}>
								<a href={`#/plan/${encodeURIComponent(p.id)}`}>
									<strong>{p.payload.draft.goal}</strong>
								</a>
								<div class="row">
									<DraftCounts draft={p.payload.draft} />
									<span class="muted">
										{p.id} · by {p.actor} · {when(p.createdAt)}
										{p.supersedes ? ` · replaces ${p.supersedes}` : ""}
									</span>
								</div>
							</li>
						))}
					</ul>
				)}
			</section>

			<section class="panel stack">
				<h2>Recently decided</h2>
				{decided.length === 0 ? (
					<p class="muted">Nothing decided yet.</p>
				) : (
					<ul class="plan-list">
						{decided.map((p) => (
							<li key={p.id}>
								<div class="row">
									<StatusChip status={p.status} />
									<a href={`#/plan/${encodeURIComponent(p.id)}`}>{p.payload.draft.goal}</a>
									<span class="muted">
										{p.id}
										{p.decidedAt ? ` · ${when(p.decidedAt)}` : ""}
									</span>
								</div>
								{p.note ? <p class="muted">{p.note}</p> : null}
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}

function RunStatus({ view, run }: { readonly view: View; readonly run: PlanRun }) {
	const proposal = run.proposalId ? view.proposals.find((p) => p.id === run.proposalId) : undefined;
	return (
		<div class="stack plan-run">
			<div class="row">
				<RunStatusChip view={view} run={run} />
				<strong>{run.goal}</strong>
				<span class="muted">
					{run.startedAt === null ? `queued ${when(run.queuedAt)}` : `started ${when(run.startedAt)}`}
					{run.finishedAt ? ` · finished ${when(run.finishedAt)}` : ""}
					{run.startedAt === null ? "" : ` · ${run.attempts} attempt${run.attempts === 1 ? "" : "s"}`}
				</span>
				{run.proposalId ? (
					<a href={`#/plan/${encodeURIComponent(run.proposalId)}`}>
						{proposal?.status === "pending" ? "Review draft" : `Draft ${run.proposalId}`}
					</a>
				) : null}
				<CancelRunButton run={run} />
			</div>
			<RunLive run={run} />
			{run.error ? <p class="error">{run.error}</p> : null}
			{run.errors.length > 0 ? (
				<details>
					<summary>
						{run.errors.length} validation error{run.errors.length === 1 ? "" : "s"} the planner had to repair
					</summary>
					<ul class="plan-errors">
						{run.errors.map((e, i) => (
							<li key={i}>{e}</li>
						))}
					</ul>
				</details>
			) : null}
		</div>
	);
}

function PlanRuns({ view, runs }: { readonly view: View; readonly runs: readonly PlanRun[] }) {
	if (runs.length === 0) return null;
	const recent = [...runs]
		.sort((a, b) => byNewest(a.queuedAt, b.queuedAt))
		.filter((r, i) => r.status === "queued" || r.status === "running" || i < 5);
	return (
		<section class="panel stack">
			<h2>Planner runs</h2>
			{recent.map((r) => (
				<RunStatus key={r.id} view={view} run={r} />
			))}
		</section>
	);
}

/** Starts a planner run: a new goal (`goal` null) or a re-plan of a pending draft. */
function PlannerForm({ goal, supersedes }: { readonly goal: string | null; readonly supersedes: string | null }) {
	const { runs, config, view } = useApp();
	const [goalText, setGoalText] = useState("");
	const [context, setContext] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [runId, setRunId] = useState<string | null>(null);
	const configured = config === null || config.llm.configured;
	const run = runs.find((r) => r.id === runId);
	const target = goal ?? goalText.trim();

	const submit = async (): Promise<void> => {
		if (target.length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const result = await startPlan(target, context.trim(), supersedes);
			if (result.ok) {
				setRunId(result.runId);
				setGoalText("");
				setContext("");
			} else setError(result.message);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form
			class="stack"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			{configured ? null : (
				<p class="error">
					No model is configured, so the planner cannot run. Write a draft manually instead, or configure a model (see{" "}
					<a href="#/settings">Settings</a>).
				</p>
			)}
			{goal === null ? (
				<label>
					Goal
					<input
						value={goalText}
						maxLength={200}
						required
						placeholder="e.g. Ship a --glob option for my ripgrep fork"
						onInput={(e) => setGoalText(e.currentTarget.value)}
					/>
				</label>
			) : null}
			<label>
				{goal === null ? "Context (optional): what you already know, constraints, deadline" : "What should change?"}
				<textarea rows={3} value={context} onInput={(e) => setContext(e.currentTarget.value)} />
			</label>
			<div class="row">
				<button type="submit" class="primary" disabled={busy || !configured || target.length === 0}>
					{busy ? "Starting…" : goal === null ? "Ask the planner" : "Ask the planner for a new draft"}
				</button>
				{config?.llm.model ? <span class="muted">model: {config.llm.model}</span> : null}
			</div>
			{error ? <p class="error">{error}</p> : null}
			{run && view ? <RunStatus view={view} run={run} /> : null}
		</form>
	);
}

// ── Proposal page ────────────────────────────────────────────────────────

function ProposalPage({ view, proposalId }: { readonly view: View; readonly proposalId: string }) {
	const [editing, setEditing] = useState(false);
	const proposal = view.proposals.find((p) => p.id === proposalId);
	const back = (
		<p>
			<a href="#/plan">← All drafts</a>
		</p>
	);
	if (proposal === undefined) {
		return (
			<div class="stack">
				{back}
				<p class="error">Proposal {proposalId} not found.</p>
			</div>
		);
	}
	if (!isPlan(proposal)) {
		return (
			<div class="stack">
				{back}
				<p>
					{proposal.id} is a level proposal, not a plan. Confirm it on <a href="#/">Focus</a> or the skill's page.
				</p>
			</div>
		);
	}
	const { draft } = proposal.payload;
	if (editing) {
		return <DraftEditor view={view} initial={draft} supersedes={proposal.id} onCancel={() => setEditing(false)} />;
	}
	return (
		<div class="stack plan">
			{back}
			<DraftHeader view={view} proposal={proposal} />
			<TasksTable view={view} draft={draft} />
			<SkillsSection view={view} draft={draft} />
			{proposal.status === "pending" ? (
				<PendingReview view={view} proposal={proposal} onEdit={() => setEditing(true)} />
			) : null}
		</div>
	);
}

function DraftHeader({ view, proposal }: { readonly view: View; readonly proposal: PlanProposal }) {
	const { draft } = proposal.payload;
	const replacedBy = view.proposals.find((p) => p.supersedes === proposal.id);
	const goal = view.goals.find((g) => g.goal.proposalId === proposal.id);
	return (
		<section class="panel stack">
			<div class="row">
				<StatusChip status={proposal.status} />
				<span class="muted">
					{proposal.id} · proposed by {proposal.actor} · {when(proposal.createdAt)}
					{proposal.decidedAt ? ` · decided ${when(proposal.decidedAt)}` : ""}
				</span>
			</div>
			<h1 class="plan-goal">{draft.goal}</h1>
			{draft.summary ? <p class="plan-summary">{draft.summary}</p> : <p class="muted">No summary.</p>}
			<DraftCounts draft={draft} />
			{proposal.supersedes ? (
				<p class="muted">
					Replaces draft <a href={`#/plan/${encodeURIComponent(proposal.supersedes)}`}>{proposal.supersedes}</a>.
				</p>
			) : null}
			{proposal.note ? (
				<p>
					<strong>{proposal.status === "rejected" ? "Rejection reason" : "Note"}:</strong> {proposal.note}
				</p>
			) : null}
			{replacedBy ? (
				<p>
					Replaced by <a href={`#/plan/${encodeURIComponent(replacedBy.id)}`}>{replacedBy.id}</a> ({replacedBy.status}).
				</p>
			) : null}
			{goal ? (
				<div class="stack">
					<p>
						Approved as goal <strong>{goal.goal.title}</strong>: {goal.done} of {goal.total} tasks done
						{goal.cancelled > 0 ? `, ${goal.cancelled} cancelled` : ""}.
					</p>
					<ul class="plan-inline">
						{goal.taskIds.map((id) => (
							<li key={id}>
								<TaskLink view={view} id={id} />
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}

function Estimate({ view, category, raw }: { readonly view: View; readonly category: string; readonly raw: number }) {
	const stats = view.categories[category];
	if (stats === undefined || !stats.applied || stats.medianRatio === null) {
		return (
			<>
				{minutes(raw)}
				<div class="muted plan-small">
					raw; {stats?.samples ?? 0}/{MIN_ESTIMATE_SAMPLES} tracked “{category}” tasks for calibration
				</div>
			</>
		);
	}
	return (
		<>
			{minutes(adjustedMinutes(stats, raw))}
			<div class="muted plan-small">
				{minutes(raw)} raw × {stats.medianRatio.toFixed(2)} (median of {stats.samples} tracked “{category}” tasks)
			</div>
		</>
	);
}

function TasksTable({ view, draft }: { readonly view: View; readonly draft: PlanDraft }) {
	const names = new Map<SkillKey, string>();
	for (const s of view.skills) names.set(s.skill.key, s.skill.name);
	for (const s of draft.skills) if (!names.has(s.key)) names.set(s.key, s.name);
	const titles = new Map(draft.tasks.map((t) => [t.ref, t.title]));
	return (
		<section class="panel stack">
			<h2>Tasks</h2>
			<div class="plan-table-wrap">
				<table class="list">
					<thead>
						<tr>
							<th>Task</th>
							<th>Category</th>
							<th>Estimate</th>
							<th title="Importance 1–5">Imp.</th>
							<th title="Urgency 1–5">Urg.</th>
							<th>Requires</th>
							<th>After</th>
						</tr>
					</thead>
					<tbody>
						{draft.tasks.map((t) => (
							<tr key={t.ref}>
								<td>
									<strong>{t.title}</strong> <code class="muted">{t.ref}</code>
									<div class="plan-small">
										<span class="muted">Done when:</span> {t.doneWhen || "—"}
									</div>
									{t.notes ? <div class="muted plan-small">{t.notes}</div> : null}
								</td>
								<td>{t.category}</td>
								<td>
									<Estimate view={view} category={t.category} raw={t.estimateMinutes} />
								</td>
								<td>{t.importance}</td>
								<td>{t.urgency}</td>
								<td>
									{t.requires.length === 0 ? (
										<span class="muted">—</span>
									) : (
										<div class="plan-badges">
											{t.requires.map((r) => (
												<span key={r.skill} class="chip" title={`${LEVEL_NAMES[r.level]} required`}>
													{names.get(r.skill) ?? r.skill} <LevelBadge level={r.level} />
												</span>
											))}
										</div>
									)}
								</td>
								<td>
									{t.after.length === 0 ? (
										<span class="muted">—</span>
									) : (
										t.after.map((ref) => (
											<div key={ref} class="plan-small">
												<code>{ref}</code> {titles.get(ref) ?? "(unknown)"}
											</div>
										))
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function TextList({
	title,
	items,
	ordered,
}: {
	readonly title: string;
	readonly items: readonly string[];
	readonly ordered?: boolean;
}) {
	if (items.length === 0) return null;
	const list = items.map((x, i) => <li key={i}>{x}</li>);
	return (
		<div>
			<h4>{title}</h4>
			{ordered ? <ol>{list}</ol> : <ul>{list}</ul>}
		</div>
	);
}

function SkillsSection({ view, draft }: { readonly view: View; readonly draft: PlanDraft }) {
	if (draft.skills.length === 0) {
		return (
			<section class="panel">
				<h2>Skills</h2>
				<p class="muted">This draft defines no new skills.</p>
			</section>
		);
	}
	const learning = view.categories.learning;
	return (
		<section class="panel stack">
			<h2>Skills</h2>
			{draft.skills.map((s) => {
				const saved = view.skills.find((v) => v.skill.key === s.key);
				return (
					<article key={s.key} class="plan-skill stack">
						<div class="row">
							<h3>{s.name}</h3>
							<code class="muted">{s.key}</code>
							{saved ? (
								<span class="muted">
									already in <SkillLink view={view} skillKey={s.key} /> <LevelBadge level={saved.skill.level} /> —
									approval keeps the saved definition
								</span>
							) : null}
						</div>
						{s.description ? <p>{s.description}</p> : null}
						<TextList title="What you need to know" items={s.concepts} />
						{s.prerequisites.length > 0 ? (
							<div>
								<h4>Learn first</h4>
								<div class="plan-badges">
									{s.prerequisites.map((p) => (
										<span key={p} class="chip">
											{view.skills.some((v) => v.skill.key === p) ? (
												<SkillLink view={view} skillKey={p} />
											) : (
												(draft.skills.find((d) => d.key === p)?.name ?? p)
											)}
										</span>
									))}
								</div>
							</div>
						) : null}
						<TextList title="Retrieval prompts (answered from memory at review)" items={s.retrievalPrompts} ordered />
						{s.resources.length > 0 ? (
							<div>
								<h4>Resources</h4>
								<ul>
									{s.resources.map((r) => (
										<li key={r.url}>
											<a href={r.url} target="_blank" rel="noreferrer">
												{r.title}
											</a>
										</li>
									))}
								</ul>
							</div>
						) : null}
						<p class="plan-small">
							<strong>Practice per level step:</strong> {minutes(s.practiceMinutes)} (planner estimate)
							{learning?.applied ? (
								<>
									{" "}
									→ {minutes(adjustedMinutes(learning, s.practiceMinutes))} calibrated by your last {learning.samples}{" "}
									learning tasks
								</>
							) : null}
						</p>
					</article>
				);
			})}
		</section>
	);
}

// ── Pending review: ratings, preview, actions ────────────────────────────

function LevelRadios({
	name,
	label,
	value,
	onChange,
}: {
	readonly name: string;
	readonly label: string;
	readonly value: Level | null;
	readonly onChange: (level: Level) => void;
}) {
	return (
		<div class="plan-levels" role="radiogroup" aria-label={label}>
			{LEVELS.map((l) => (
				<label key={l} class={value === l ? "plan-level selected" : "plan-level"}>
					<input type="radio" name={name} checked={value === l} onChange={() => onChange(l)} />
					<span class={`level level-${l}`}>L{l}</span>
					<span>
						<strong>{LEVEL_NAMES[l]}</strong>
						<span class="muted"> — {LEVEL_ANCHORS[l]}</span>
					</span>
				</label>
			))}
		</div>
	);
}

function SkillRating({
	view,
	proposalId,
	skill,
	value,
	onChange,
}: {
	readonly view: View;
	readonly proposalId: string;
	readonly skill: DraftSkill;
	readonly value: Level | null;
	readonly onChange: (level: Level | null) => void;
}) {
	const current = view.skills.find((v) => v.skill.key === skill.key)?.skill.level ?? null;
	const required = current === null;
	const [open, setOpen] = useState(false);
	return (
		<fieldset class="plan-rate">
			<legend>
				{skill.name} <code class="muted">{skill.key}</code>{" "}
				{required ? (
					<span class={`chip ${value === null ? "state-gap" : "state-assessed"}`}>
						{value === null ? "rating required" : "rated"}
					</span>
				) : (
					<span class="muted">
						current <LevelBadge level={current} /> {current === null ? "" : LEVEL_NAMES[current]}
					</span>
				)}
			</legend>
			{required || open ? (
				<>
					<LevelRadios
						name={`rate-${proposalId}-${skill.key}`}
						label={`Your level in ${skill.name}`}
						value={value}
						onChange={onChange}
					/>
					{required ? null : (
						<button
							type="button"
							class="secondary"
							onClick={() => {
								onChange(null);
								setOpen(false);
							}}
						>
							Keep current level
						</button>
					)}
				</>
			) : (
				<button type="button" class="secondary" onClick={() => setOpen(true)}>
					Re-rate
				</button>
			)}
		</fieldset>
	);
}

function LearningPreview({ view, preview }: { readonly view: View; readonly preview: readonly PreviewSkill[] }) {
	const stats = view.categories.learning;
	const fresh = preview.flatMap((s) => s.steps.filter((step) => step.existing === null));
	const total = fresh.reduce((sum, s) => sum + s.minutes, 0);
	return (
		<section class="panel stack">
			<h2>Learning this approval adds</h2>
			<p class="muted plan-small">
				Preview computed in your browser with the kernel's own rules (<code>planLearning</code>): one learning task per
				level step from your current level up to the highest level any task requires; each step blocks the next, and a
				task waits on the step that reaches its level. Existing steps are reused. Approval recomputes this against your
				data at that moment. <a href={DOCS}>Learning model</a>
			</p>
			{preview.length === 0 ? <p class="muted">No task in this draft requires a skill.</p> : null}
			{preview.map((s) => (
				<div key={s.key} class="plan-preview-skill stack">
					<div class="row">
						<strong>{s.name}</strong>
						<span class="muted">
							current{" "}
							{s.current === null ? (
								<>
									<LevelBadge level={null} />{" "}
									{s.inDraft ? "rate it above; planned from L1 until then" : "not assessed; planned from L1"}
								</>
							) : (
								<>
									<LevelBadge level={s.current} />
									{s.rated ? " (your rating)" : ""}
								</>
							)}{" "}
							→ required <LevelBadge level={s.required} /> by{" "}
							{s.requiredBy.map((r) => `“${r.task.title}” (L${r.level})`).join(", ")}
						</span>
					</div>
					{!s.known ? (
						<p class="error">Unknown skill key — the draft is invalid until it is defined.</p>
					) : s.steps.length === 0 ? (
						<p class="muted">No gap: your level already meets every requirement.</p>
					) : (
						<ol class="plan-steps">
							{s.steps.map((step) => (
								<li key={step.level}>
									<span class={`level level-${step.level}`}>L{step.level}</span> {LEVEL_NAMES[step.level]} —{" "}
									{ACTIVITY_GUIDE[ACTIVITY_BY_LEVEL[step.level]].label} · {minutes(step.minutes)}
									{step.existing === null ? (
										<span class="chip">new</span>
									) : (
										<span class="muted">
											{" "}
											· reuses <TaskLink view={view} id={step.existing.id} /> ({step.existing.status})
										</span>
									)}
									{step.unblocks.length > 0 ? (
										<div class="plan-small">unblocks {step.unblocks.map((t) => `“${t.title}”`).join(", ")}</div>
									) : null}
									{step.waitsFor.length > 0 ? (
										<div class="plan-small muted">
											waits for{" "}
											{step.waitsFor
												.map((t) => (t.learning ? `${t.learning.skill} L${t.learning.targetLevel}` : t.id))
												.join(", ")}
										</div>
									) : null}
								</li>
							))}
						</ol>
					)}
				</div>
			))}
			{preview.length > 0 ? (
				<p>
					<strong>
						Total new learning: {fresh.length} step{fresh.length === 1 ? "" : "s"}, {minutes(total)}
					</strong>{" "}
					<span class="muted">(sum of each skill's practice minutes per step)</span>
					{stats?.applied && total > 0 ? (
						<span class="muted">
							{" "}
							· calibrated ≈ {minutes(fresh.reduce((sum, s) => sum + adjustedMinutes(stats, s.minutes), 0))} from{" "}
							{stats.samples} tracked learning tasks
						</span>
					) : null}
				</p>
			) : null}
		</section>
	);
}

function PendingReview({
	view,
	proposal,
	onEdit,
}: {
	readonly view: View;
	readonly proposal: PlanProposal;
	readonly onEdit: () => void;
}) {
	const { draft } = proposal.payload;
	const [ratings, setRatings] = useState<Ratings>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reason, setReason] = useState("");
	const preview = useMemo(() => previewLearning(view, draft, ratings), [view, draft, ratings]);
	const errors = useMemo(() => validateDraft(draftState(view), draft), [view, draft]);
	const missing = draft.skills.filter((s) => {
		const level = view.skills.find((v) => v.skill.key === s.key)?.skill.level ?? null;
		return level === null && !Object.hasOwn(ratings, s.key);
	});
	const setRating = (key: SkillKey, level: Level | null): void => {
		setRatings((current) =>
			level === null
				? Object.fromEntries(Object.entries(current).filter(([k]) => k !== key))
				: { ...current, [key]: level },
		);
	};
	const approve = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		const result = await sendEvent({ type: "PlanApproved", proposalId: proposal.id, ratings });
		setBusy(false);
		if (result.ok) location.hash = "#/";
		else setError(result.message);
	};

	return (
		<>
			{draft.skills.length > 0 ? (
				<section class="panel stack">
					<h2>Rate yourself</h2>
					<p class="muted plan-small">
						Pick the description that matches what you can do today, not what you know about. New skills must be rated
						before approval; levels decide which learning steps are created. <a href={DOCS}>Why these levels</a>
					</p>
					{draft.skills.map((s) => (
						<SkillRating
							key={s.key}
							view={view}
							proposalId={proposal.id}
							skill={s}
							value={ratings[s.key] ?? null}
							onChange={(level) => setRating(s.key, level)}
						/>
					))}
				</section>
			) : null}

			<LearningPreview view={view} preview={preview} />

			<section class="panel stack">
				<h2>Decide</h2>
				{errors.length > 0 ? (
					<div class="stack">
						<p class="error">The kernel will refuse this draft as it stands; edit it or re-plan:</p>
						<ul class="plan-errors">
							{errors.map((e) => (
								<li key={e}>{e}</li>
							))}
						</ul>
					</div>
				) : null}
				<div class="row">
					<button type="button" class="primary" disabled={busy || missing.length > 0} onClick={() => void approve()}>
						{busy ? "Approving…" : "Approve plan"}
					</button>
					<button type="button" class="secondary" onClick={onEdit}>
						Edit
					</button>
					{missing.length > 0 ? <span class="muted">Rate {missing.map((s) => s.name).join(", ")} first.</span> : null}
				</div>
				{error ? <p class="error">{error}</p> : null}
				<div class="row plan-reject">
					<label>
						Reason (optional)
						<input value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
					</label>
					<ActionButton
						kind="danger"
						confirm="Reject this draft?"
						event={() => ({ type: "ProposalRejected", proposalId: proposal.id, reason: reason.trim() })}
					>
						Reject
					</ActionButton>
				</div>
				<details>
					<summary>Re-plan with the model</summary>
					<PlannerForm goal={draft.goal} supersedes={proposal.id} />
				</details>
			</section>
		</>
	);
}

// ── Editor ───────────────────────────────────────────────────────────────

function Field({
	label,
	children,
	wide,
}: {
	readonly label: string;
	readonly children: ComponentChildren;
	readonly wide?: boolean;
}) {
	return (
		<label class={wide ? "plan-field wide" : "plan-field"}>
			{label}
			{children}
		</label>
	);
}

function Errors({ errors, prefix }: { readonly errors: readonly string[]; readonly prefix: string }) {
	const mine = errors.filter((e) => e.startsWith(prefix));
	if (mine.length === 0) return null;
	return (
		<ul class="plan-errors">
			{mine.map((e) => (
				<li key={e}>{e.startsWith(`${prefix}.`) ? e.slice(prefix.length + 1) : e}</li>
			))}
		</ul>
	);
}

const toNumber = (v: string): number => (v.trim() === "" ? Number.NaN : Number(v));
const numberValue = (n: number): string => (Number.isNaN(n) ? "" : String(n));

function DraftEditor({
	view,
	initial,
	supersedes,
	onCancel,
}: {
	readonly view: View;
	readonly initial: PlanDraft;
	readonly supersedes: string | null;
	readonly onCancel: () => void;
}) {
	const [draft, setDraft] = useState<PlanDraft>(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [awaiting, setAwaiting] = useState<ReadonlySet<string> | null>(null);
	const base = useMemo(() => draftState(view), [view]);
	const clean = useMemo(() => cleanDraft(draft), [draft]);
	const errors = useMemo(() => validateDraft(base, clean), [base, clean]);

	useEffect(() => {
		if (awaiting === null) return;
		const created = view.proposals
			.filter((p) => isPlan(p) && p.status === "pending" && p.supersedes === supersedes && !awaiting.has(p.id))
			.sort((a, b) => byNewest(a.createdAt, b.createdAt))[0];
		if (created !== undefined) location.hash = `#/plan/${encodeURIComponent(created.id)}`;
	}, [view, awaiting, supersedes]);

	const savedKeys = new Set(view.skills.map((s) => s.skill.key));
	const knownKeys = [...new Set([...draft.skills.map((s) => s.key.trim()), ...savedKeys])]
		.filter((k) => k.length > 0)
		.sort();
	const skillName = (key: SkillKey): string =>
		draft.skills.find((s) => s.key === key)?.name || view.skills.find((s) => s.skill.key === key)?.skill.name || key;
	const categories = [
		...new Set([
			"learning",
			...Object.keys(view.categories),
			...view.tasks.map((t) => t.task.category),
			...draft.tasks.map((t) => t.category),
		]),
	]
		.filter((c) => c.trim().length > 0)
		.sort();

	const setTask = (i: number, patch: Partial<DraftTask>): void =>
		setDraft((d) => ({ ...d, tasks: d.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
	const setSkill = (i: number, patch: Partial<DraftSkill>): void =>
		setDraft((d) => ({ ...d, skills: d.skills.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
	const addTask = (): void =>
		setDraft((d) => {
			const refs = new Set(d.tasks.map((t) => t.ref));
			let n = d.tasks.length + 1;
			while (refs.has(`t${n}`)) n++;
			return { ...d, tasks: [...d.tasks, newTask(`t${n}`)] };
		});
	const removeTask = (i: number): void =>
		setDraft((d) => {
			const ref = d.tasks[i]?.ref;
			return {
				...d,
				tasks: d.tasks.filter((_, j) => j !== i).map((t) => ({ ...t, after: t.after.filter((a) => a !== ref) })),
			};
		});
	const addSkill = (): void =>
		setDraft((d) => ({
			...d,
			skills: [
				...d.skills,
				{
					key: "",
					name: "",
					description: "",
					concepts: [""],
					prerequisites: [],
					resources: [],
					retrievalPrompts: [""],
					practiceMinutes: 60,
				},
			],
		}));
	const removeSkill = (i: number): void =>
		setDraft((d) => {
			const key = d.skills[i]?.key ?? "";
			// References to a skill you already have stay valid without the draft definition.
			const keep = (k: SkillKey): boolean => k !== key || savedKeys.has(k);
			return {
				...d,
				skills: d.skills.filter((_, j) => j !== i).map((s) => ({ ...s, prerequisites: s.prerequisites.filter(keep) })),
				tasks: d.tasks.map((t) => ({ ...t, requires: t.requires.filter((r) => keep(r.skill)) })),
			};
		});
	/** Follow a committed key rename in requirements and prerequisites. */
	const renameSkill = (from: SkillKey, to: SkillKey): void => {
		if (from === to || from === "" || savedKeys.has(from)) return;
		setDraft((d) => {
			if (d.skills.some((s) => s.key === from)) return d;
			return {
				...d,
				skills: d.skills.map((s) => ({
					...s,
					prerequisites: s.prerequisites.map((p) => (p === from ? to : p)),
				})),
				tasks: d.tasks.map((t) => ({
					...t,
					requires: t.requires.map((r) => (r.skill === from ? { ...r, skill: to } : r)),
				})),
			};
		});
	};

	const save = async (): Promise<void> => {
		if (errors.length > 0) return;
		setBusy(true);
		setError(null);
		const before = new Set(view.proposals.map((p) => p.id));
		const result = await sendEvent({ type: "PlanProposed", draft: clean, supersedes });
		setBusy(false);
		if (result.ok) setAwaiting(before);
		else setError(result.message);
	};

	return (
		<form
			class="stack plan plan-editor"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<p>
				<a href="#/plan">← All drafts</a>
			</p>
			<section class="panel stack">
				<h1 class="plan-goal">{supersedes ? `Edit draft ${supersedes}` : "Write a draft manually"}</h1>
				<p class="muted plan-small">
					Saving creates a new pending draft
					{supersedes ? ` that replaces ${supersedes} (marked superseded)` : ""}. You then rate yourself and approve it
					like any planner draft. Errors are checked live with the kernel's own validator.
				</p>
				<Field label="Goal" wide>
					<input
						value={draft.goal}
						maxLength={200}
						onInput={(e) => setDraft({ ...draft, goal: e.currentTarget.value })}
					/>
				</Field>
				<Field label="Summary (optional)" wide>
					<textarea
						rows={2}
						value={draft.summary}
						onInput={(e) => setDraft({ ...draft, summary: e.currentTarget.value })}
					/>
				</Field>
				<Errors errors={errors} prefix="goal" />
				<Errors errors={errors} prefix="summary" />
			</section>

			<datalist id="plan-categories">
				{categories.map((c) => (
					<option key={c} value={c} />
				))}
			</datalist>

			<h2>Tasks ({draft.tasks.length})</h2>
			<Errors errors={errors} prefix="tasks has" />
			{draft.tasks.map((t, i) => (
				<TaskEditor
					key={t.ref}
					task={t}
					index={i}
					draft={draft}
					knownKeys={knownKeys}
					skillName={skillName}
					errors={errors}
					onChange={(patch) => setTask(i, patch)}
					onRemove={draft.tasks.length > 1 ? () => removeTask(i) : null}
				/>
			))}
			<div>
				<button type="button" class="secondary" onClick={addTask}>
					Add task
				</button>
			</div>

			<h2>Skills ({draft.skills.length})</h2>
			<p class="muted plan-small">
				Define skills you do not have yet. Skills already in your list can be required directly without a definition.
			</p>
			<Errors errors={errors} prefix="skills has" />
			<Errors errors={errors} prefix="skills form" />
			{draft.skills.map((s, i) => (
				<SkillEditor
					key={i}
					skill={s}
					index={i}
					knownKeys={knownKeys}
					saved={savedKeys.has(s.key.trim())}
					skillName={skillName}
					errors={errors}
					onChange={(patch) => setSkill(i, patch)}
					onRename={renameSkill}
					onRemove={() => removeSkill(i)}
				/>
			))}
			<div>
				<button type="button" class="secondary" onClick={addSkill}>
					Add skill
				</button>
			</div>

			<section class="panel stack plan-editor-footer">
				{errors.length === 0 ? (
					<p class="plan-ok">The draft is valid.</p>
				) : (
					<details open>
						<summary class="error">
							{errors.length} problem{errors.length === 1 ? "" : "s"} to fix before saving
						</summary>
						<ul class="plan-errors">
							{errors.map((e) => (
								<li key={e}>{e}</li>
							))}
						</ul>
					</details>
				)}
				<div class="row">
					<button type="submit" class="primary" disabled={busy || awaiting !== null || errors.length > 0}>
						{awaiting !== null ? "Saved — opening…" : busy ? "Saving…" : "Save as new draft"}
					</button>
					<button type="button" class="secondary" onClick={onCancel}>
						Cancel
					</button>
				</div>
				{error ? <p class="error">{error}</p> : null}
			</section>
		</form>
	);
}

function TaskEditor({
	task,
	index,
	draft,
	knownKeys,
	skillName,
	errors,
	onChange,
	onRemove,
}: {
	readonly task: DraftTask;
	readonly index: number;
	readonly draft: PlanDraft;
	readonly knownKeys: readonly SkillKey[];
	readonly skillName: (key: SkillKey) => string;
	readonly errors: readonly string[];
	readonly onChange: (patch: Partial<DraftTask>) => void;
	readonly onRemove: (() => void) | null;
}) {
	const id = `plan-task-${task.ref}`;
	const used = new Set(task.requires.map((r) => r.skill));
	const free = knownKeys.find((k) => !used.has(k));
	const others = draft.tasks.filter((t) => t.ref !== task.ref);
	return (
		<article class="panel stack">
			<div class="row">
				<strong>Task {index + 1}</strong>
				<code class="muted">{task.ref}</code>
				{onRemove ? (
					<button type="button" class="danger" onClick={onRemove}>
						Remove task
					</button>
				) : null}
			</div>
			<div class="plan-fields">
				<Field label="Title" wide>
					<input value={task.title} maxLength={200} onInput={(e) => onChange({ title: e.currentTarget.value })} />
				</Field>
				<Field label="Done when (verifiable)" wide>
					<textarea rows={2} value={task.doneWhen} onInput={(e) => onChange({ doneWhen: e.currentTarget.value })} />
				</Field>
				<Field label="Notes" wide>
					<textarea rows={2} value={task.notes} onInput={(e) => onChange({ notes: e.currentTarget.value })} />
				</Field>
				<Field label="Category">
					<input
						value={task.category}
						maxLength={40}
						list="plan-categories"
						onInput={(e) => onChange({ category: e.currentTarget.value })}
					/>
				</Field>
				<Field label="Estimate (minutes)">
					<input
						type="number"
						min={1}
						step={1}
						value={numberValue(task.estimateMinutes)}
						onInput={(e) => onChange({ estimateMinutes: toNumber(e.currentTarget.value) })}
					/>
				</Field>
				<Field label="Importance">
					<select
						value={task.importance}
						onChange={(e) => onChange({ importance: Number(e.currentTarget.value) as Likert })}
					>
						{LIKERT.map((l) => (
							<option key={l} value={l}>
								{LIKERT_LABEL[l]}
							</option>
						))}
					</select>
				</Field>
				<Field label="Urgency">
					<select value={task.urgency} onChange={(e) => onChange({ urgency: Number(e.currentTarget.value) as Likert })}>
						{LIKERT.map((l) => (
							<option key={l} value={l}>
								{LIKERT_LABEL[l]}
							</option>
						))}
					</select>
				</Field>
			</div>

			<div class="stack">
				<h4>Requires</h4>
				{task.requires.length === 0 ? <p class="muted plan-small">No skill requirements.</p> : null}
				{task.requires.map((r, j) => (
					<div key={j} class="row plan-req">
						<label>
							Skill
							<select
								value={r.skill}
								onChange={(e) =>
									onChange({
										requires: task.requires.map((x, k) => (k === j ? { ...x, skill: e.currentTarget.value } : x)),
									})
								}
							>
								{(knownKeys.includes(r.skill) ? knownKeys : [r.skill, ...knownKeys]).map((k) => (
									<option key={k} value={k}>
										{skillName(k)} ({k || "no key"})
									</option>
								))}
							</select>
						</label>
						<label>
							Level
							<select
								value={r.level}
								onChange={(e) =>
									onChange({
										requires: task.requires.map((x, k) =>
											k === j ? { ...x, level: Number(e.currentTarget.value) as TargetLevel } : x,
										),
									})
								}
							>
								{TARGET_LEVELS.map((l) => (
									<option key={l} value={l}>
										L{l} {LEVEL_NAMES[l]}
									</option>
								))}
							</select>
						</label>
						<button
							type="button"
							class="secondary"
							onClick={() => onChange({ requires: task.requires.filter((_, k) => k !== j) })}
						>
							Remove
						</button>
					</div>
				))}
				<div class="row">
					<button
						type="button"
						class="secondary"
						disabled={free === undefined}
						onClick={() => {
							if (free !== undefined) onChange({ requires: [...task.requires, { skill: free, level: 1 }] });
						}}
					>
						Add requirement
					</button>
					{knownKeys.length === 0 ? <span class="muted plan-small">Add a skill below first.</span> : null}
				</div>
			</div>

			{others.length > 0 ? (
				<fieldset class="plan-checks">
					<legend>Do after</legend>
					{others.map((o) => (
						<label key={o.ref}>
							<input
								type="checkbox"
								id={`${id}-after-${o.ref}`}
								checked={task.after.includes(o.ref)}
								onChange={(e) =>
									onChange({
										after: e.currentTarget.checked ? [...task.after, o.ref] : task.after.filter((a) => a !== o.ref),
									})
								}
							/>
							{o.title || o.ref}
						</label>
					))}
				</fieldset>
			) : null}
			<Errors errors={errors} prefix={`tasks[${index}]`} />
		</article>
	);
}

function SkillEditor({
	skill,
	index,
	knownKeys,
	saved,
	skillName,
	errors,
	onChange,
	onRename,
	onRemove,
}: {
	readonly skill: DraftSkill;
	readonly index: number;
	readonly knownKeys: readonly SkillKey[];
	readonly saved: boolean;
	readonly skillName: (key: SkillKey) => string;
	readonly errors: readonly string[];
	readonly onChange: (patch: Partial<DraftSkill>) => void;
	readonly onRename: (from: SkillKey, to: SkillKey) => void;
	readonly onRemove: () => void;
}) {
	const keyAtFocus = useRef(skill.key);
	const setResource = (j: number, patch: Partial<Resource>): void =>
		onChange({ resources: skill.resources.map((r, k) => (k === j ? { ...r, ...patch } : r)) });
	const candidates = knownKeys.filter((k) => k !== skill.key.trim());
	return (
		<article class="panel stack">
			<div class="row">
				<strong>{skill.name || `Skill ${index + 1}`}</strong>
				<button type="button" class="danger" onClick={onRemove}>
					Remove skill
				</button>
			</div>
			<div class="plan-fields">
				<Field label="Name">
					<input value={skill.name} maxLength={120} onInput={(e) => onChange({ name: e.currentTarget.value })} />
				</Field>
				<Field label="Key (lowercase-kebab, stable across goals)">
					<input
						value={skill.key}
						maxLength={64}
						pattern={SKILL_KEY_PATTERN.source}
						onFocus={() => {
							keyAtFocus.current = skill.key;
						}}
						onInput={(e) => onChange({ key: e.currentTarget.value })}
						onChange={(e) => {
							const to = e.currentTarget.value.trim();
							onRename(keyAtFocus.current, to);
							keyAtFocus.current = to;
						}}
					/>
				</Field>
				{saved ? (
					<p class="muted plan-small wide">
						You already have this skill; approval keeps your saved definition and level.
					</p>
				) : null}
				<Field label="Description" wide>
					<textarea
						rows={2}
						value={skill.description}
						onInput={(e) => onChange({ description: e.currentTarget.value })}
					/>
				</Field>
				<Field label="What you need to know (one concept per line, 1–12)" wide>
					<textarea
						rows={3}
						value={skill.concepts.join("\n")}
						onInput={(e) => onChange({ concepts: e.currentTarget.value.split("\n") })}
					/>
				</Field>
				<Field label="Retrieval prompts (one per line, 1–8; ask to recall, not recognise)" wide>
					<textarea
						rows={3}
						value={skill.retrievalPrompts.join("\n")}
						onInput={(e) => onChange({ retrievalPrompts: e.currentTarget.value.split("\n") })}
					/>
				</Field>
				<Field label="Practice minutes per level step (5–2400)">
					<input
						type="number"
						min={5}
						max={2400}
						step={1}
						value={numberValue(skill.practiceMinutes)}
						onInput={(e) => onChange({ practiceMinutes: toNumber(e.currentTarget.value) })}
					/>
				</Field>
			</div>

			{candidates.length > 0 ? (
				<fieldset class="plan-checks">
					<legend>Learn first (prerequisites)</legend>
					{candidates.map((k) => (
						<label key={k}>
							<input
								type="checkbox"
								checked={skill.prerequisites.includes(k)}
								onChange={(e) =>
									onChange({
										prerequisites: e.currentTarget.checked
											? [...skill.prerequisites, k]
											: skill.prerequisites.filter((p) => p !== k),
									})
								}
							/>
							{skillName(k)}
						</label>
					))}
				</fieldset>
			) : null}

			<div class="stack">
				<h4>Resources</h4>
				{skill.resources.map((r, j) => (
					<div key={j} class="row plan-req">
						<label>
							Title
							<input value={r.title} onInput={(e) => setResource(j, { title: e.currentTarget.value })} />
						</label>
						<label>
							URL
							<input type="url" value={r.url} onInput={(e) => setResource(j, { url: e.currentTarget.value })} />
						</label>
						<button
							type="button"
							class="secondary"
							onClick={() => onChange({ resources: skill.resources.filter((_, k) => k !== j) })}
						>
							Remove
						</button>
					</div>
				))}
				<div>
					<button
						type="button"
						class="secondary"
						onClick={() => onChange({ resources: [...skill.resources, { title: "", url: "" }] })}
					>
						Add resource
					</button>
				</div>
			</div>
			<Errors errors={errors} prefix={`skills[${index}]`} />
		</article>
	);
}

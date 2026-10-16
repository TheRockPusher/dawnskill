import {
	ACTIVITY_GUIDE,
	canTaskTransition,
	LEVEL_NAMES,
	MIN_ESTIMATE_SAMPLES,
	type Proposal,
	type ReviewItem,
	type SkillState,
	type TaskView,
	type View,
} from "@dawnskill/core";
import { useState } from "preact/hooks";
import { type PlanRun, sendEvent, startPlan, useApp } from "../api.ts";
import {
	ActionButton,
	LEVEL_ANCHORS,
	LevelBadge,
	minutes,
	ScoreBreakdown,
	SkillLink,
	SkillStateBadge,
	TaskLink,
	taskById,
	when,
} from "../ui.tsx";

/** Home: "what should I do now?" */
export function Focus({ view }: { readonly view: View }) {
	const next = view.focus.next.flatMap((id) => taskById(view, id) ?? []);
	const learning = view.focus.learning.flatMap((id) => taskById(view, id) ?? []);
	return (
		<>
			<GoalIntake />
			<Summary view={view} />
			<NeedsYou view={view} />
			<div class="grid">
				<section class="panel">
					<header>
						<h2>Next up</h2>
						<span class="muted small">ranked by effective score</span>
					</header>
					{next.length === 0 ? (
						<p class="muted">
							No work is ready. Tasks appear here once their blockers are done and your skill levels meet their
							requirements — check <a href="#/tasks">Tasks</a> or finish the learning steps.
						</p>
					) : (
						<ul class="focus-list">
							{next.map((tv) => (
								<FocusItem key={tv.task.id} view={view} tv={tv} />
							))}
						</ul>
					)}
				</section>
				<section class="panel">
					<header>
						<h2>Learn next</h2>
						<span class="muted small">steps that unblock your work</span>
					</header>
					{learning.length === 0 ? (
						<p class="muted">
							No learning steps are ready. They are created when a task requires a higher skill level than yours.
						</p>
					) : (
						<ul class="focus-list">
							{learning.map((tv) => (
								<FocusItem key={tv.task.id} view={view} tv={tv} />
							))}
						</ul>
					)}
				</section>
			</div>
		</>
	);
}

// ---------- Goal intake and planner runs ----------

function GoalIntake() {
	const { config, runs } = useApp();
	const [goal, setGoal] = useState("");
	const [context, setContext] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const unconfigured = config !== null && !config.llm.configured;

	const submit = async () => {
		if (goal.trim() === "") return;
		setBusy(true);
		setError(null);
		try {
			const result = await startPlan(goal.trim(), context.trim(), null);
			if (result.ok) {
				setGoal("");
				setContext("");
			} else setError(result.message);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const recent = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
	const shown = recent.filter((r, i) => r.status === "running" || i < 5);

	return (
		<section class="panel">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<label>
					What do you want to achieve?
					<textarea
						value={goal}
						rows={2}
						placeholder="e.g. Ship a Rust CLI that syncs my notes to S3"
						onInput={(e) => setGoal(e.currentTarget.value)}
					/>
				</label>
				<details>
					<summary>Add context (optional)</summary>
					<label>
						Context for the planner
						<textarea
							value={context}
							rows={3}
							placeholder="What you already know, constraints, deadline, tools you use…"
							onInput={(e) => setContext(e.currentTarget.value)}
						/>
					</label>
				</details>
				<div class="row">
					<button type="submit" class="primary" disabled={busy || unconfigured || goal.trim() === ""}>
						{busy ? "Starting…" : "Plan it"}
					</button>
					{config?.llm.configured ? (
						<span class="muted small">
							The planner ({config.llm.model ?? "model"}) drafts tasks and skills; nothing changes until you approve the
							draft.
						</span>
					) : null}
					{error ? <span class="error">{error}</span> : null}
				</div>
				{unconfigured ? (
					<p class="muted small">
						No planner model is configured, so automatic planning is off. <a href="#/settings">Add one in Settings</a>{" "}
						or <a href="#/plan">write a plan draft by hand</a>.
					</p>
				) : null}
			</form>
			{shown.length > 0 ? (
				<ul class="focus-list">
					{shown.map((run) => (
						<RunItem key={run.id} run={run} />
					))}
				</ul>
			) : null}
		</section>
	);
}

function RunItem({ run }: { readonly run: PlanRun }) {
	const attempts = `${run.attempts} attempt${run.attempts === 1 ? "" : "s"}`;
	return (
		<li class="focus-item">
			<div class="row">
				<span
					class={`chip ${run.status === "failed" ? "state-gap" : run.status === "done" ? "state-assessed" : "state-learning"}`}
				>
					{run.status === "running" ? "planning…" : run.status}
				</span>
				<strong>{run.goal}</strong>
				<span class="muted small">
					{attempts} · started {when(run.startedAt)}
					{run.finishedAt ? ` · finished ${when(run.finishedAt)}` : ""}
				</span>
				{run.status === "done" && run.proposalId ? (
					<a href={`#/plan/${encodeURIComponent(run.proposalId)}`}>Review draft →</a>
				) : null}
			</div>
			{run.status === "failed" ? (
				<div class="stack">
					{run.error ? <p class="error">{run.error}</p> : null}
					{run.errors.length > 0 ? (
						<details>
							<summary>
								{run.errors.length} validation error{run.errors.length === 1 ? "" : "s"} across attempts
							</summary>
							<ul class="small">
								{run.errors.map((message, i) => (
									<li key={i}>{message}</li>
								))}
							</ul>
						</details>
					) : null}
					<p class="muted small">
						Try again with more context, or <a href="#/plan">write the draft by hand</a>.
					</p>
				</div>
			) : null}
		</li>
	);
}

// ---------- Summary ----------

const STATES: readonly SkillState[] = ["gap", "learning", "proposed", "unassessed", "assessed"];

function Summary({ view }: { readonly view: View }) {
	const open = view.tasks.filter((t) => t.task.status === "open" || t.task.status === "doing");
	const doing = open.filter((t) => t.task.status === "doing").length;
	const blocked = open.filter((t) => !t.ready).length;
	const counts: Record<SkillState, number> = { gap: 0, learning: 0, proposed: 0, unassessed: 0, assessed: 0 };
	for (const s of view.skills) counts[s.state]++;
	return (
		<section class="focus-summary stack">
			{view.goals.length > 0 ? (
				<ul class="focus-goals">
					{view.goals.map((g) => (
						<li key={g.goal.id} class="focus-goal" title={g.goal.summary}>
							<span class="focus-goal-title">{g.goal.title}</span>
							<progress
								value={g.done}
								max={Math.max(g.total, 1)}
								aria-label={`${g.goal.title}: ${g.done} of ${g.total} tasks done`}
							/>
							<span class="muted small">
								{g.done}/{g.total} done
								{g.cancelled > 0 ? ` · ${g.cancelled} cancelled` : ""}
							</span>
						</li>
					))}
				</ul>
			) : null}
			<div class="row small">
				<a href="#/tasks">
					{open.length} open task{open.length === 1 ? "" : "s"}
				</a>
				<span class="muted">
					({doing} in progress, {blocked} blocked)
				</span>
				<span class="muted">·</span>
				<a href="#/skills">
					{view.skills.length} skill{view.skills.length === 1 ? "" : "s"}
				</a>
				{STATES.map((s) => {
					const n = counts[s];
					return n > 0 ? (
						<span key={s} class="row focus-count">
							<SkillStateBadge state={s} />
							<strong>{n}</strong>
						</span>
					) : null;
				})}
			</div>
		</section>
	);
}

// ---------- Needs you ----------

function NeedsYou({ view }: { readonly view: View }) {
	const proposal = (id: string): Proposal | undefined => view.proposals.find((p) => p.id === id);
	const drafts = view.focus.drafts.flatMap((id) => proposal(id) ?? []);
	const confirmations = view.focus.confirmations.flatMap((id) => proposal(id) ?? []);
	const reviews = view.focus.reviewsDue;
	const empty = drafts.length + confirmations.length + reviews.length === 0;
	return (
		<section class="panel">
			<header>
				<h2>Needs you</h2>
				<span class="muted small">decisions only you can make</span>
			</header>
			{empty ? (
				<p class="muted">
					Nothing waiting. Plan drafts to approve, skill levels to confirm and due reviews show up here.
				</p>
			) : (
				<ul class="focus-list">
					{drafts.map((p) => (
						<DraftItem key={p.id} proposal={p} />
					))}
					{confirmations.map((p) => (
						<ConfirmationItem key={p.id} view={view} proposal={p} />
					))}
					{reviews.map((r) => (
						<ReviewDueItem key={r.skill} view={view} review={r} />
					))}
				</ul>
			)}
		</section>
	);
}

function DraftItem({ proposal }: { readonly proposal: Proposal }) {
	if (proposal.payload.kind !== "plan") return null;
	const { draft } = proposal.payload;
	return (
		<li class="focus-item">
			<div class="row">
				<span class="chip state-proposed">plan draft</span>
				<strong>{draft.goal}</strong>
				<span class="muted small">
					{draft.tasks.length} task{draft.tasks.length === 1 ? "" : "s"} · {draft.skills.length} skill
					{draft.skills.length === 1 ? "" : "s"} · by {proposal.actor} · {when(proposal.createdAt)}
				</span>
				<a href={`#/plan/${encodeURIComponent(proposal.id)}`}>Review and approve →</a>
			</div>
			{draft.summary ? <p class="muted small">{draft.summary}</p> : null}
		</li>
	);
}

function ConfirmationItem({ view, proposal }: { readonly view: View; readonly proposal: Proposal }) {
	const payload = proposal.payload.kind === "level" ? proposal.payload : null;
	const [evidence, setEvidence] = useState(payload?.evidence ?? "");
	const [reason, setReason] = useState("");
	if (payload === null) return null;
	const current = view.skills.find((s) => s.skill.key === payload.skill)?.skill.level ?? null;
	return (
		<li class="focus-item">
			<div class="row">
				<span class="chip state-proposed">confirm level</span>
				<SkillLink view={view} skillKey={payload.skill} />
				<LevelBadge level={current} />
				<span aria-hidden="true">→</span>
				<LevelBadge level={payload.level} />
				<strong>{LEVEL_NAMES[payload.level]}</strong>
				<span class="muted small">
					by {proposal.actor} · {when(proposal.createdAt)}
					{payload.fromTaskId ? (
						<>
							{" "}
							· after <TaskLink view={view} id={payload.fromTaskId} />
						</>
					) : null}
				</span>
			</div>
			<p class="small">
				<span class="muted">{LEVEL_NAMES[payload.level]} means: </span>
				{LEVEL_ANCHORS[payload.level]}
			</p>
			<label>
				Evidence (edit before confirming)
				<textarea value={evidence} rows={2} onInput={(e) => setEvidence(e.currentTarget.value)} />
			</label>
			<div class="row">
				<ActionButton
					kind="primary"
					event={{ type: "LevelConfirmed", proposalId: proposal.id, evidence: evidence.trim() }}
				>
					Confirm L{payload.level}
				</ActionButton>
				<input
					type="text"
					value={reason}
					placeholder="Why not? (optional)"
					aria-label="Reason for rejecting"
					onInput={(e) => setReason(e.currentTarget.value)}
				/>
				<ActionButton
					kind="danger"
					event={{ type: "ProposalRejected", proposalId: proposal.id, reason: reason.trim() }}
				>
					Reject
				</ActionButton>
			</div>
		</li>
	);
}

function ReviewDueItem({ view, review }: { readonly view: View; readonly review: ReviewItem }) {
	return (
		<li class="focus-item">
			<div class="row">
				<span class="chip state-learning">review due</span>
				<SkillLink view={view} skillKey={review.skill} />
				<span class="muted small">
					due {when(review.dueAt)} · streak {review.streak} · interval {review.intervalDays} day
					{review.intervalDays === 1 ? "" : "s"}
					{review.lastReviewAt ? ` · last ${when(review.lastReviewAt)}` : " · first review"}
				</span>
				<a href="#/learning">Review now →</a>
			</div>
		</li>
	);
}

// ---------- Next up / Learn next ----------

function EstimateText({ tv }: { readonly tv: TaskView }) {
	const { estimate, task } = tv;
	const why =
		estimate.applied && estimate.medianRatio !== null
			? `raw ${minutes(task.estimateMinutes)} × ${estimate.medianRatio.toFixed(2)}, median actual/estimate of ${estimate.samples} timed “${estimate.category}” tasks`
			: `raw estimate; calibration starts after ${MIN_ESTIMATE_SAMPLES} timed “${estimate.category}” tasks (${estimate.samples} so far)`;
	return (
		<span title={why}>
			≈ {minutes(tv.adjustedMinutes)} <span class="muted small">({why})</span>
		</span>
	);
}

function FocusItem({ view, tv }: { readonly view: View; readonly tv: TaskView }) {
	const [completing, setCompleting] = useState(false);
	const { task, score } = tv;
	const goal = task.goalId === null ? undefined : view.goals.find((g) => g.goal.id === task.goalId);
	const spec = task.learning;
	return (
		<li class="focus-item">
			<div class="row">
				<strong>
					<TaskLink view={view} id={task.id} />
				</strong>
				{task.status === "doing" ? <span class="chip state-learning">in progress</span> : null}
				{score ? (
					<span class="chip" title="Effective MCDA score (0–100); expand “Why this rank” for the breakdown">
						{score.effective.toFixed(1)}
						{score.inheritedFrom ? " ↑" : ""}
					</span>
				) : null}
			</div>
			<div class="focus-meta small">
				{goal ? <span class="muted">Goal: {goal.goal.title}</span> : <span class="muted">No goal</span>}
				<EstimateText tv={tv} />
				{score?.inheritedFrom ? (
					<span>
						↑ priority inherited from <TaskLink view={view} id={score.inheritedFrom} /> (own score{" "}
						{score.score.toFixed(1)})
					</span>
				) : null}
			</div>
			{spec ? (
				<div class="stack focus-learning small">
					<div class="row">
						<span class="chip state-learning">{ACTIVITY_GUIDE[spec.activity].label}</span>
						<SkillLink view={view} skillKey={spec.skill} />
						<span class="muted">to</span>
						<LevelBadge level={spec.targetLevel} />
						<span>{LEVEL_NAMES[spec.targetLevel]}</span>
					</div>
					<p>
						<span class="muted">Deliverable: </span>
						{spec.deliverable}
					</p>
					{tv.dependents.length > 0 ? (
						<p>
							<span class="muted">Unblocks: </span>
							{tv.dependents.map((id, i) => (
								<span key={id}>
									{i > 0 ? ", " : ""}
									<TaskLink view={view} id={id} />
								</span>
							))}
						</p>
					) : null}
				</div>
			) : null}
			{task.requirements.length > 0 ? (
				<div class="row small">
					<span class="muted">Requires:</span>
					{task.requirements.map((r) => {
						const have = view.skills.find((s) => s.skill.key === r.skill)?.skill.level ?? null;
						return (
							<span
								key={r.skill}
								class="row focus-req"
								title={`You: ${have === null ? "not assessed" : LEVEL_NAMES[have]}; needed: ${LEVEL_NAMES[r.level]}`}
							>
								<SkillLink view={view} skillKey={r.skill} />
								<LevelBadge level={r.level} />
							</span>
						);
					})}
				</div>
			) : null}
			{score ? (
				<details>
					<summary>Why this rank</summary>
					<ScoreBreakdown view={view} score={score} />
				</details>
			) : null}
			<div class="row">
				{canTaskTransition(task.status, "TaskStarted") ? (
					<ActionButton event={{ type: "TaskStarted", taskId: task.id }}>Start</ActionButton>
				) : null}
				{canTaskTransition(task.status, "TaskCompleted") && !completing ? (
					<button type="button" class="secondary" onClick={() => setCompleting(true)}>
						Complete…
					</button>
				) : null}
			</div>
			{completing ? <CompleteForm tv={tv} onClose={() => setCompleting(false)} /> : null}
		</li>
	);
}

function CompleteForm({ tv, onClose }: { readonly tv: TaskView; readonly onClose: () => void }) {
	const isLearning = tv.task.learning !== null;
	const [actual, setActual] = useState("");
	const [outcome, setOutcome] = useState("");
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		const actualMinutes = actual.trim() === "" ? null : Number(actual);
		if (actualMinutes !== null && !Number.isInteger(actualMinutes)) {
			setError("Actual minutes must be a whole number, or empty if you did not track time.");
			return;
		}
		setBusy(true);
		const result = await sendEvent({
			type: "TaskCompleted",
			taskId: tv.task.id,
			actualMinutes,
			outcome: outcome.trim(),
			evidenceUrl: url.trim() === "" ? null : url.trim(),
		});
		setBusy(false);
		if (result.ok) onClose();
		else setError(result.message);
	};

	return (
		<form
			class="focus-complete"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			{tv.task.doneWhen ? (
				<p class="small">
					<span class="muted">Done when: </span>
					{tv.task.doneWhen}
				</p>
			) : null}
			<label>
				{isLearning ? "What did you learn? (required)" : "Outcome (optional)"}
				<textarea
					value={outcome}
					rows={2}
					required={isLearning}
					placeholder={
						isLearning
							? "In your own words: what you can do now and how you proved it"
							: "What was achieved, anything worth remembering"
					}
					onInput={(e) => setOutcome(e.currentTarget.value)}
				/>
			</label>
			<div class="row">
				<label>
					Actual minutes (optional)
					<input
						type="number"
						min={1}
						step={1}
						value={actual}
						placeholder={String(tv.task.estimateMinutes)}
						onInput={(e) => setActual(e.currentTarget.value)}
					/>
				</label>
				<label class="focus-grow">
					Evidence URL (optional)
					<input type="url" value={url} placeholder="https://…" onInput={(e) => setUrl(e.currentTarget.value)} />
				</label>
			</div>
			{isLearning ? (
				<p class="muted small">Completing a learning step proposes the new level; you confirm it under “Needs you”.</p>
			) : (
				<p class="muted small">Tracked minutes calibrate future estimates in “{tv.task.category}”.</p>
			)}
			<div class="row">
				<button type="submit" class="primary" disabled={busy || (isLearning && outcome.trim() === "")}>
					{busy ? "Saving…" : "Mark done"}
				</button>
				<button type="button" class="secondary" onClick={onClose}>
					Cancel
				</button>
				{error ? <span class="error">{error}</span> : null}
			</div>
		</form>
	);
}

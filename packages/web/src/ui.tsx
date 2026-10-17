import {
	CRITERIA,
	LEVEL_NAMES,
	type Level,
	type SkillState,
	type TaskScore,
	type TaskView,
	type View,
} from "@dawnskill/core";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type EventResult, type PlanRun, type RunProgress, cancelPlan, sendEvent } from "./api.ts";
import type { EventBody } from "@dawnskill/core";

/** Behavioural self-assessment anchors per level (docs/learning-model.md §1). */
export const LEVEL_ANCHORS: Readonly<Record<Level, string>> = {
	0: "I have not used it yet.",
	1: "I need step-by-step instructions and follow rules without context.",
	2: "I recognise recurring situations but still need guidance for unfamiliar ones.",
	3: "I plan my own approach, work independently on standard problems and own the result.",
	4: "I see the whole situation, know what matters, and still decide deliberately.",
	5: "I act fluently and intuitively; I handle novel cases and teach others.",
};

export function LevelBadge({ level }: { readonly level: Level | null }) {
	return (
		<span class={`level level-${level ?? "none"}`} title={level === null ? "Not assessed" : LEVEL_NAMES[level]}>
			{level === null ? "L?" : `L${level}`}
		</span>
	);
}

const STATE_LABEL: Readonly<Record<SkillState, string>> = {
	unassessed: "not assessed",
	gap: "gap",
	learning: "learning",
	proposed: "awaiting confirmation",
	assessed: "assessed",
};

export function SkillStateBadge({ state }: { readonly state: SkillState }) {
	return <span class={`chip state-${state}`}>{STATE_LABEL[state]}</span>;
}

/** Cancels a queued or running planner run; renders nothing once the run has finished. */
export function CancelRunButton({ run }: { readonly run: PlanRun }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (run.status !== "queued" && run.status !== "running") return null;
	return (
		<span class="action">
			<button
				type="button"
				class="secondary"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					const result = await cancelPlan(run.id);
					setBusy(false);
					setError(result.ok ? null : result.message);
				}}
			>
				Cancel
			</button>
			{error ? <span class="error">{error}</span> : null}
		</span>
	);
}

export function taskById(view: View, id: string): TaskView | undefined {
	return view.tasks.find((t) => t.task.id === id);
}

export function TaskLink({ view, id }: { readonly view: View; readonly id: string }) {
	const t = taskById(view, id);
	return <a href={`#/tasks/${encodeURIComponent(id)}`}>{t ? t.task.title : id}</a>;
}

export function SkillLink({ view, skillKey }: { readonly view: View; readonly skillKey: string }) {
	const s = view.skills.find((v) => v.skill.key === skillKey);
	return <a href={`#/skills/${encodeURIComponent(skillKey)}`}>{s ? s.skill.name : skillKey}</a>;
}

export function minutes(value: number): string {
	if (value < 60) return `${value} min`;
	const h = Math.floor(value / 60);
	const m = value % 60;
	return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function when(iso: string): string {
	return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** MCDA explanation: raw value, normalized value, ROC weight and points per criterion. */
export function ScoreBreakdown({ view, score }: { readonly view: View; readonly score: TaskScore }) {
	return (
		<table class="breakdown">
			<thead>
				<tr>
					<th>Criterion</th>
					<th>Raw</th>
					<th>Normalized</th>
					<th>Weight</th>
					<th>Points</th>
				</tr>
			</thead>
			<tbody>
				{CRITERIA.map((c) => {
					const part = score.components[c];
					return (
						<tr key={c}>
							<td>{c}</td>
							<td>{Number.isInteger(part.raw) ? part.raw : part.raw.toFixed(2)}</td>
							<td>{part.normalized.toFixed(2)}</td>
							<td>{part.weight.toFixed(4)}</td>
							<td>{part.contribution.toFixed(1)}</td>
						</tr>
					);
				})}
			</tbody>
			<tfoot>
				<tr>
					<td colSpan={4}>Score</td>
					<td>{score.score.toFixed(1)}</td>
				</tr>
				<tr>
					<td colSpan={4}>
						Effective
						{score.inheritedFrom ? (
							<>
								{" "}
								(inherited from <TaskLink view={view} id={score.inheritedFrom} />)
							</>
						) : null}
					</td>
					<td>{score.effective.toFixed(1)}</td>
				</tr>
			</tfoot>
		</table>
	);
}

/** Button that sends one kernel event and shows the kernel's refusal inline. */
export function ActionButton({
	event,
	children,
	kind = "secondary",
	confirm,
	onDone,
}: {
	readonly event: EventBody | (() => EventBody | null);
	readonly children: ComponentChildren;
	readonly kind?: "primary" | "secondary" | "danger";
	readonly confirm?: string;
	readonly onDone?: (result: EventResult) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<span class="action">
			<button
				type="button"
				class={kind}
				disabled={busy}
				onClick={async () => {
					if (confirm && !window.confirm(confirm)) return;
					const body = typeof event === "function" ? event() : event;
					if (body === null) return;
					setBusy(true);
					const result = await sendEvent(body);
					setBusy(false);
					setError(result.ok ? null : result.message);
					onDone?.(result);
				}}
			>
				{children}
			</button>
			{error ? <span class="error">{error}</span> : null}
		</span>
	);
}

const THINKING_KEY = "dawnskill.showThinking";

function readShowThinking(): boolean {
	try {
		return localStorage.getItem(THINKING_KEY) === "1";
	} catch {
		return false;
	}
}

/** "Show model thinking", shared by every mounted RunLive and persisted across reloads. */
let showThinking = readShowThinking();
const thinkingListeners = new Set<(on: boolean) => void>();

function setShowThinking(on: boolean): void {
	showThinking = on;
	try {
		if (on) localStorage.setItem(THINKING_KEY, "1");
		else localStorage.removeItem(THINKING_KEY);
	} catch {
		// Storage unavailable (private mode, quota): the choice lasts until reload.
	}
	for (const listener of thinkingListeners) listener(on);
}

function useShowThinking(): boolean {
	const [on, setOn] = useState(showThinking);
	useEffect(() => {
		thinkingListeners.add(setOn);
		setOn(showThinking);
		return () => void thinkingListeners.delete(setOn);
	}, []);
	return on;
}

/**
 * A run's chip: the model's part (queued, planning, failed, cancelled) and, once its draft exists, whether the
 * draft is waiting for you.
 */
export function RunStatusChip({ view, run }: { readonly view: View; readonly run: PlanRun }) {
	const [label, cls] = runChip(view, run);
	return <span class={`chip ${cls}`}>{label}</span>;
}

function runChip(view: View, run: PlanRun): readonly [label: string, cls: string] {
	if (run.status === "queued") return ["queued", "state-unassessed"];
	if (run.status === "running") return ["model planning…", "state-learning"];
	if (run.status === "failed") return ["failed", "state-gap"];
	if (run.status === "cancelled") return ["cancelled", "state-unassessed"];
	const proposal = run.proposalId === null ? undefined : view.proposals.find((p) => p.id === run.proposalId);
	switch (proposal?.status) {
		case "pending":
			return ["awaiting your review", "state-proposed"];
		case "accepted":
			return ["approved", "state-assessed"];
		case "rejected":
			return ["rejected", "state-unassessed"];
		case "superseded":
			return ["superseded", "state-unassessed"];
		case undefined:
			return ["done", "state-assessed"];
	}
}

const STAGE_LABEL: Readonly<Record<RunProgress["stage"], string>> = {
	tasks: "drafting tasks",
	skills: "drafting skills",
	dedupe: "checking duplicate skills",
};

/** Live planner progress: stage, tokens and rate while running, optionally the model's thinking. */
export function RunLive({ run }: { readonly run: PlanRun }) {
	const thinking = useShowThinking();
	const progress = run.progress;
	const running = run.status === "running";
	if (progress === null) return running ? <p class="muted small run-live">waiting for the model…</p> : null;
	const rate = `${progress.tokensPerSecond === null ? "—" : progress.tokensPerSecond.toFixed(1)} tok/s`;
	if (!running) {
		return (
			<p class="muted small run-live">
				{progress.totalTokens} token{progress.totalTokens === 1 ? "" : "s"} · {rate}
			</p>
		);
	}
	const stats = [STAGE_LABEL[progress.stage]];
	if (progress.requests > 1) stats.push(`request ${progress.requests}`);
	stats.push(`${progress.tokens} token${progress.tokens === 1 ? "" : "s"}`, rate);
	return (
		<div class="run-live">
			<div class="row run-live-stats">
				<span class="muted small">{stats.join(" · ")}</span>
				<label class="small">
					<input type="checkbox" checked={thinking} onChange={(e) => setShowThinking(e.currentTarget.checked)} />
					Show model thinking
				</label>
			</div>
			{thinking ? (
				progress.reasoning !== "" ? (
					<ThinkingBox text={progress.reasoning} />
				) : progress.output !== "" ? (
					<>
						<span class="muted small">answer so far</span>
						<ThinkingBox text={progress.output} />
					</>
				) : (
					<p class="muted small">no thinking streamed yet</p>
				)
			) : null}
		</div>
	);
}

/** Scrollable tail of streamed text; follows new text unless the user has scrolled up. */
function ThinkingBox({ text }: { readonly text: string }) {
	const box = useRef<HTMLPreElement>(null);
	const pinned = useRef(true);
	useLayoutEffect(() => {
		if (box.current && pinned.current) box.current.scrollTop = box.current.scrollHeight;
	}, [text]);
	return (
		<pre
			ref={box}
			class="run-thinking"
			onScroll={(e) => {
				const el = e.currentTarget;
				pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
			}}
		>
			{text}
		</pre>
	);
}

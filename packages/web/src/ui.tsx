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
import { useState } from "preact/hooks";
import { type EventResult, sendEvent } from "./api.ts";
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

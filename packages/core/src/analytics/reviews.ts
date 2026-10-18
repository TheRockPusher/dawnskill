import type { Iso, KernelState, SkillKey } from "../kernel/types.ts";
import { DAY_MS } from "./mcda.ts";

/** Interval before the first review and after a forgotten one, in days: SM-2 I(1) (docs/learning-model.md §5). */
export const REVIEW_FIRST_DAYS = 1;
/** Interval after the first consecutive success, in days: SM-2 I(2) (docs/learning-model.md §5). */
export const REVIEW_SECOND_DAYS = 6;
/** Constant SM-2 easiness factor; later intervals are ceil(previous × ease) (docs/learning-model.md §5). */
export const REVIEW_EASE = 2.5;

export interface ReviewItem {
	readonly skill: SkillKey;
	readonly dueAt: Iso;
	/** dueAt <= now. */
	readonly due: boolean;
	/** Consecutive recalled reviews since the anchor or the last forgotten review. */
	readonly streak: number;
	readonly intervalDays: number;
	readonly lastReviewAt: Iso | null;
	readonly prompts: readonly string[];
}

/** Next interval after a review given the new streak and previous interval (docs/learning-model.md §5). */
export function nextInterval(streak: number, previous: number): number {
	if (streak === 0) return REVIEW_FIRST_DAYS;
	if (streak === 1) return REVIEW_SECOND_DAYS;
	return Math.ceil(previous * REVIEW_EASE);
}

/**
 * Spaced-review schedule for every skill with at least one done learning task or done task that
 * develops it, sorted by dueAt then skill.
 */
export function reviewSchedule(state: KernelState, now: Iso): ReviewItem[] {
	const nowMs = Date.parse(now);
	const anchors = new Map<SkillKey, { at: number; prompts: readonly string[] }>();
	for (const c of state.completions) {
		if (c.status !== "done") continue;
		const task = state.tasks[c.taskId];
		if (task === undefined) continue;
		const skills = task.learning === null ? (task.develops ?? []).map((d) => d.skill) : [task.learning.skill];
		const at = Date.parse(c.at);
		for (const skill of skills) {
			const def = state.skills[skill];
			if (def === undefined) continue;
			const prev = anchors.get(skill);
			if (prev === undefined || at > prev.at) anchors.set(skill, { at, prompts: def.retrievalPrompts });
		}
	}
	const items: ReviewItem[] = [];
	for (const [skill, { at: anchor, prompts }] of anchors) {
		const reviews = state.reviews
			.filter((r) => r.skill === skill && Date.parse(r.at) > anchor)
			.map((r, order) => ({ r, ms: Date.parse(r.at), order }))
			.sort((a, b) => a.ms - b.ms || a.order - b.order);
		let streak = 0;
		let interval = REVIEW_FIRST_DAYS;
		let last = anchor;
		let lastReviewAt: Iso | null = null;
		for (const { r, ms } of reviews) {
			streak = r.recalled ? streak + 1 : 0;
			interval = nextInterval(streak, interval);
			last = ms;
			lastReviewAt = r.at;
		}
		const dueMs = last + interval * DAY_MS;
		items.push({
			skill,
			dueAt: new Date(dueMs).toISOString(),
			due: dueMs <= nowMs,
			streak,
			intervalDays: interval,
			lastReviewAt,
			prompts,
		});
	}
	return items.sort((a, b) =>
		a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0,
	);
}

import type { KernelState } from "../kernel/types.ts";

/** Minimum reference-class size before the median ratio is applied (docs/learning-model.md §7, product heuristic). */
export const MIN_ESTIMATE_SAMPLES = 3;

export interface CategoryStats {
	readonly category: string;
	readonly samples: number;
	/** Median of actual/estimate ratios; null without samples. */
	readonly medianRatio: number | null;
	/** Unscaled median absolute deviation of the ratios; null without samples. */
	readonly mad: number | null;
	readonly applied: boolean;
}

/** Median of a non-empty list; even count = mean of the two middle values (docs/learning-model.md §7). */
export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	if (sorted.length % 2 === 1) return sorted[mid] as number;
	return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Reference-class statistics per category from done completions with tracked time (docs/learning-model.md §7). */
export function categoryStats(state: KernelState): Record<string, CategoryStats> {
	const ratios = new Map<string, number[]>();
	for (const c of state.completions) {
		if (c.status !== "done" || c.actualMinutes === null || c.actualMinutes <= 0 || c.estimateMinutes <= 0) continue;
		let list = ratios.get(c.category);
		if (list === undefined) {
			list = [];
			ratios.set(c.category, list);
		}
		list.push(c.actualMinutes / c.estimateMinutes);
	}
	const out: Record<string, CategoryStats> = {};
	for (const [category, list] of ratios) {
		const m = median(list);
		out[category] = {
			category,
			samples: list.length,
			medianRatio: m,
			mad: median(list.map((r) => Math.abs(r - m))),
			applied: list.length >= MIN_ESTIMATE_SAMPLES,
		};
	}
	return out;
}

/** Calibrated minutes: raw × median ratio when the class is large enough, else raw (docs/learning-model.md §7). */
export function adjustedMinutes(stats: CategoryStats | undefined, raw: number): number {
	if (stats === undefined || !stats.applied || stats.medianRatio === null) return raw;
	return Math.max(1, Math.ceil(raw * stats.medianRatio - 1e-9));
}

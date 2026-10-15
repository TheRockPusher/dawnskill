import type { Criterion, Iso, KernelState, Task, TaskId } from "../kernel/types.ts";
import { adjustedMinutes, categoryStats } from "./estimates.ts";

/** All MCDA criteria (docs/learning-model.md §6). */
export const CRITERIA: readonly Criterion[] = ["importance", "urgency", "unblocks", "effort", "age"];

/** One day in milliseconds; age is whole days since creation (docs/learning-model.md §6). */
export const DAY_MS = 86_400_000;

export interface Component {
	readonly raw: number;
	readonly normalized: number;
	readonly weight: number;
	/** Score points: 100 × weight × normalized (unrounded); components sum to the unrounded score. */
	readonly contribution: number;
}

export interface TaskScore {
	/** round1(100 · Σ w·n), in [0, 100]. */
	readonly score: number;
	/** max(own score, effective of open/doing tasks downstream). */
	readonly effective: number;
	/** Task whose score was inherited; null when the own score wins. */
	readonly inheritedFrom: TaskId | null;
	readonly components: Readonly<Record<Criterion, Component>>;
}

const isActive = (task: Task | undefined): boolean =>
	task !== undefined && (task.status === "open" || task.status === "doing");

/** Rank-Order Centroid weights: w_i = (1/n) Σ_{k=i}^{n} 1/k for the i-th ranked criterion (docs/learning-model.md §6). */
export function rocWeights(rank: readonly Criterion[]): Record<Criterion, number> {
	const out: Record<Criterion, number> = { importance: 0, urgency: 0, unblocks: 0, effort: 0, age: 0 };
	const n = rank.length;
	let tail = 0;
	for (let i = n - 1; i >= 0; i--) {
		tail += 1 / (i + 1);
		out[rank[i] as Criterion] = tail / n;
	}
	return out;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Direct dependents (tasks listing the key as a blocker), any status. */
export function dependentsIndex(state: KernelState): Map<TaskId, TaskId[]> {
	const out = new Map<TaskId, TaskId[]>();
	for (const [taskId, blockers] of Object.entries(state.blockers)) {
		for (const b of blockers) {
			let list = out.get(b);
			if (list === undefined) {
				list = [];
				out.set(b, list);
			}
			list.push(taskId);
		}
	}
	return out;
}

/** SAW scores with ROC weights and priority inheritance for every open/doing task (docs/learning-model.md §6). */
export function scoreTasks(state: KernelState, now: Iso): Record<TaskId, TaskScore> {
	const weights = rocWeights(state.preferences.criteriaRank);
	const stats = categoryStats(state);
	const nowMs = Date.parse(now);
	const ids = Object.keys(state.tasks);
	const index = new Map<TaskId, number>();
	ids.forEach((id, i) => index.set(id, i));
	const deps = dependentsIndex(state);
	const depIdx: Int32Array[] = ids.map((id) => {
		const list = deps.get(id) ?? [];
		const arr = new Int32Array(list.length);
		let k = 0;
		for (const d of list) {
			const j = index.get(d);
			if (j !== undefined) arr[k++] = j;
		}
		return arr.subarray(0, k);
	});
	const active = ids.map((id) => isActive(state.tasks[id]));

	// Transitive downstream count of active tasks: one DFS per alternative with a stamp array.
	const stamp = new Int32Array(ids.length);
	const stack = new Int32Array(ids.length);
	const unblocks = (start: number): number => {
		const mark = start + 1;
		stamp[start] = mark;
		let top = 0;
		let count = 0;
		stack[top++] = start;
		while (top > 0) {
			const cur = stack[--top] as number;
			for (const d of depIdx[cur] as Int32Array) {
				if (stamp[d] === mark) continue;
				stamp[d] = mark;
				if (active[d]) count++;
				stack[top++] = d;
			}
		}
		return count;
	};

	interface Raw {
		readonly i: number;
		readonly values: Record<Criterion, number>;
	}
	const raws: Raw[] = [];
	for (let i = 0; i < ids.length; i++) {
		if (!active[i]) continue;
		const task = state.tasks[ids[i] as TaskId] as Task;
		raws.push({
			i,
			values: {
				importance: task.importance,
				urgency: task.urgency,
				unblocks: unblocks(i),
				effort: adjustedMinutes(stats[task.category], task.estimateMinutes),
				age: Math.max(0, Math.floor((nowMs - Date.parse(task.createdAt)) / DAY_MS)),
			},
		});
	}

	const range = (f: (r: Raw) => number): readonly [number, number] => {
		let min = Infinity;
		let max = -Infinity;
		for (const r of raws) {
			const v = f(r);
			if (v < min) min = v;
			if (v > max) max = v;
		}
		return [min, max];
	};
	const [uMin, uMax] = range((r) => r.values.unblocks);
	const [aMin, aMax] = range((r) => r.values.age);
	const [eMin, eMax] = range((r) => Math.log(r.values.effort));
	const minMax = (x: number, min: number, max: number): number => (max > min ? (x - min) / (max - min) : 0);

	const own = new Float64Array(ids.length);
	const components: Array<Record<Criterion, Component> | undefined> = Array.from(
		{ length: ids.length },
		() => undefined,
	);
	for (const r of raws) {
		const v = r.values;
		const normalized: Record<Criterion, number> = {
			importance: (v.importance - 1) / 4,
			urgency: (v.urgency - 1) / 4,
			unblocks: minMax(v.unblocks, uMin, uMax),
			effort: eMax > eMin ? (eMax - Math.log(v.effort)) / (eMax - eMin) : 0,
			age: minMax(v.age, aMin, aMax),
		};
		let sum = 0;
		const comp = {} as Record<Criterion, Component>;
		for (const c of CRITERIA) {
			const contribution = 100 * weights[c] * normalized[c];
			sum += contribution;
			comp[c] = { raw: v[c], normalized: normalized[c], weight: weights[c], contribution };
		}
		own[r.i] = round1(sum);
		components[r.i] = comp;
	}

	// Effective priority: memoized DFS over active direct dependents (acyclic by K-invariant; guarded anyway).
	const effective = new Float64Array(ids.length);
	const origin = new Int32Array(ids.length).fill(-1);
	const state3 = new Uint8Array(ids.length); // 0 unvisited, 1 in progress, 2 done
	const resolve = (root: number): void => {
		const work: Array<[number, number]> = [[root, 0]];
		state3[root] = 1;
		while (work.length > 0) {
			const frame = work[work.length - 1] as [number, number];
			const [node, pos] = frame;
			const list = depIdx[node] as Int32Array;
			if (pos < list.length) {
				frame[1] = pos + 1;
				const d = list[pos] as number;
				if (active[d] && state3[d] === 0) {
					state3[d] = 1;
					work.push([d, 0]);
				}
				continue;
			}
			let best = own[node] as number;
			let from = -1;
			for (const d of list) {
				if (!active[d] || state3[d] !== 2) continue;
				if ((effective[d] as number) > best) {
					best = effective[d] as number;
					from = origin[d] === -1 ? d : (origin[d] as number);
				}
			}
			effective[node] = best;
			origin[node] = from;
			state3[node] = 2;
			work.pop();
		}
	};

	const out: Record<TaskId, TaskScore> = {};
	for (const r of raws) {
		if (state3[r.i] === 0) resolve(r.i);
		const from = origin[r.i] as number;
		out[ids[r.i] as TaskId] = {
			score: own[r.i] as number,
			effective: effective[r.i] as number,
			inheritedFrom: from === -1 ? null : (ids[from] as TaskId),
			components: components[r.i] as Record<Criterion, Component>,
		};
	}
	return out;
}

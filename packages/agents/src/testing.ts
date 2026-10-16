/** Test doubles for agent code: no network, no live model. */
import type { PlanDraft } from "@dawnskill/core";
import type { ChatProvider, JsonRequest } from "./provider.ts";

/**
 * The two planner replies (tasks stage, skills stage) for `draft`. `planGoal` returns `draft` when its
 * refs are `t1..tn`, `after` names earlier tasks, and each `requires` lists draft skills in draft order
 * before existing ones. A required key that is not a draft skill becomes a minimal reuse entry, so it
 * must exist in state.
 */
export function planResponses(draft: PlanDraft): [tasks: string, skills: string] {
	const index = new Map(draft.tasks.map((task, i) => [task.ref, i]));
	const tasks = draft.tasks.map((t) => ({
		title: t.title,
		doneWhen: t.doneWhen,
		notes: t.notes,
		category: t.category,
		estimateMinutes: t.estimateMinutes,
		importance: t.importance,
		urgency: t.urgency,
		after: t.after.map((ref) => index.get(ref)),
	}));
	const neededBy = (key: string) =>
		draft.tasks.flatMap((task, i) =>
			task.requires.filter((r) => r.skill === key).map((r) => ({ task: i, level: r.level })),
		);
	const drafted = new Set(draft.skills.map((skill) => skill.key));
	const reused = [...new Set(draft.tasks.flatMap((task) => task.requires.map((r) => r.skill)))].filter(
		(key) => !drafted.has(key),
	);
	const skills = [
		...draft.skills.map((skill) => ({ ...skill, neededBy: neededBy(skill.key) })),
		...reused.map((key) => ({
			key,
			name: key,
			description: "",
			concepts: [key],
			retrievalPrompts: [key],
			practiceMinutes: 60,
			prerequisites: [],
			resources: [],
			neededBy: neededBy(key),
		})),
	];
	return [JSON.stringify({ summary: draft.summary, tasks }), JSON.stringify({ skills })];
}

/**
 * Replays `script` in order, one entry per call, and records every request. A function entry
 * computes the reply from the request. An extra call throws; `assertDone` throws if replies are left.
 */
export function scriptedProvider(
	script: ReadonlyArray<string | ((request: JsonRequest) => string)>,
): ChatProvider & { readonly calls: readonly JsonRequest[]; assertDone(): void } {
	const calls: JsonRequest[] = [];
	return {
		model: "scripted",
		calls,
		async completeJson(request, signal) {
			signal?.throwIfAborted();
			calls.push(request);
			const step = script[calls.length - 1];
			if (step === undefined) {
				throw new Error(`scriptedProvider: unexpected call ${calls.length}; the script has ${script.length} replies`);
			}
			return typeof step === "string" ? step : step(request);
		},
		assertDone() {
			if (calls.length < script.length) {
				throw new Error(`scriptedProvider: ${script.length - calls.length} of ${script.length} replies unused`);
			}
		},
	};
}

/** Test doubles for agent code: no network, no live model. */
import type { PlanDraft } from "@dawnskill/core";
import type { ChatProvider, JsonRequest } from "./provider.ts";

/**
 * The two planner replies (tasks stage, skills stage) of a single-request plan for `draft`. `planGoal`
 * returns `draft` when it has 3–12 tasks (any number ≥ 3 uncapped, without a curriculum) with refs
 * `t1..tn`, `after` names earlier tasks, every draft skill is required or developed by some task and has
 * 2+ concepts and 2–4 retrieval prompts, and each `requires`/`develops` lists draft skills in draft
 * order before existing ones. A linked key that is not a draft skill becomes a minimal reuse entry, so
 * it must exist in state.
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
	const linked = (key: string, field: "requires" | "develops") =>
		draft.tasks.flatMap((task, i) =>
			(task[field] ?? []).filter((r) => r.skill === key).map((r) => ({ task: i, level: r.level })),
		);
	const drafted = new Set(draft.skills.map((skill) => skill.key));
	const reused = [
		...new Set(draft.tasks.flatMap((task) => [...task.requires, ...(task.develops ?? [])].map((r) => r.skill))),
	].filter((key) => !drafted.has(key));
	const skills = [
		...draft.skills.map((skill) => ({
			...skill,
			neededBy: linked(skill.key, "requires"),
			developedBy: linked(skill.key, "develops"),
		})),
		...reused.map((key) => ({
			key,
			name: key,
			description: "",
			concepts: [`${key} basics`, `${key} usage`],
			retrievalPrompts: [`Explain ${key}.`, `Use ${key}.`],
			practiceMinutes: 60,
			prerequisites: [],
			resources: [],
			neededBy: linked(key, "requires"),
			developedBy: linked(key, "develops"),
		})),
	];
	return [JSON.stringify({ summary: draft.summary, tasks }), JSON.stringify({ skills })];
}

/** An extraction reply listing `items`; absent fields are empty, `kind` defaults to book. */
export function extractResponse(
	items: readonly {
		readonly title: string;
		readonly section?: string;
		readonly creator?: string;
		readonly kind?: string;
		readonly level?: string;
		readonly note?: string;
	}[],
): string {
	return JSON.stringify({
		items: items.map((item) => ({
			section: item.section ?? "",
			title: item.title,
			creator: item.creator ?? "",
			kind: item.kind ?? "book",
			level: item.level ?? "",
			note: item.note ?? "",
		})),
	});
}

/**
 * Replays `script` in order, one entry per call, and records every request. A function entry
 * computes the reply from the request. `onDelta` hears the whole reply as one chunk. An extra call
 * throws; `assertDone` throws if replies are left.
 */
export function scriptedProvider(
	script: ReadonlyArray<string | ((request: JsonRequest) => string)>,
): ChatProvider & { readonly calls: readonly JsonRequest[]; assertDone(): void } {
	const calls: JsonRequest[] = [];
	return {
		model: "scripted",
		calls,
		async completeJson(request, signal, onDelta) {
			signal?.throwIfAborted();
			calls.push(request);
			const step = script[calls.length - 1];
			if (step === undefined) {
				throw new Error(`scriptedProvider: unexpected call ${calls.length}; the script has ${script.length} replies`);
			}
			const reply = typeof step === "string" ? step : step(request);
			onDelta?.({ reasoning: "", content: reply });
			return reply;
		},
		assertDone() {
			if (calls.length < script.length) {
				throw new Error(`scriptedProvider: ${script.length - calls.length} of ${script.length} replies unused`);
			}
		},
	};
}

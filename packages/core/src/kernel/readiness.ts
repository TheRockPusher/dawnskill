import type { KernelState, Level, Task, TargetLevel, TaskId, SkillKey } from "./types.ts";

export interface SkillGap {
	readonly skill: SkillKey;
	readonly required: TargetLevel;
	/** null = never assessed (treated as below every requirement). */
	readonly current: Level | null;
}

/** Blockers that are still open or in progress. Done and cancelled blockers release the task. */
export function openBlockers(state: KernelState, taskId: TaskId): readonly TaskId[] {
	return (state.blockers[taskId] ?? []).filter((id) => {
		const status = state.tasks[id]?.status;
		return status === "open" || status === "doing";
	});
}

/** Requirements the user's current confirmed levels do not meet. */
export function skillGaps(state: KernelState, task: Task): readonly SkillGap[] {
	const gaps: SkillGap[] = [];
	for (const { skill, level } of task.requirements) {
		const current = state.skills[skill]?.level ?? null;
		if (current === null || current < level) gaps.push({ skill, required: level, current });
	}
	return gaps;
}

/** Derived, never stored: an open dependency or a skill gap blocks starting the task (K3). */
export function isBlocked(state: KernelState, task: Task): boolean {
	return openBlockers(state, task.id).length > 0 || skillGaps(state, task).length > 0;
}

/** True if making `blockerId` a blocker of `taskId` would close a cycle: `taskId` is already upstream of `blockerId`. */
export function wouldCycle(state: KernelState, taskId: TaskId, blockerId: TaskId): boolean {
	if (taskId === blockerId) return true;
	const stack: TaskId[] = [blockerId];
	const seen = new Set<TaskId>();
	while (stack.length > 0) {
		const current = stack.pop() as TaskId;
		if (current === taskId) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const next of state.blockers[current] ?? []) stack.push(next);
	}
	return false;
}

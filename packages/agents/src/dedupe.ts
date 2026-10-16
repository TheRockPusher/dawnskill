/**
 * Skill deduplication: a new draft skill that names an already known skill is remapped to the
 * existing key, so levels accumulate across goals (docs/learning-model.md §2, naming). A cheap token
 * overlap picks candidates; the model judges each candidate pair, with a per-plan call cap.
 */
import {
	type DraftSkill,
	type KernelState,
	type PlanDraft,
	type Requirement,
	type Skill,
	type SkillKey,
	validateDraft,
} from "@dawnskill/core";
import { Value } from "typebox/value";
import type { ChatProvider } from "./provider.ts";
import { SAME_SKILL_SCHEMA } from "./schema.ts";

/** Token Jaccard of key + name at or above which a pair is worth a judge call. */
const CANDIDATE_JACCARD = 0.5;
/** Judge calls per plan, bounding cost on large skill inventories. */
const MAX_JUDGE_CALLS = 5;
const JUDGE_MAX_TOKENS = 20;

const JUDGE_SYSTEM = `You compare two skill definitions from a software developer's skill inventory.
They are the SAME skill only if a person's Dreyfus level in one would always equal their level in the other: same technology or domain and same capability, differing only in wording.
A broader versus a narrower capability, or the same capability in a different technology, is NOT the same skill.
Answer with JSON: {"same": true} or {"same": false}.`;

interface DedupeResult {
	readonly draft: PlanDraft;
	/** Draft skill key → existing state key it was merged into. */
	readonly remapped: Readonly<Record<SkillKey, SkillKey>>;
}

interface Candidate {
	readonly draft: DraftSkill;
	readonly existing: Skill;
	readonly score: number;
}

/** `draft` must already be valid against `state`; every applied remap keeps it valid. */
export async function dedupeSkills(
	provider: ChatProvider,
	state: KernelState,
	draft: PlanDraft,
	signal?: AbortSignal,
): Promise<DedupeResult> {
	const existing = Object.values(state.skills).map((skill) => ({ skill, tokens: tokens(skill.key, skill.name) }));
	const candidates: Candidate[] = [];
	for (const skill of draft.skills) {
		if (Object.hasOwn(state.skills, skill.key)) continue;
		const own = tokens(skill.key, skill.name);
		for (const other of existing) {
			const score = jaccard(own, other.tokens);
			if (score >= CANDIDATE_JACCARD) candidates.push({ draft: skill, existing: other.skill, score });
		}
	}
	// Stable sort: ties keep draft order, then state insertion order.
	candidates.sort((a, b) => b.score - a.score);

	let current = draft;
	const remapped: Record<SkillKey, SkillKey> = {};
	let calls = 0;
	for (const { draft: skill, existing: target } of candidates) {
		if (Object.hasOwn(remapped, skill.key)) continue;
		if (calls === MAX_JUDGE_CALLS) break;
		calls++;
		if (!(await judgeSame(provider, target, skill, signal))) continue;
		const next = remapSkill(current, skill.key, target.key);
		if (validateDraft(state, next).length > 0) continue;
		current = next;
		remapped[skill.key] = target.key;
	}
	return { draft: current, remapped };
}

async function judgeSame(
	provider: ChatProvider,
	existing: Skill,
	proposed: DraftSkill,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const describe = (
		label: string,
		s: { key: string; name: string; description: string; concepts: readonly string[] },
	) =>
		[
			`${label}`,
			`key: ${s.key}`,
			`name: ${s.name}`,
			`description: ${s.description}`,
			`concepts: ${s.concepts.join("; ")}`,
		].join("\n");
	const answer = await provider.completeJson(
		{
			system: JUDGE_SYSTEM,
			user: `${describe("Skill A (existing):", existing)}\n\n${describe("Skill B (proposed):", proposed)}\n\nAre A and B the same skill?`,
			schemaName: "same_skill",
			schema: SAME_SKILL_SCHEMA,
			maxTokens: JUDGE_MAX_TOKENS,
		},
		signal,
	);
	// Anything but an explicit yes keeps the new skill: a wrong merge would corrupt levels, a missed one only duplicates.
	let parsed: unknown;
	try {
		parsed = JSON.parse(answer);
	} catch {
		return false;
	}
	return Value.Check(SAME_SKILL_SCHEMA, parsed) && parsed.same;
}

/** Drops draft skill `from` and points every reference at `to`; merged requirements keep the higher level. */
function remapSkill(draft: PlanDraft, from: SkillKey, to: SkillKey): PlanDraft {
	const rename = (key: SkillKey): SkillKey => (key === from ? to : key);
	return {
		...draft,
		skills: draft.skills
			.filter((skill) => skill.key !== from)
			.map((skill) => ({
				...skill,
				prerequisites: [...new Set(skill.prerequisites.map(rename))].filter((key) => key !== skill.key),
			})),
		tasks: draft.tasks.map((task) => {
			const merged = new Map<SkillKey, Requirement>();
			for (const { skill, level } of task.requires) {
				const key = rename(skill);
				const seen = merged.get(key);
				if (seen === undefined || level > seen.level) merged.set(key, { skill: key, level });
			}
			return { ...task, requires: [...merged.values()] };
		}),
	};
}

function tokens(key: string, name: string): ReadonlySet<string> {
	return new Set(
		`${key} ${name}`
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t !== ""),
	);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	const union = a.size + b.size - shared;
	return union === 0 ? 0 : shared / union;
}

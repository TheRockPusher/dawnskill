/**
 * Planner prompts, grounded in docs/learning-model.md (Dreyfus levels, skill granularity, retrieval
 * practice). Compact stages so small local models fit: extraction lists the resources of supplied
 * sources, A writes tasks, B the skills they need or develop.
 */
import type { KernelState } from "@dawnskill/core";
import { type CurriculumItem, sourceLabel } from "./extract.ts";
import { MAX_TASK_MINUTES, MAX_TASKS, MAX_UNCAPPED_TASK_MINUTES } from "./schema.ts";

/** A page the user pointed at, already fetched. `text`: readable page text (`#` headings, `- ` list items, paragraphs). */
export interface PlannerSource {
	readonly url: string;
	readonly title: string;
	readonly text: string;
}

export interface PlannerInput {
	readonly goal: string;
	readonly context: string;
	/** Fetched pages; their recommended resources become the plan's curriculum. */
	readonly sources: readonly PlannerSource[];
	/** No task cap: a supplied curriculum is planned in full. */
	readonly uncapped: boolean;
}

export interface PlannerPrompt {
	readonly system: string;
	readonly user: string;
}

const EXTRACT_SYSTEM = `You extract the study resources a web page recommends, for Dawnskill, a learning-first task manager. Reply only with JSON matching the schema.
List every study resource the page recommends (books, courses, lecture notes, videos, articles, papers, problem sets, websites), in page order. Never invent or complete a resource the page does not name.
Per item:
- section: the nearest heading above the item, verbatim; "" if none.
- title: verbatim as on the page, without author or edition remarks.
- creator: author(s), lecturer or publisher as the page gives them; "" if none.
- kind: book, course, lecture-notes, video, article, paper, problem-set, website or other.
- level: the level the page gives (e.g. "introductory", "graduate"); "" if none.
- note: what the page says to do with it (chapters, exercises, order, why); may be empty.
Companion material (solution manuals, other editions, study guides, answer keys) goes into the note of the item it accompanies, never as its own item.
Skip navigation, ads, shop and newsletter links, comments and the author's biography. A text without study resources gives an empty list.`;

const TASK_RULES = `Plan only the real work. Every task is a concrete action on a named resource or produces a concrete product, e.g. "Read Stewart, Calculus: Early Transcendentals, ch. 1–4, and solve the odd exercises", "Write a 1500-word essay reconstructing Descartes' cogito argument", "Add a --glob flag to the CLI parser".
When the user supplies sources or a curriculum, the plan uses it: its resources, by title and author, in its order.
Never create tasks that hand planning work back to the user; the system has already done it. No fetching, scraping, collecting, extracting, tagging or deduplicating sources; no ordering resources or mapping prerequisites; no drafting a curriculum, syllabus or schedule; no trackers, spreadsheets or progress logs; no choosing texts; no piloting or reviewing the plan.
For software goals never add tutorial or "learn X" tasks: the system adds learning steps for skill gaps itself. For study goals reading a text, working its problems and writing about it are the real work.`;

/** Per-task field rules; `uncapped` tasks may span a whole resource. */
function taskFields(uncapped: boolean, items: boolean): string {
	return [
		"Per task:",
		...(items ? ["- item: the number of the curriculum item the task works on."] : []),
		'- title: an imperative, concrete action naming its resource or product ("Solve the problems of Spivak, Calculus, ch. 5"), not a topic.',
		'- doneWhen: an observable criterion a stranger could check ("all odd exercises of ch. 1–4 solved and checked", "PR opened with passing CI"), never "understand X".',
		uncapped
			? `- estimateMinutes: realistic total focused minutes for the whole piece of work, every exercise included, 15 to ${MAX_UNCAPPED_TASK_MINUTES}; working through a full textbook with its exercises often takes 3000 to 15000.`
			: `- estimateMinutes: focused minutes for someone who has the skills, 15 to ${MAX_TASK_MINUTES}. Split anything longer into several tasks.`,
		'- category: short lowercase kind of work (coding, debugging, reading, problem-solving, writing, research, setup, review, design). Reuse an existing category when one fits. Never "learning".',
		"- importance: 1 nice to have, 2 improves the result, 3 expected but could be trimmed, 4 a core part, 5 the goal fails without it.",
		"- urgency: 1 no time pressure, 2 within months, 3 within weeks, 4 this week, 5 within days or others are waiting. Without a deadline in the context use 2 or 3.",
		"- after: 0-based indices of EARLIER tasks that must be finished first, only when one task's output or knowledge is another's input. Put blockers first. Usually empty.",
		"- notes: approach hints or pitfalls; may be empty.",
	].join("\n");
}

const SKILLS_SYSTEM = `You identify the skills behind planned tasks, for Dawnskill, a learning-first task manager for software and study goals. Reply only with JSON matching the schema.
A skill links to tasks in two ways:
- developedBy: study and practice tasks that build the skill (reading a book, solving its problems, writing an essay, following a course), with the Dreyfus level the task brings the user to. These never block; finishing one lets the user claim the level.
- neededBy: tasks that depend on a skill the plan itself does not teach (an external prerequisite), with the level needed to do the task unaided. The system compares it with the user's level and adds learning steps for every gap.
A task's own subject goes in developedBy, never in neededBy: reading a calculus book develops calculus, it does not need it. Every skill has at least one task in neededBy or developedBy.
For each task find the 0 to 3 skills it genuinely develops or depends on. Skip generic abilities (editor, basic git, reading) unless the task is about them.
Per skill:
- key: lowercase kebab-case from the name, e.g. rust-ownership-borrowing. name: "<technology or domain>: <capability>", e.g. "Rust: ownership & borrowing", "Calculus: single-variable integration".
- Granularity: advancing ONE level must take at most 480 focused minutes of practice on one concrete deliverable. Otherwise split into narrower skills linked by prerequisites.
- Levels (Dreyfus):
  1 Novice: needs step-by-step instructions.
  2 Advanced beginner: adapts worked examples to familiar problems; stuck when things differ.
  3 Competent: plans and delivers non-trivial work alone; finds own mistakes.
  4 Proficient: sees quickly what matters in unfamiliar material; catches problems in others' work.
  5 Expert: handles novel cases intuitively.
  Most tasks need or bring 2 or 3; 4 only for subtle or advanced work; 5 almost never.
- description: what the skill covers and where it stops.
- concepts: 2 or more key ideas to know, as short phrases.
- retrievalPrompts: 2 to 4 questions answered from memory (recall, write, explain, derive); never multiple choice or yes/no.
- practiceMinutes: focused minutes to advance one level, 5 to 480.
- prerequisites: keys of other listed skills to learn first; no cycles; often empty.
- resources: official documentation only, and only URLs you are certain exist; otherwise empty. Never guess a URL.`;

/** Curriculum items shown to a capped plan: it covers the start of the curriculum only. */
const CAPPED_ITEMS_SHOWN = 24;

/** Extraction: one chunk of one source in, its study resources out. */
export function buildExtractPrompt(
	source: { readonly url: string; readonly title: string },
	chunk: string,
): PlannerPrompt {
	const title = source.title.trim();
	return {
		system: EXTRACT_SYSTEM,
		user: [`Source: ${title === "" ? source.url : `${title} (${source.url})`}`, "Text:", chunk].join("\n"),
	};
}

/** `number. [host] section — title by creator (kind; level) — note`, empty parts left out. */
function itemLine(item: CurriculumItem, number: number): string {
	const section = item.section === "" ? "" : `${item.section} — `;
	const creator = item.creator === "" ? "" : ` by ${item.creator}`;
	const kind = item.level === "" ? item.kind : `${item.kind}; ${item.level}`;
	const note = item.note === "" ? "" : ` — ${item.note}`;
	return `${number}. [${sourceLabel(item.source)}] ${section}${item.title}${creator} (${kind})${note}`;
}

/**
 * Stage A: goal, context and the curriculum (if any) in, tasks out. Existing categories keep
 * estimate reference classes stable. `batch`: this request covers curriculum items
 * `first..first + count - 1` (0-based) of an uncapped plan; `planned` are the tasks written so far.
 */
export function buildTasksPrompt(
	state: KernelState,
	input: PlannerInput,
	curriculum: readonly CurriculumItem[],
	batch: {
		readonly first: number;
		readonly count: number;
		readonly planned: readonly { readonly title: string }[];
	} | null = null,
): PlannerPrompt {
	const categories = [
		...new Set(
			Object.values(state.tasks)
				.map((t) => t.category)
				.filter((c) => c !== "learning"),
		),
	].sort();
	const context = input.context.trim();
	const head = [
		`Goal: ${input.goal.trim()}`,
		`Context: ${context === "" ? "(none)" : context}`,
		`Existing task categories: ${categories.length === 0 ? "(none)" : categories.join(", ")}`,
	];
	const intro = "You plan work for Dawnskill, a learning-first task manager, for software and study goals alike.";
	if (batch !== null) {
		const items = curriculum.slice(batch.first, batch.first + batch.count);
		const firstNumber = batch.first + 1;
		const lastNumber = batch.first + items.length;
		const summary =
			batch.planned.length === 0
				? `\nsummary: two or three sentences on the approach to the whole curriculum of ${curriculum.length} items.`
				: "";
		const system = [
			`${intro} The user's curriculum is planned in full, a few items per request. Reply only with JSON matching the schema.`,
			TASK_RULES,
			`This request covers curriculum items ${firstNumber} to ${lastNumber} of ${curriculum.length}, in order; tasks for earlier items already exist. Write at least one task per item. An item may yield a reading task plus a separate problem-solving or writing task when the source asks for exercises or essays. Companion material named in an item's note belongs to that item's tasks.${summary}`,
			taskFields(true, true),
			`Task indices continue the plan: your first task has index ${batch.planned.length}. after may name any earlier index, including already planned tasks.`,
		].join("\n");
		const user = [
			...head,
			`Already planned tasks (index. title):${batch.planned.length === 0 ? " (none)" : ""}`,
			...batch.planned.map((t, i) => `${i}. ${t.title}`),
			`Curriculum items for this request (number. [source] section — title by creator (kind; level) — note):`,
			...items.map((item, i) => itemLine(item, firstNumber + i)),
		].join("\n");
		return { system, user };
	}
	const count = input.uncapped
		? "Turn the user's goal into as many concrete tasks as it really needs, at least 3."
		: curriculum.length > 0
			? `Turn the user's goal into 3 to ${MAX_TASKS} concrete tasks that work through the curriculum from its first item, in order, as far as they reach.`
			: `Turn the user's goal into 3 to ${MAX_TASKS} concrete tasks.`;
	const summary =
		curriculum.length > 0 && !input.uncapped
			? "summary: two or three sentences on the approach, naming which curriculum items the plan covers (e.g. items 1 to 6 of 40)."
			: "summary: two or three sentences on the approach.";
	const system = [
		`${intro} ${count} Reply only with JSON matching the schema.`,
		TASK_RULES,
		summary,
		taskFields(input.uncapped, false),
	].join("\n");
	const shown = curriculum.slice(0, CAPPED_ITEMS_SHOWN);
	const more = curriculum.length - shown.length;
	const user = [
		...head,
		...(curriculum.length === 0
			? []
			: [
					`Curriculum, ${curriculum.length} items in order (number. [source] section — title by creator (kind; level) — note):`,
					...shown.map((item, i) => itemLine(item, i + 1)),
					...(more > 0 ? [`… ${more} more items`] : []),
				]),
	].join("\n");
	return { system, user };
}

/**
 * Stage B: numbered tasks in (global indices), skills with the tasks that need or develop them out.
 * Existing skills are not listed: small models copy unrelated keys. Reuse happens afterwards (exact key
 * match, dedupe judge). `defined`: skills earlier requests of this plan defined, so later ones reuse their keys.
 */
export function buildSkillsPrompt(
	goal: string,
	tasks: readonly { readonly index: number; readonly title: string; readonly doneWhen: string }[],
	defined: readonly { readonly key: string; readonly name: string }[] = [],
): PlannerPrompt {
	const user = [
		`Goal: ${goal}`,
		"Tasks (index. title; done when):",
		...tasks.map((t) => `${t.index}. ${t.title}; done when: ${t.doneWhen}`),
		...(defined.length === 0
			? []
			: [
					"Skills already defined for earlier tasks of this plan (key — name). When a task here develops or needs one of them, repeat it with the same key and only this request's tasks:",
					...defined.map((s) => `${s.key} — ${s.name}`),
				]),
	].join("\n");
	return { system: SKILLS_SYSTEM, user };
}

/**
 * Curriculum extraction helpers: page text is cut into chunks small enough for one extraction
 * request each, and the resources found are merged across chunks and sources in page order.
 */

/** One study resource a source recommends. `source`: the URL it was found on ("context" for the user's context). */
export interface CurriculumItem {
	readonly source: string;
	readonly section: string;
	readonly title: string;
	readonly creator: string;
	/** One of `RESOURCE_KINDS` (schema.ts). */
	readonly kind: string;
	readonly level: string;
	readonly note: string;
}

/** Characters per extraction request: a dense page section fits, and the reply stays far below the token budget. */
export const MAX_CHUNK = 8000;
/** Chunks shorter than this are not split further after a truncated reply. */
const MIN_SPLIT = 500;
const HEADING = /^#{1,6}\s/;

/**
 * Splits `text` into chunks of at most `max` chars at heading and blank-line boundaries; a block
 * longer than `max` is cut at line ends, a line longer than `max` at `max`. A chunk that starts
 * inside a section is prefixed with that section's heading, so every item keeps its section.
 */
export function chunkText(text: string, max: number): string[] {
	const blocks: string[] = [];
	let block: string[] = [];
	const flush = () => {
		if (block.length > 0) blocks.push(block.join("\n"));
		block = [];
	};
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (line.trim() === "") {
			flush();
			continue;
		}
		if (HEADING.test(line)) flush();
		block.push(line);
	}
	flush();

	const chunks: string[] = [];
	let current = "";
	let heading: string | null = null;
	const add = (piece: string) => {
		// A heading alone is never a chunk: the next block joins it even if that overflows `max` slightly.
		if (current !== "" && current !== heading && current.length + 2 + piece.length > max) {
			chunks.push(current);
			current = heading !== null && !HEADING.test(piece) ? heading : "";
		}
		current = current === "" ? piece : `${current}\n\n${piece}`;
	};
	for (const piece of blocks) {
		if (HEADING.test(piece)) heading = piece.split("\n", 1)[0] ?? null;
		if (piece.length <= max) {
			add(piece);
			continue;
		}
		for (const line of piece.split("\n")) {
			for (let at = 0; at < line.length; at += max) add(line.slice(at, at + max));
		}
	}
	if (current !== "") chunks.push(current);
	return chunks;
}

/** The two (or more) halves of a chunk whose reply was truncated; null when it is too short to split. */
export function halveChunk(chunk: string): string[] | null {
	if (chunk.length < MIN_SPLIT) return null;
	const parts = chunkText(chunk, Math.ceil(chunk.length / 2));
	return parts.length < 2 ? null : parts;
}

/** Title + creator, insensitive to case, spacing, punctuation and diacritics. */
function itemKey(item: Pick<CurriculumItem, "title" | "creator">): string {
	const norm = (text: string) =>
		text
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "");
	return `${norm(item.title)}\u0000${norm(item.creator)}`;
}

/** Keeps the first occurrence of each resource, in order. */
export function mergeItems(items: readonly CurriculumItem[]): CurriculumItem[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = itemKey(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Display host of a source URL; non-URL sources ("context") as they are. */
export function sourceLabel(source: string): string {
	return URL.canParse(source) ? new URL(source).host : source;
}

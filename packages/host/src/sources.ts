// Reading the pages a user links in a plan request, so the planner sees the curriculum itself instead of
// making the user transcribe it. HTML is reduced to markdown-like text: headings, list items and paragraphs
// survive, page chrome (navigation, scripts, forms, images) does not. Nothing here retries: a page that
// cannot be read fails the plan run with a message naming the link.
import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import type { PlannerSource } from "@dawnskill/agents";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Bytes read per page; the rest of a larger body is never downloaded. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Characters of readable text kept per page. */
const MAX_TEXT_CHARS = 200_000;
const READABLE_TYPES: Readonly<Record<string, "html" | "text">> = {
	"text/html": "html",
	"application/xhtml+xml": "html",
	"text/plain": "text",
};
/** Characters a URL in prose usually ends on that belong to the sentence, not the link. */
const TRAILING_PUNCTUATION = ".,;:!?)]}>'\"";
const OPENING_BRACKETS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
const USER_AGENT = userAgent();

const HEADINGS: Readonly<Record<string, string>> = {
	h1: "# ",
	h2: "## ",
	h3: "### ",
	h4: "#### ",
	h5: "##### ",
	h6: "###### ",
};
/**
 * How an element lays out its text; unlisted elements are inline. `skip`: page chrome or no text at all;
 * `paragraph`: a blank line before and after; `line`: a line break before and after; `cell`: a space after.
 */
const LAYOUT: Readonly<Record<string, "skip" | "paragraph" | "line" | "cell">> = {
	head: "skip",
	title: "skip",
	script: "skip",
	style: "skip",
	noscript: "skip",
	template: "skip",
	nav: "skip",
	header: "skip",
	footer: "skip",
	form: "skip",
	img: "skip",
	svg: "skip",
	iframe: "skip",
	p: "paragraph",
	div: "paragraph",
	section: "paragraph",
	article: "paragraph",
	main: "paragraph",
	aside: "paragraph",
	blockquote: "paragraph",
	pre: "paragraph",
	ul: "paragraph",
	ol: "paragraph",
	dl: "paragraph",
	table: "paragraph",
	figure: "paragraph",
	figcaption: "paragraph",
	address: "paragraph",
	hr: "paragraph",
	details: "paragraph",
	fieldset: "paragraph",
	br: "line",
	tr: "line",
	dt: "line",
	dd: "line",
	summary: "line",
	caption: "line",
	td: "cell",
	th: "cell",
};

export class SourceError extends Error {
	constructor(url: string, reason: string) {
		super(`could not read ${url}: ${reason}`);
		this.name = "SourceError";
	}
}

interface FetchSourcesOptions {
	readonly fetch?: typeof globalThis.fetch;
	/** Aborting rejects with the signal's reason, not a SourceError. */
	readonly signal?: AbortSignal;
	/** Per page, covering the response and its body. */
	readonly timeoutMs?: number;
}

/** Reads each page in order; the first page that cannot be read rejects with a SourceError. */
export async function fetchSources(
	urls: readonly string[],
	options: FetchSourcesOptions = {},
): Promise<PlannerSource[]> {
	const sources: PlannerSource[] = [];
	for (const url of urls) sources.push(await fetchSource(url, options));
	return sources;
}

/** http(s) URLs in `text`, in order of first appearance, without the sentence punctuation that follows them. */
export function findUrls(text: string): string[] {
	const found = new Set<string>();
	for (const [match] of text.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
		let end = match.length;
		while (end > 0 && TRAILING_PUNCTUATION.includes(match.charAt(end - 1))) {
			// A bracket the URL itself opened stays, as in https://en.wikipedia.org/wiki/Set_(mathematics).
			const closing = match.charAt(end - 1);
			const opening = OPENING_BRACKETS[closing];
			const head = match.slice(0, end);
			if (opening !== undefined && head.split(opening).length >= head.split(closing).length) break;
			end--;
		}
		const url = match.slice(0, end);
		if (URL.canParse(url)) found.add(url);
	}
	return [...found];
}

async function fetchSource(url: string, options: FetchSourcesOptions): Promise<PlannerSource> {
	const parsed = URL.parse(url);
	if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
		throw new SourceError(url, "only http and https links can be read");
	}
	const { signal } = options;
	signal?.throwIfAborted();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	let kind: "html" | "text" | undefined;
	let body: string;
	try {
		const response = await (options.fetch ?? globalThis.fetch)(parsed.href, {
			redirect: "follow",
			signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
			headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
		});
		const contentType = response.headers.get("content-type") ?? "";
		const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
		kind = READABLE_TYPES[type];
		const refusal = !response.ok
			? `HTTP ${response.status}${response.statusText === "" ? "" : ` ${response.statusText}`}`
			: kind === undefined
				? `unsupported content type ${type === "" ? "(none)" : type}`
				: null;
		if (refusal !== null) {
			await response.body?.cancel().catch(() => undefined);
			throw new SourceError(url, refusal);
		}
		body = await readCapped(response.body, decoderFor(contentType));
	} catch (error) {
		if (error instanceof SourceError) throw error;
		if (signal?.aborted) throw signal.reason;
		if (timeout.aborted) throw new SourceError(url, `no answer within ${timeoutMs / 1000} s`);
		throw new SourceError(url, describe(error));
	}
	const page = kind === "html" ? readHtml(body) : { title: "", text: body.replace(/\r\n?/g, "\n").trim() };
	const text = page.text.length > MAX_TEXT_CHARS ? page.text.slice(0, MAX_TEXT_CHARS).trimEnd() : page.text;
	if (text === "") throw new SourceError(url, "no readable text");
	return { url, title: page.title === "" ? url : page.title, text };
}

function decoderFor(contentType: string): TextDecoder {
	const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
	try {
		return new TextDecoder(charset ?? "utf-8");
	} catch {
		// An unknown label; most such pages are UTF-8 anyway.
		return new TextDecoder("utf-8");
	}
}

/** Decodes at most MAX_BODY_BYTES and cancels the rest of the stream. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, decoder: TextDecoder): Promise<string> {
	if (stream === null) return "";
	const reader = stream.getReader();
	let received = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = value.byteLength > MAX_BODY_BYTES - received ? value.subarray(0, MAX_BODY_BYTES - received) : value;
		received += chunk.byteLength;
		text += decoder.decode(chunk, { stream: true });
		if (received >= MAX_BODY_BYTES) {
			await reader.cancel().catch(() => undefined);
			break;
		}
	}
	return text + decoder.decode();
}

function describe(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	// Node's fetch rejects with "fetch failed" and puts the reason (DNS, refused, TLS) in `cause`.
	return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

/** The part of linkedom's DOM read here; its own types need the DOM lib, which the host does not load. */
interface DomNode {
	readonly nodeType: number;
	readonly localName?: string;
	readonly textContent: string | null;
	readonly childNodes: Iterable<DomNode>;
	/** Elements only. */
	hasAttribute?(name: string): boolean;
}

interface DomDocument {
	readonly body: DomNode | null;
	querySelector(selector: string): DomNode | null;
	querySelectorAll(selector: string): Iterable<{ setAttribute(name: string, value: string): void }>;
}

/** Readability renames every h1 to h2; this mark on the renamed element keeps it a top-level heading. */
const H1_MARK = "data-dawnskill-h1";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * linkedom builds the tree as written, without HTML's implied <body>: a page that omits the tag (legal, and
 * common on hand-written pages) parses into an empty body. Such pages get an explicit one.
 */
function parseDocument(html: string): DomDocument {
	const page = /<body[\s>]/i.test(html)
		? html
		: `<html><body>${html.replace(/<!doctype[^>]*>|<\/?html(?:\s[^>]*)?>/gi, "")}</body></html>`;
	// parseHTML is typed against the DOM lib's Window; DomDocument names the members used.
	const { document } = parseHTML(page) as { document: DomDocument };
	return document;
}

function readHtml(html: string): { title: string; text: string } {
	const document = parseDocument(html);
	const pageTitle = collapse(document.querySelector("title")?.textContent ?? "");
	for (const h1 of document.querySelectorAll("h1")) h1.setAttribute(H1_MARK, "");
	// Readability drops blocks it finds link-dense; on a curriculum page those are whole sections of book
	// lists. `linkDensityModifier` raises that limit. 0.6.0 reads the option, but its typings omit it, so
	// the options go in as a variable (no excess-property check).
	const options = { serializer: (node: DomNode) => node, linkDensityModifier: 1 };
	const article = new Readability(document, options).parse();
	const title = collapse(article?.title ?? "") || pageTitle;
	const fromArticle = article?.content ? toText(article.content) : "";
	if (fromArticle !== "") return { title, text: fromArticle };
	// Readability mutates the document it reads, so the <body> fallback parses the page again.
	const { body } = parseDocument(html);
	return { title, text: body === null ? "" : toText(body) };
}

function collapse(text: string): string {
	return text.replace(/[\s\u200b]+/g, " ").trim();
}

function toText(root: DomNode): string {
	const writer = new TextWriter();
	walk(root, writer);
	return writer.finish();
}

function walk(node: DomNode, writer: TextWriter): void {
	if (node.nodeType === TEXT_NODE) writer.inline(node.textContent ?? "");
	if (node.nodeType !== ELEMENT_NODE) return;
	const tag = node.localName ?? "";
	const children = (): void => {
		for (const child of node.childNodes) walk(child, writer);
	};
	const heading = tag === "h2" && node.hasAttribute?.(H1_MARK) ? HEADINGS.h1 : HEADINGS[tag];
	if (heading !== undefined) return writer.prefixed(heading, false, children);
	if (tag === "li") return writer.prefixed("- ", true, children);
	const layout = LAYOUT[tag];
	if (layout === "skip") return;
	if (layout === "paragraph") writer.paragraph();
	if (layout === "line") writer.line();
	children();
	if (layout === "paragraph") writer.paragraph();
	if (layout === "line") writer.line();
	if (layout === "cell") writer.inline(" ");
}

/**
 * Collects text into lines. A heading or list item sets a prefix that waits for its first non-empty
 * line, so `<li><p>text</p></li>` still reads `- text`.
 */
class TextWriter {
	readonly #lines: string[] = [];
	#current = "";
	#prefix = "";
	#listItems = 0;

	inline(text: string): void {
		this.#current += text;
	}

	/** Ends the current line; an empty line keeps the pending prefix. */
	line(): void {
		const text = collapse(this.#current);
		this.#current = "";
		if (text === "") return;
		this.#lines.push(this.#prefix + text);
		this.#prefix = "";
	}

	/** Ends the current line and leaves a blank one; list items stay contiguous. */
	paragraph(): void {
		this.line();
		if (this.#listItems === 0) this.#lines.push("");
	}

	/** Headings stand in their own paragraph; list items (`listItem`) follow one another line by line. */
	prefixed(prefix: string, listItem: boolean, children: () => void): void {
		if (listItem) this.line();
		else this.paragraph();
		this.#prefix = prefix;
		if (listItem) this.#listItems++;
		children();
		if (listItem) this.#listItems--;
		this.line();
		this.#prefix = "";
		if (!listItem) this.paragraph();
	}

	/** Lines without repeated blanks or a line repeating the one before it (menus often render twice). */
	finish(): string {
		this.line();
		const kept: string[] = [];
		let previous = "";
		for (const line of this.#lines) {
			if (line === "") {
				if (kept.length > 0 && kept.at(-1) !== "") kept.push("");
			} else if (line !== previous) {
				kept.push(line);
				previous = line;
			}
		}
		while (kept.at(-1) === "") kept.pop();
		return kept.join("\n");
	}
}

function userAgent(): string {
	try {
		const root: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
		const version = typeof root === "object" && root !== null && "version" in root ? root.version : undefined;
		return typeof version === "string" ? `dawnskill/${version}` : "dawnskill";
	} catch {
		return "dawnskill";
	}
}

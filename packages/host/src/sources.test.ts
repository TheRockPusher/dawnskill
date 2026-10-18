import { describe, expect, it } from "vitest";
import { SourceError, fetchSources, findUrls } from "./sources.ts";

const PROSE =
	"Work through every chapter and solve the exercises at the end of each one before you move on to the next topic in the list.";

const respond =
	(
		body: ConstructorParameters<typeof Response>[0],
		headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" },
	) =>
	(): Promise<Response> =>
		Promise.resolve(new Response(body, { headers }));

/** Never answers on its own; rejects with the abort reason like the real fetch. */
const hanging: typeof fetch = (_input, init) => {
	const { promise, reject } = Promise.withResolvers<Response>();
	const signal = init?.signal;
	if (signal) signal.addEventListener("abort", () => reject(signal.reason));
	return promise;
};

describe("fetchSources", () => {
	it("reduces an HTML page to its headings, list items and paragraphs without page chrome", async () => {
		const html = `<!doctype html><html><head><title>Mathematics — Example</title>
<style>p { color: red }</style><script>var tracking = "script text";</script></head><body>
<header><nav><ul><li><a href="/">Home</a></li><li><a href="/math">Math</a></li></ul></nav></header>
<main><article>
<h1>So You Want to Study Mathematics</h1>
<p>${PROSE} ${PROSE}</p>
<h2>The Curriculum</h2>
<h3>1. Calculus</h3>
<p>${PROSE}</p>
<ul><li><p><strong>e: The Story of a Number</strong> by <a href="https://example.com/maor">Eli Maor</a> (Level: Easy). A history of e.</p></li>
<li>Calculus by Michael Spivak (essential).</li></ul>
<h3>2. Linear Algebra</h3>
<p>Linear algebra &amp; its applications are everywhere&nbsp;in physics. ${PROSE}</p>
<ol><li>Linear Algebra Done Right by Sheldon Axler.</li></ol>
</article></main>
<footer><p>Copyright 2026.</p><form><input name="email"><button>Subscribe</button></form></footer>
</body></html>`;

		const sources = await fetchSources(["https://example.com/math"], { fetch: respond(html) });

		expect(sources).toEqual([
			{
				url: "https://example.com/math",
				title: "Mathematics — Example",
				text: [
					"# So You Want to Study Mathematics",
					"",
					`${PROSE} ${PROSE}`,
					"",
					"## The Curriculum",
					"",
					"### 1. Calculus",
					"",
					PROSE,
					"",
					"- e: The Story of a Number by Eli Maor (Level: Easy). A history of e.",
					"- Calculus by Michael Spivak (essential).",
					"",
					"### 2. Linear Algebra",
					"",
					`Linear algebra & its applications are everywhere in physics. ${PROSE}`,
					"",
					"- Linear Algebra Done Right by Sheldon Axler.",
				].join("\n"),
			},
		]);
	});

	it("keeps a section that is mostly links, as curriculum reading lists are", async () => {
		const books = Array.from({ length: 6 }, (_, i) => `<li><a href="https://example.com/b${i}">Book ${i}</a></li>`);
		const html = `<html><head><title>Physics</title></head><body><div id="content">
<h2>Undergraduate Physics</h2><p>${PROSE} ${PROSE} ${PROSE}</p>
<div class="block"><h3>8. Thermodynamics</h3><p><a href="https://example.com/t">Thermodynamics</a> and <a href="https://example.com/s">statistical mechanics</a></p><ul>${books.join("")}</ul></div>
<h3>9. Electives</h3><p>${PROSE} ${PROSE}</p></div></body></html>`;

		const [source] = await fetchSources(["https://example.com/physics"], { fetch: respond(html) });

		expect(source?.text).toContain(
			[
				"### 8. Thermodynamics",
				"",
				"Thermodynamics and statistical mechanics",
				"",
				...Array.from({ length: 6 }, (_, i) => `- Book ${i}`),
				"",
				"### 9. Electives",
			].join("\n"),
		);
	});

	it("passes plain text through, decoding the declared charset", async () => {
		const latin1 = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x4e, 0x6f, 0x74, 0x65, 0x73, 0x0a]);

		const sources = await fetchSources(["https://example.com/notes.txt"], {
			fetch: respond(latin1, { "content-type": "text/plain; charset=iso-8859-1" }),
		});

		expect(sources).toEqual([
			{ url: "https://example.com/notes.txt", title: "https://example.com/notes.txt", text: "Café\nNotes" },
		]);
	});

	it("returns pages in request order and fails on the first unreadable one", async () => {
		const pages: Record<string, string> = {
			"https://example.com/a": "<title>A</title><p>First page.</p>",
			"https://example.com/b": "<title>B</title><p>Second page.</p>",
		};
		const fetch: typeof globalThis.fetch = (input) => {
			const page = typeof input === "string" ? pages[input] : undefined;
			return Promise.resolve(
				page === undefined
					? new Response("missing", { status: 404, statusText: "Not Found" })
					: new Response(page, { headers: { "content-type": "text/html" } }),
			);
		};

		const sources = await fetchSources(["https://example.com/b", "https://example.com/a"], { fetch });
		expect(sources.map(({ title, text }) => [title, text])).toEqual([
			["B", "Second page."],
			["A", "First page."],
		]);
		await expect(
			fetchSources(["https://example.com/a", "https://example.com/gone", "https://example.com/b"], { fetch }),
		).rejects.toStrictEqual(new SourceError("https://example.com/gone", "HTTP 404 Not Found"));
	});

	it("refuses links that are not http(s) without requesting them", async () => {
		const fetch = (): Promise<Response> => Promise.reject(new Error("requested"));

		for (const url of ["file:///etc/passwd", "ftp://example.com/list.txt", "not a url"]) {
			await expect(fetchSources([url], { fetch })).rejects.toStrictEqual(
				new SourceError(url, "only http and https links can be read"),
			);
		}
	});

	it("refuses content that is not a web page or plain text", async () => {
		await expect(
			fetchSources(["https://example.com/book.pdf"], {
				fetch: respond("%PDF-1.7", { "content-type": "application/pdf" }),
			}),
		).rejects.toStrictEqual(
			new SourceError("https://example.com/book.pdf", "unsupported content type application/pdf"),
		);
	});

	it("refuses a page with nothing readable left after the chrome is removed", async () => {
		const html = "<html><body><nav><a href='/'>Home</a></nav><script>render()</script><img src='a.png'></body></html>";

		await expect(fetchSources(["https://example.com/app"], { fetch: respond(html) })).rejects.toStrictEqual(
			new SourceError("https://example.com/app", "no readable text"),
		);
	});

	it("stops reading an endless body and caps the text", async () => {
		const chunk = new TextEncoder().encode("word ".repeat(16_384));
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull: (controller) => controller.enqueue(chunk),
			cancel: () => {
				cancelled = true;
			},
		});

		const [source] = await fetchSources(["https://example.com/stream"], {
			fetch: respond(body, { "content-type": "text/plain" }),
		});

		expect(cancelled).toBe(true);
		expect(source?.text.length).toBeLessThanOrEqual(200_000);
		expect(source?.text.startsWith("word word")).toBe(true);
	});

	it("rejects with the caller's abort reason rather than a SourceError", async () => {
		const controller = new AbortController();
		const reason = new Error("plan run cancelled");

		const pending = fetchSources(["https://example.com/slow"], { fetch: hanging, signal: controller.signal });
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});

	it("turns a timeout into a SourceError", async () => {
		await expect(fetchSources(["https://example.com/slow"], { fetch: hanging, timeoutMs: 5 })).rejects.toStrictEqual(
			new SourceError("https://example.com/slow", "no answer within 0.005 s"),
		);
	});
});

describe("findUrls", () => {
	it("finds http(s) links in order, without trailing punctuation and without repeats", () => {
		const text = [
			"Learn from https://www.susanrigetti.com/physics, then (https://www.susanrigetti.com/math).",
			"Sets: https://en.wikipedia.org/wiki/Set_(mathematics). Again https://www.susanrigetti.com/physics!",
			"Quoted 'https://example.com/q?a=1&b=2' and <https://example.com/angle>; ftp://example.com/x and http:// alone.",
			'"HTTPS://EXAMPLE.COM/LOUD"',
		].join("\n");

		expect(findUrls(text)).toEqual([
			"https://www.susanrigetti.com/physics",
			"https://www.susanrigetti.com/math",
			"https://en.wikipedia.org/wiki/Set_(mathematics)",
			"https://example.com/q?a=1&b=2",
			"https://example.com/angle",
			"HTTPS://EXAMPLE.COM/LOUD",
		]);
	});
});

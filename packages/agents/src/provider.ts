/**
 * OpenAI-compatible chat-completions client (llama.cpp server, vLLM, Ollama, OpenAI, …) returning JSON text.
 * Requests a streamed reply so callers can watch thinking and answer arrive; a server that ignores
 * `stream` and answers with one JSON body works too.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";

/** The part of a chat-completions response we read; servers add many more fields. */
const COMPLETION = Type.Object({
	choices: Type.Array(
		Type.Object({
			message: Type.Object({
				content: Type.Union([Type.String(), Type.Null()]),
				refusal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
			finish_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
		{ minItems: 1 },
	),
});

const TEXT = Type.Optional(Type.Union([Type.String(), Type.Null()]));
/** The part of one streamed chunk we read. OpenRouter reports failures mid-stream as `error`. */
const STREAM_CHUNK = Type.Object({
	error: Type.Optional(Type.Object({ message: Type.Optional(Type.String()) })),
	choices: Type.Optional(
		Type.Array(
			Type.Object({
				delta: Type.Optional(Type.Object({ content: TEXT, reasoning_content: TEXT, reasoning: TEXT, refusal: TEXT })),
				finish_reason: TEXT,
			}),
		),
	),
});

export interface LlmLimits {
	readonly timeoutMs: number;
	/** Upper bound on `max_tokens` for any request; size it to the model's context. */
	readonly maxTokens: number;
}

export interface LlmConfig extends LlmLimits {
	/** API root including the version segment, e.g. `http://127.0.0.1:8080/v1`. */
	readonly baseUrl: string;
	readonly apiKey: string | null;
	readonly model: string;
}

export interface JsonRequest {
	readonly system: string;
	readonly user: string;
	readonly schemaName: string;
	/** Plain JSON Schema object, strict-mode compatible. */
	readonly schema: object;
	/** Tokens the reply may need at most, capped at the configured budget; absent: the configured budget. */
	readonly maxTokens?: number;
}

/** One streamed chunk of a reply. `reasoning`: the model's thinking (`delta.reasoning_content` from llama.cpp/DeepSeek/vLLM, or `delta.reasoning` from OpenRouter/Ollama); `content`: answer text. Either may be "". */
export interface ReplyDelta {
	readonly reasoning: string;
	readonly content: string;
}

/** One provider is one conversation: every request it sends carries the same session ID. */
export interface ChatProvider {
	readonly model: string;
	/** Raw JSON text of the assistant reply. `onDelta` hears each streamed chunk as it arrives (≈ one token). */
	completeJson(request: JsonRequest, signal?: AbortSignal, onDelta?: (delta: ReplyDelta) => void): Promise<string>;
}

export interface ProviderOptions {
	/** Sent as `User-Agent`, e.g. `dawnskill/0.2.0`; hosted gateways such as OpenCode Go ask clients to identify themselves. */
	readonly userAgent: string;
	readonly fetch?: typeof fetch;
	/** Waits between retries of transient failures; must reject with `signal.reason` when `signal` aborts. Tests inject an instant one. */
	readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/** The server cannot fit the request into the model's context; retrying cannot help. */
export class ContextSizeError extends Error {
	constructor(detail: string) {
		super(`model context too small: ${detail}`);
		this.name = "ContextSizeError";
	}
}

/**
 * The reply hit `max_tokens` before it ended (`finish_reason: "length"`). `thinkingOnly`: no answer content
 * arrived first, so the model's thinking used the whole budget and a shorter retry cannot help; otherwise a
 * shorter retry may succeed.
 */
export class TruncatedReplyError extends Error {
	readonly thinkingOnly: boolean;
	constructor(maxTokens: number, thinkingOnly: boolean) {
		super(
			thinkingOnly
				? `the model's thinking used the whole reply budget of ${maxTokens} tokens before it answered; raise Max reply tokens in Settings (or DAWNSKILL_LLM_MAX_TOKENS)`
				: `reply truncated at max_tokens ${maxTokens}`,
		);
		this.name = "TruncatedReplyError";
		this.thinkingOnly = thinkingOnly;
	}
}

export const DEFAULT_MODEL = "default";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;
const ERROR_BODY_CHARS = 300;
/** llama.cpp `exceed_context_size_error`, OpenAI `context_length_exceeded`, vLLM "maximum context length". */
const CONTEXT_ERROR = /exceed_context_size|context_length_exceeded|context (?:size|length|window)/i;
/** HTTP 400 bodies of gateway hiccups ("Upstream request failed", "overloaded"); the same request succeeds on retry. */
const TRANSIENT_ERROR = /unavailable now|temporarily unavailable|upstream request failed|overloaded|try again/i;
/** HTTP 400 refusing `json_schema` (OpenCode Go: "This response_format type is unavailable now", ~1 in 6 requests). */
const RESPONSE_FORMAT_ERROR = /response_format[^"]*(?:unavailable|not supported|unsupported)/i;
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
/** Waits before the 2nd and 3rd try of a transient failure; only failures before the body is read are retried. */
const RETRY_DELAYS_MS = [2_000, 6_000] as const;

/** Null when `DAWNSKILL_LLM_BASE_URL` is unset or blank: no model is configured by the environment. */
export function llmConfigFromEnv(env: Readonly<Record<string, string | undefined>>): LlmConfig | null {
	const baseUrl = env.DAWNSKILL_LLM_BASE_URL?.trim() ?? "";
	if (baseUrl === "") return null;
	const apiKey = env.DAWNSKILL_LLM_API_KEY?.trim() ?? "";
	const model = env.DAWNSKILL_LLM_MODEL?.trim() ?? "";
	return {
		baseUrl,
		apiKey: apiKey === "" ? null : apiKey,
		model: model === "" ? DEFAULT_MODEL : model,
		...llmLimitsFromEnv(env),
	};
}

/** Request limits from the environment; settings saved in the app use them only where they omit `maxTokens`/`timeoutMs`. */
export function llmLimitsFromEnv(env: Readonly<Record<string, string | undefined>>): LlmLimits {
	return {
		timeoutMs: positiveInteger(env, "DAWNSKILL_LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
		maxTokens: positiveInteger(env, "DAWNSKILL_LLM_MAX_TOKENS", DEFAULT_MAX_TOKENS),
	};
}

function positiveInteger(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
	const raw = env[name]?.trim() ?? "";
	if (raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} = ${JSON.stringify(raw)}; legal: positive integer`);
	}
	return value;
}

/**
 * Sends `x-opencode-session` with an ID fixed for this provider: OpenCode Go rejects requests without it
 * and uses it to route a conversation to one backend for prompt caching. Other servers ignore it.
 */
export function openAiCompatibleProvider(config: LlmConfig, options: ProviderOptions): ChatProvider {
	const fetchImpl = options.fetch ?? fetch;
	const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"user-agent": options.userAgent,
		"x-opencode-session": crypto.randomUUID(),
	};
	if (config.apiKey !== null) headers.authorization = `Bearer ${config.apiKey}`;
	const redact = (text: string): string =>
		config.apiKey === null ? text : text.replaceAll(config.apiKey, "[redacted]");

	const sleep = options.sleep ?? abortableSleep;

	return {
		model: config.model,
		async completeJson(request, signal, onDelta) {
			const maxTokens = Math.min(request.maxTokens ?? config.maxTokens, config.maxTokens);
			const bodyWith = (system: string, responseFormat: object): string =>
				JSON.stringify({
					model: config.model,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: request.user },
					],
					temperature: 0.2,
					max_tokens: maxTokens,
					stream: true,
					response_format: responseFormat,
				});
			let body = bodyWith(request.system, {
				type: "json_schema",
				json_schema: { name: request.schemaName, strict: true, schema: request.schema },
			});
			let fellBack = false;
			for (let attempt = 0; ; attempt++) {
				const timeout = AbortSignal.timeout(config.timeoutMs);
				const aborted = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
				try {
					let response: Response;
					try {
						response = await fetchImpl(url, { method: "POST", headers, body, signal: aborted });
					} catch (error) {
						// Network failure before any reply: transient, unless the caller aborted or our timeout fired.
						if (aborted.aborted || attempt >= RETRY_DELAYS_MS.length) throw error;
						await sleep(RETRY_DELAYS_MS[attempt] as number, signal);
						continue;
					}
					if (response.ok) {
						if (response.headers.get("content-type")?.includes("text/event-stream") === true) {
							return await streamedContent(response, aborted, maxTokens, redact, onDelta);
						}
						return messageContent(await response.json(), maxTokens);
					}
					const text = redact(await response.text()).slice(0, ERROR_BODY_CHARS);
					if (CONTEXT_ERROR.test(text)) throw new ContextSizeError(`HTTP ${response.status}: ${text}`);
					if (response.status === 400 && !fellBack && RESPONSE_FORMAT_ERROR.test(text)) {
						// json_schema refused: resend at once in JSON mode, the schema in the prompt. The caller
						// validates every reply against the schema anyway. Does not use a retry.
						fellBack = true;
						body = bodyWith(
							`${request.system}\n\nReply with one JSON object that matches this JSON Schema:\n${JSON.stringify(request.schema)}`,
							{ type: "json_object" },
						);
						attempt--;
						continue;
					}
					const transient =
						TRANSIENT_STATUS.has(response.status) || (response.status === 400 && TRANSIENT_ERROR.test(text));
					if (!transient || attempt >= RETRY_DELAYS_MS.length) {
						throw new Error(`LLM request failed: HTTP ${response.status}: ${text}`);
					}
					await sleep(RETRY_DELAYS_MS[attempt] as number, signal);
				} catch (error) {
					if (timeout.aborted && signal?.aborted !== true) {
						throw new Error(`LLM request timed out after ${config.timeoutMs} ms`, { cause: error });
					}
					throw error;
				}
			}
		},
	};
}

/** Resolves after `ms`; rejects at once with the abort reason when `signal` aborts first. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal?.aborted === true) {
		reject(signal.reason);
		return promise;
	}
	const onAbort = (): void => {
		clearTimeout(timer);
		reject(signal?.reason);
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

function messageContent(payload: unknown, maxTokens: number): string {
	if (!Value.Check(COMPLETION, payload)) throw new Error("LLM response has no choices[0].message");
	const choice = payload.choices[0];
	if (choice?.finish_reason === "length") {
		const content = choice.message?.content;
		throw new TruncatedReplyError(maxTokens, typeof content !== "string" || content === "");
	}
	const message = choice?.message;
	if (typeof message?.content === "string") return message.content;
	if (typeof message?.refusal === "string") {
		throw new Error(`LLM refused: ${message.refusal.slice(0, ERROR_BODY_CHARS)}`);
	}
	throw new Error("LLM response has no choices[0].message.content");
}

/**
 * Reads a server-sent-events reply: one `data: <chunk JSON>` line per chunk, `data: [DONE]` last.
 * Chunks of unknown shape are skipped. `signal` also cancels reading the body.
 */
async function streamedContent(
	response: Response,
	signal: AbortSignal,
	maxTokens: number,
	redact: (text: string) => string,
	onDelta: ((delta: ReplyDelta) => void) | undefined,
): Promise<string> {
	let content = "";
	let sawContent = false;
	let refusal = "";
	/** Handles one line; true once the stream says it is done. */
	const line = (raw: string): boolean => {
		const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!text.startsWith("data:")) return false; // blank, `:` comment, `event:`, `id:`, `retry:`
		const data = text.slice(text.startsWith("data: ") ? 6 : 5);
		if (data.trim() === "[DONE]") return true;
		let chunk: unknown;
		try {
			chunk = JSON.parse(data);
		} catch {
			return false;
		}
		if (!Value.Check(STREAM_CHUNK, chunk)) return false;
		if (chunk.error !== undefined) {
			const detail = redact(JSON.stringify(chunk.error));
			const message = redact(chunk.error.message ?? detail).slice(0, ERROR_BODY_CHARS);
			if (CONTEXT_ERROR.test(detail)) throw new ContextSizeError(`stream error: ${message}`);
			throw new Error(`LLM stream error: ${message}`);
		}
		const choice = chunk.choices?.[0];
		if (choice === undefined) return false;
		const delta = choice.delta;
		if (typeof delta?.content === "string") sawContent = true;
		const piece = delta?.content ?? "";
		const thought = delta?.reasoning_content || delta?.reasoning || "";
		content += piece;
		refusal += delta?.refusal ?? "";
		if (piece !== "" || thought !== "") onDelta?.({ reasoning: thought, content: piece });
		if (choice.finish_reason === "length") throw new TruncatedReplyError(maxTokens, content === "");
		return false;
	};

	signal.throwIfAborted();
	const reader = response.body?.getReader();
	if (reader !== undefined) {
		const cancel = () => void reader.cancel(signal.reason).catch(() => {});
		signal.addEventListener("abort", cancel, { once: true });
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (let done = false; !done; ) {
				const read = await reader.read();
				signal.throwIfAborted();
				buffer += read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
				const lines = buffer.split("\n");
				buffer = read.done ? "" : (lines.pop() ?? "");
				done = read.done || lines.some(line);
			}
		} finally {
			signal.removeEventListener("abort", cancel);
			void reader.cancel().catch(() => {});
		}
	}
	if (content !== "") return content;
	if (refusal !== "") throw new Error(`LLM refused: ${refusal.slice(0, ERROR_BODY_CHARS)}`);
	if (sawContent) return content;
	throw new Error("LLM response has no choices[0].message.content");
}

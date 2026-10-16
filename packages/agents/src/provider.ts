/** OpenAI-compatible chat-completions client (llama.cpp server, vLLM, Ollama, OpenAI, …) returning JSON text. */
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

export interface LlmConfig {
	/** API root including the version segment, e.g. `http://127.0.0.1:8080/v1`. */
	readonly baseUrl: string;
	readonly apiKey: string | null;
	readonly model: string;
	readonly timeoutMs: number;
	/** Upper bound on `max_tokens` for any request; size it to the model's context. */
	readonly maxTokens: number;
}

export interface JsonRequest {
	readonly system: string;
	readonly user: string;
	readonly schemaName: string;
	/** Plain JSON Schema object, strict-mode compatible. */
	readonly schema: object;
	/** Tokens the reply may need at most; the provider caps it at its configured budget. */
	readonly maxTokens: number;
}

export interface ChatProvider {
	readonly model: string;
	/** Raw JSON text of the assistant reply; parsing and validation are the caller's job. */
	completeJson(request: JsonRequest, signal?: AbortSignal): Promise<string>;
}

/** The server cannot fit the request into the model's context; retrying cannot help. */
export class ContextSizeError extends Error {
	constructor(detail: string) {
		super(`model context too small: ${detail}`);
		this.name = "ContextSizeError";
	}
}

/** The reply hit `max_tokens` before it ended (`finish_reason: "length"`); a shorter retry may succeed. */
export class TruncatedReplyError extends Error {
	constructor(maxTokens: number) {
		super(`reply truncated at max_tokens ${maxTokens}`);
		this.name = "TruncatedReplyError";
	}
}

const DEFAULT_MODEL = "default";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;
const ERROR_BODY_CHARS = 300;
/** llama.cpp `exceed_context_size_error`, OpenAI `context_length_exceeded`, vLLM "maximum context length". */
const CONTEXT_ERROR = /exceed_context_size|context_length_exceeded|context (?:size|length|window)/i;

/** Null when `DAWNSKILL_LLM_BASE_URL` is unset or blank: the planner is disabled. */
export function llmConfigFromEnv(env: Readonly<Record<string, string | undefined>>): LlmConfig | null {
	const baseUrl = env.DAWNSKILL_LLM_BASE_URL?.trim() ?? "";
	if (baseUrl === "") return null;
	const apiKey = env.DAWNSKILL_LLM_API_KEY?.trim() ?? "";
	const model = env.DAWNSKILL_LLM_MODEL?.trim() ?? "";
	return {
		baseUrl,
		apiKey: apiKey === "" ? null : apiKey,
		model: model === "" ? DEFAULT_MODEL : model,
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

export function openAiCompatibleProvider(config: LlmConfig, fetchImpl: typeof fetch = fetch): ChatProvider {
	const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (config.apiKey !== null) headers.authorization = `Bearer ${config.apiKey}`;
	const redact = (text: string): string =>
		config.apiKey === null ? text : text.replaceAll(config.apiKey, "[redacted]");

	return {
		model: config.model,
		async completeJson(request, signal) {
			const timeout = AbortSignal.timeout(config.timeoutMs);
			const maxTokens = Math.min(request.maxTokens, config.maxTokens);
			const body = JSON.stringify({
				model: config.model,
				messages: [
					{ role: "system", content: request.system },
					{ role: "user", content: request.user },
				],
				temperature: 0.2,
				max_tokens: maxTokens,
				response_format: {
					type: "json_schema",
					json_schema: { name: request.schemaName, strict: true, schema: request.schema },
				},
			});
			try {
				const response = await fetchImpl(url, {
					method: "POST",
					headers,
					body,
					signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
				});
				if (!response.ok) {
					const text = redact(await response.text()).slice(0, ERROR_BODY_CHARS);
					if (CONTEXT_ERROR.test(text)) throw new ContextSizeError(`HTTP ${response.status}: ${text}`);
					throw new Error(`LLM request failed: HTTP ${response.status}: ${text}`);
				}
				return messageContent(await response.json(), maxTokens);
			} catch (error) {
				if (timeout.aborted && signal?.aborted !== true) {
					throw new Error(`LLM request timed out after ${config.timeoutMs} ms`, { cause: error });
				}
				throw error;
			}
		},
	};
}

function messageContent(payload: unknown, maxTokens: number): string {
	if (!Value.Check(COMPLETION, payload)) throw new Error("LLM response has no choices[0].message");
	const choice = payload.choices[0];
	if (choice?.finish_reason === "length") throw new TruncatedReplyError(maxTokens);
	const message = choice?.message;
	if (typeof message?.content === "string") return message.content;
	if (typeof message?.refusal === "string") {
		throw new Error(`LLM refused: ${message.refusal.slice(0, ERROR_BODY_CHARS)}`);
	}
	throw new Error("LLM response has no choices[0].message.content");
}

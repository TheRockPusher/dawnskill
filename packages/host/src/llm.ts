// The planner's model connection. Settings saved from the web UI win over the DAWNSKILL_LLM_* environment.
// They live in their own file, not the event log, so the API key never reaches an export; the file is
// written with mode 0600 and holds the key in plain text.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type ChatProvider, DEFAULT_MODEL, type LlmConfig, type LlmLimits } from "@dawnskill/agents";
import Type from "typebox";
import { Compile } from "typebox/compile";
import type { LlmUpdate } from "./schemas.ts";

const SavedSchema = Type.Object(
	{ baseUrl: Type.String({ minLength: 1 }), apiKey: Type.Union([Type.String(), Type.Null()]), model: Type.String() },
	{ additionalProperties: false },
);
const savedSettings = Compile(SavedSchema);

interface Saved {
	readonly baseUrl: string;
	readonly apiKey: string | null;
	readonly model: string;
}

/** `GET /api/config` → `llm`. Never contains the API key. */
interface LlmStatus {
	readonly configured: boolean;
	/** `app`: saved in Settings; `env`: DAWNSKILL_LLM_* variables; null: no model. */
	readonly source: "app" | "env" | null;
	readonly model: string | null;
	/** Only for settings saved in the app; the environment's URL is not echoed. */
	readonly baseUrl: string | null;
	readonly hasApiKey: boolean;
}

export interface Llm {
	/** Provider for the next plan run; null when no model is configured. */
	provider(): ChatProvider | null;
	status(): LlmStatus;
	/** Persists and applies the settings; returns why they are illegal instead. In-flight runs keep their provider. */
	save(update: LlmUpdate): string | null;
	/** Deletes the saved settings; the environment's configuration, if any, applies again. */
	clear(): void;
}

interface LlmOptions {
	/** JSON file holding the settings saved in the app. */
	readonly file: string;
	readonly env: LlmConfig | null;
	/** Request limits for a model configured in the app. */
	readonly limits: LlmLimits;
	readonly connect: (config: LlmConfig) => ChatProvider;
}

export function createLlm({ file, env, limits, connect }: LlmOptions): Llm {
	let saved = readSaved(file);
	let current = build();

	function build(): { readonly config: LlmConfig; readonly provider: ChatProvider } | null {
		const config = saved === null ? env : { ...limits, ...saved };
		return config === null ? null : { config, provider: connect(config) };
	}

	return {
		provider: () => current?.provider ?? null,
		status: () => ({
			configured: current !== null,
			source: saved !== null ? "app" : env !== null ? "env" : null,
			model: current?.config.model ?? null,
			baseUrl: saved?.baseUrl ?? null,
			hasApiKey: current !== null && current.config.apiKey !== null,
		}),
		save(update) {
			const baseUrl = update.baseUrl.trim();
			if (!isHttpUrl(baseUrl)) return `baseUrl = ${JSON.stringify(baseUrl)}; legal: an http:// or https:// URL`;
			let apiKey: string | null;
			if (update.apiKey === undefined) {
				// A kept key is only ever sent to the URL it was entered for.
				if (saved !== null && saved.apiKey !== null && saved.baseUrl !== baseUrl) {
					return "apiKey: required when baseUrl changes; the saved key is only sent to the URL it was entered for";
				}
				apiKey = saved?.apiKey ?? null;
			} else {
				apiKey = update.apiKey?.trim() || null;
			}
			const next: Saved = { baseUrl, apiKey, model: update.model?.trim() || DEFAULT_MODEL };
			writeSaved(file, next);
			saved = next;
			current = build();
			return null;
		},
		clear() {
			rmSync(file, { force: true });
			saved = null;
			current = build();
		},
	};
}

function isHttpUrl(value: string): boolean {
	const url = URL.parse(value);
	return url !== null && (url.protocol === "http:" || url.protocol === "https:");
}

function readSaved(file: string): Saved | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		value = undefined;
	}
	if (!savedSettings.Check(value)) throw new Error(`${file}: invalid model settings; fix or delete the file`);
	return value;
}

/** Atomic replace, so a crash never leaves a half-written file that blocks the next start. */
function writeSaved(file: string, settings: Saved): void {
	const temp = `${file}.tmp`;
	rmSync(temp, { force: true });
	writeFileSync(temp, `${JSON.stringify(settings, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, file);
}

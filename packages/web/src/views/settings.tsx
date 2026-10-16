import { type Criterion, rocWeights, type View } from "@dawnskill/core";
import { useState } from "preact/hooks";
import { type LlmStatus, removeLlmSettings, saveLlmSettings, useApp } from "../api.ts";
import { ActionButton } from "../ui.tsx";
import "./journal.css";

const CRITERION_INFO: Readonly<Record<Criterion, { readonly label: string; readonly text: string }>> = {
	importance: { label: "Importance", text: "Your 1–5 rating; normalized (r − 1) / 4." },
	urgency: { label: "Urgency", text: "Your 1–5 rating; normalized (r − 1) / 4." },
	unblocks: {
		label: "Unblocks",
		text: "Open tasks transitively waiting on this one; min–max normalized across open tasks.",
	},
	effort: {
		label: "Effort",
		text: "Calibrated estimate in minutes; log-scaled and inverted min–max, so quicker tasks score higher.",
	},
	age: { label: "Age", text: "Whole days since creation; min–max normalized, so old tasks surface." },
};

function Criteria({ view }: { readonly view: View }) {
	const [rank, setRank] = useState<readonly Criterion[]>(view.criteriaRank);
	const weights = rocWeights(rank);
	const changed = rank.some((c, i) => view.criteriaRank[i] !== c);
	const move = (i: number, d: -1 | 1): void => {
		const next = rank.slice();
		const a = next[i];
		const b = next[i + d];
		if (a === undefined || b === undefined) return;
		next[i] = b;
		next[i + d] = a;
		setRank(next);
	};
	return (
		<section class="panel stack">
			<h2>Priority criteria</h2>
			<p class="muted">
				Tasks are scored 0–100 as Σ 100 × w<sub>i</sub> × normalized value. Rank the criteria; weights follow from rank
				alone via Rank-Order Centroid: w<sub>i</sub> = (1/n) Σ<sub>k=i</sub>
				<sup>n</sup> 1/k (Barron &amp; Barrett, 1996).
			</p>
			<ol class="criteria">
				{rank.map((c, i) => (
					<li key={c} class="row">
						<strong>{CRITERION_INFO[c].label}</strong>
						<span class="chip">{(weights[c] * 100).toFixed(1)}%</span>
						<span class="muted grow">{CRITERION_INFO[c].text}</span>
						<button
							type="button"
							class="secondary"
							aria-label={`Move ${CRITERION_INFO[c].label} up`}
							disabled={i === 0}
							onClick={() => move(i, -1)}
						>
							↑
						</button>
						<button
							type="button"
							class="secondary"
							aria-label={`Move ${CRITERION_INFO[c].label} down`}
							disabled={i === rank.length - 1}
							onClick={() => move(i, 1)}
						>
							↓
						</button>
					</li>
				))}
			</ol>
			<div class="row">
				<ActionButton kind="primary" event={{ type: "PreferencesSet", criteriaRank: rank }}>
					Save ranking
				</ActionButton>
				{changed ? (
					<button type="button" class="secondary" onClick={() => setRank(view.criteriaRank)}>
						Revert
					</button>
				) : null}
			</div>
		</section>
	);
}

const SOURCE_LABEL = { app: "saved in this app", env: "from the host's environment variables" } as const;

interface Preset {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	/** Filled into Model when the preset is chosen; any model the service lists works. */
	readonly model: string;
	readonly keyUrl: string;
	readonly note: string;
}

/** Hosted services whose chat-completions endpoint ran the planner end to end on 2026-10-16 (README). */
const PRESETS: readonly Preset[] = [
	{
		id: "opencode-go",
		label: "OpenCode Go",
		baseUrl: "https://opencode.ai/inference/go/openai/v1",
		model: "longcat-2.0",
		keyUrl: "https://opencode.ai/console",
		note: "Only models on Go's chat-completions endpoint work. Its models reason before answering: if runs time out or are cut off, raise DAWNSKILL_LLM_TIMEOUT_MS and DAWNSKILL_LLM_MAX_TOKENS on the host.",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		model: "anthropic/claude-haiku-5.5",
		keyUrl: "https://openrouter.ai/keys",
		note: "Reaches Claude, GPT and open models. Choose one that lists structured outputs among its supported parameters.",
	},
];
const CUSTOM = "custom";

function ModelSettings({ llm }: { readonly llm: LlmStatus }) {
	const savedKey = llm.source === "app" && llm.hasApiKey;
	const [preset, setPreset] = useState(() => PRESETS.find((p) => p.baseUrl === llm.baseUrl)?.id ?? CUSTOM);
	const chosen = PRESETS.find((p) => p.id === preset);
	const [baseUrl, setBaseUrl] = useState(llm.baseUrl ?? "");
	const [model, setModel] = useState(llm.source === "app" ? (llm.model ?? "") : "");
	const [apiKey, setApiKey] = useState("");
	const [removeKey, setRemoveKey] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const choose = (id: string): void => {
		setPreset(id);
		const next = PRESETS.find((p) => p.id === id);
		if (next === undefined) return;
		setBaseUrl(next.baseUrl);
		setModel(next.model);
	};
	const run = async (action: () => Promise<{ ok: true } | { ok: false; message: string }>): Promise<void> => {
		setBusy(true);
		setError(null);
		const result = await action();
		setBusy(false);
		if (!result.ok) setError(result.message);
	};
	const save = (): Promise<void> =>
		run(() =>
			saveLlmSettings({
				baseUrl: baseUrl.trim(),
				model: model.trim(),
				// Blank keeps the saved key; the host refuses that when the URL changed.
				...(removeKey ? { apiKey: null } : apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
			}),
		);
	const remove = (): void => {
		const message =
			"Remove the saved model settings and API key? Planning then uses DAWNSKILL_LLM_* on the host, if set.";
		if (window.confirm(message)) void run(removeLlmSettings);
	};

	return (
		<section class="panel stack">
			<h2>Model</h2>
			{llm.configured ? (
				<p>
					Planner model: <strong>{llm.model ?? "default"}</strong>
					{llm.source === null ? null : <span class="muted"> ({SOURCE_LABEL[llm.source]})</span>}
				</p>
			) : (
				<p class="error">No model configured — planning is unavailable; manual tasks still work.</p>
			)}
			<p class="muted">
				Choose a hosted service or enter the URL of any OpenAI-compatible server with structured outputs: llama.cpp,
				Ollama, vLLM or another provider. The API key is stored on the host and never shown again.
				{llm.source === "env" ? " Settings saved here take precedence over the environment variables." : null}
			</p>
			<form
				class="stack"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<label>
					Service
					<select value={preset} onChange={(e) => choose(e.currentTarget.value)}>
						{PRESETS.map((p) => (
							<option key={p.id} value={p.id}>
								{p.label}
							</option>
						))}
						<option value={CUSTOM}>Custom URL</option>
					</select>
				</label>
				{chosen === undefined ? (
					<label>
						Base URL (including the version segment)
						<input
							type="url"
							required
							value={baseUrl}
							placeholder="http://localhost:8080/v1"
							onInput={(e) => setBaseUrl(e.currentTarget.value)}
						/>
					</label>
				) : (
					<p class="muted">
						Base URL <code>{chosen.baseUrl}</code>. {chosen.note}
					</p>
				)}
				<label>
					Model
					<input
						type="text"
						value={model}
						placeholder={chosen?.model ?? "default"}
						onInput={(e) => setModel(e.currentTarget.value)}
					/>
				</label>
				<label>
					API key
					<input
						type="password"
						autocomplete="off"
						value={apiKey}
						disabled={removeKey}
						placeholder={
							savedKey
								? "Saved — leave blank to keep it"
								: chosen === undefined
									? "Optional for local servers"
									: "Required"
						}
						onInput={(e) => setApiKey(e.currentTarget.value)}
					/>
				</label>
				{chosen === undefined ? null : (
					<p class="muted">
						Get a key at{" "}
						<a href={chosen.keyUrl} target="_blank" rel="noreferrer">
							{chosen.keyUrl}
						</a>
						.
					</p>
				)}
				{savedKey ? (
					<label>
						<input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.currentTarget.checked)} />
						Remove the saved API key
					</label>
				) : null}
				<div class="row">
					<button type="submit" class="primary" disabled={busy || baseUrl.trim() === ""}>
						{busy ? "Saving…" : "Save model settings"}
					</button>
					{llm.source === "app" ? (
						<button type="button" class="danger" disabled={busy} onClick={remove}>
							Remove saved settings
						</button>
					) : null}
					{error ? <span class="error">{error}</span> : null}
				</div>
			</form>
			<details>
				<summary>Configure with environment variables instead</summary>
				<p>Set these before starting the host. They apply while no settings are saved here.</p>
				<pre>
					DAWNSKILL_LLM_BASE_URL=http://localhost:8080/v1{"\n"}DAWNSKILL_LLM_API_KEY=…{"\n"}DAWNSKILL_LLM_MODEL=…
				</pre>
			</details>
		</section>
	);
}

export function Settings({ view }: { readonly view: View }) {
	const { config } = useApp();
	const categories = Object.values(view.categories).sort((a, b) => a.category.localeCompare(b.category));
	return (
		<div class="stack">
			{config === null ? (
				<section class="panel stack">
					<h2>Model</h2>
					<p class="muted">Loading…</p>
				</section>
			) : (
				// Remount on every status change so the form shows what the host now holds.
				<ModelSettings key={JSON.stringify(config.llm)} llm={config.llm} />
			)}

			<Criteria key={view.criteriaRank.join()} view={view} />

			<section class="panel stack">
				<h2>Estimates</h2>
				<p class="muted">
					Reference-class forecasting: for each category, the median of actual ÷ estimated minutes over finished tasks
					with tracked time. Once a category has 3 samples, new estimates are multiplied by that median. MAD (median
					absolute deviation) shows how spread the ratios are.
				</p>
				{categories.length === 0 ? (
					<p class="muted">No categories yet.</p>
				) : (
					<table class="list">
						<thead>
							<tr>
								<th>Category</th>
								<th>Samples</th>
								<th>Median ratio</th>
								<th>MAD</th>
								<th>Applied</th>
							</tr>
						</thead>
						<tbody>
							{categories.map((c) => (
								<tr key={c.category}>
									<td>{c.category}</td>
									<td>{c.samples}</td>
									<td>{c.medianRatio === null ? "—" : `×${c.medianRatio.toFixed(2)}`}</td>
									<td>{c.mad === null ? "—" : c.mad.toFixed(2)}</td>
									<td>{c.applied ? "yes" : `no (${c.samples}/3)`}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>

			<section class="panel stack">
				<h2>Data</h2>
				<p>
					<a href="/api/export" download="dawnskill-events.json">
						Export everything
					</a>{" "}
					<span class="muted">(all events as JSON — the full, replayable history)</span>
				</p>
				<p class="muted">
					Version {config?.version ?? "…"} · {view.seq} events
				</p>
			</section>
		</div>
	);
}

import {
	ACTIVITY_GUIDE,
	LEVEL_NAMES,
	SKILL_KEY_PATTERN,
	type Level,
	type Proposal,
	type Resource,
	type SkillState,
	type SkillView,
	type View,
} from "@dawnskill/core";
import { useState } from "preact/hooks";
import { LEVEL_ANCHORS, LevelBadge, minutes, SkillLink, SkillStateBadge, TaskLink, taskById, when } from "../ui.tsx";
import { isActive, pick, StatusChip, useSend } from "./tasks.tsx";
import "./catalog.css";

const STATES = ["unassessed", "gap", "learning", "proposed", "assessed"] as const satisfies readonly SkillState[];
const LEVELS = [0, 1, 2, 3, 4, 5] as const satisfies readonly Level[];

const STATE_HELP: Readonly<Record<SkillState, string>> = {
	unassessed: "never rated and not needed above your level yet",
	gap: "an open task requires a higher level than yours",
	learning: "an open learning task is in progress for it",
	proposed: "a new level is waiting for your confirmation",
	assessed: "rated, and every open task's requirement is met",
};

/** Non-empty trimmed lines of a textarea. */
function lines(text: string): string[] {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
}

// ── Constellation ───────────────────────────────────────────────────────────

/** Approximate advance of one character of the 13px node name, for sizing without measuring. */
const CHAR_PX = 7.5;
const TEXT_PAD = 10;
const NODE_MIN_W = 160;
const NODE_MAX_W = 320;
const LINE_H = 16;
const COL_GAP = 64;
const ROW_GAP = 14;
const PAD = 12;

interface Placed {
	readonly sv: SkillView;
	readonly x: number;
	readonly y: number;
	/** Name wrapped onto at most two lines of `perLine` characters. */
	readonly lines: readonly string[];
}

/** Greedy word wrap into at most two lines; overflow on the second line ends in an ellipsis. */
function wrapName(name: string, perLine: number): readonly string[] {
	if (name.length <= perLine) return [name];
	const space = name.lastIndexOf(" ", perLine);
	const cut = space > 0 ? space : perLine;
	const rest = name.slice(cut).trim();
	return [name.slice(0, cut), rest.length > perLine ? `${rest.slice(0, perLine - 1)}…` : rest];
}

/** Layers left-to-right by longest prerequisite path; nodes within a layer ordered by name. */
function layout(skills: readonly SkillView[]): {
	readonly nodes: ReadonlyMap<string, Placed>;
	readonly nodeW: number;
	readonly nodeH: number;
	readonly width: number;
	readonly height: number;
} {
	const longest = Math.max(0, ...skills.map((s) => s.skill.name.length));
	const nodeW = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(longest * CHAR_PX) + TEXT_PAD * 2));
	const perLine = Math.floor((nodeW - TEXT_PAD * 2) / CHAR_PX);
	const wrapped = new Map(skills.map((s) => [s.skill.key, wrapName(s.skill.name, perLine)]));
	const nameLines = Math.max(1, ...[...wrapped.values()].map((l) => l.length));
	const nodeH = 14 + (nameLines + 1) * LINE_H;
	const byKey = new Map(skills.map((s) => [s.skill.key, s]));
	const depth = new Map<string, number>();
	const visit = (key: string, trail: ReadonlySet<string>): number => {
		const known = depth.get(key);
		if (known !== undefined) return known;
		const next = new Set(trail).add(key);
		const pres = (byKey.get(key)?.skill.prerequisites ?? []).filter((p) => byKey.has(p) && !trail.has(p));
		const d = pres.length === 0 ? 0 : 1 + Math.max(...pres.map((p) => visit(p, next)));
		depth.set(key, d);
		return d;
	};
	const layers: SkillView[][] = [];
	for (const s of skills) (layers[visit(s.skill.key, new Set())] ??= []).push(s);
	const nodes = new Map<string, Placed>();
	let rows = 0;
	layers.forEach((layer, col) => {
		layer.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
		rows = Math.max(rows, layer.length);
		layer.forEach((sv, row) => {
			nodes.set(sv.skill.key, {
				sv,
				x: PAD + col * (nodeW + COL_GAP),
				y: PAD + row * (nodeH + ROW_GAP),
				lines: wrapped.get(sv.skill.key) ?? [sv.skill.name],
			});
		});
	});
	return {
		nodes,
		nodeW,
		nodeH,
		width: PAD * 2 + layers.length * nodeW + Math.max(0, layers.length - 1) * COL_GAP,
		height: PAD * 2 + rows * nodeH + Math.max(0, rows - 1) * ROW_GAP,
	};
}

function Constellation({ view }: { readonly view: View }) {
	const { nodes, nodeW, nodeH, width, height } = layout(view.skills);
	const placed = [...nodes.values()];
	return (
		<div class="constellation">
			<svg
				width={width}
				height={height}
				viewBox={`0 0 ${width} ${height}`}
				role="group"
				aria-label="Skill constellation: prerequisites point to the skills that build on them"
			>
				<defs>
					<marker
						id="skill-arrow"
						viewBox="0 0 10 10"
						refX="10"
						refY="5"
						markerWidth="7"
						markerHeight="7"
						orient="auto"
					>
						<path d="M0 0L10 5L0 10z" />
					</marker>
				</defs>
				{placed.flatMap(({ sv, x, y }) =>
					sv.skill.prerequisites.flatMap((pre) => {
						const from = nodes.get(pre);
						if (from === undefined) return [];
						const x1 = from.x + nodeW;
						const y1 = from.y + nodeH / 2;
						const y2 = y + nodeH / 2;
						const mid = (x1 + x) / 2;
						return [
							<path
								key={`${pre}>${sv.skill.key}`}
								class="edge"
								d={`M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x} ${y2}`}
							/>,
						];
					}),
				)}
				{placed.map(({ sv, x, y, lines: nameLines }) => {
					const { skill } = sv;
					const level = skill.level === null ? "L? not assessed" : `L${skill.level} ${LEVEL_NAMES[skill.level]}`;
					return (
						<a
							key={skill.key}
							href={`#/skills/${encodeURIComponent(skill.key)}`}
							class={`node state-${sv.state}`}
							aria-label={`${skill.name}: ${level}, ${sv.state}`}
						>
							<title>{`${skill.name} — ${level} — ${STATE_HELP[sv.state]}`}</title>
							<rect x={x} y={y} width={nodeW} height={nodeH} rx={8} />
							<text x={x + TEXT_PAD} y={y + 7 + LINE_H - 4} class="node-name">
								{nameLines.map((line, i) => (
									<tspan key={i} x={x + TEXT_PAD} dy={i === 0 ? 0 : LINE_H}>
										{line}
									</tspan>
								))}
							</text>
							<text x={x + TEXT_PAD} y={y + 7 + (nameLines.length + 1) * LINE_H - 4} class="node-level">
								{level}
							</text>
						</a>
					);
				})}
			</svg>
		</div>
	);
}

// ── Skills list ─────────────────────────────────────────────────────────────

export function Skills({ view }: { readonly view: View }) {
	return (
		<div class="stack">
			<h1>Skills</h1>
			{view.skills.length === 0 ? (
				<p class="muted">
					No skills yet. Approving a <a href="#/plan">plan</a> adds the skills it needs, or create one below.
				</p>
			) : (
				<>
					<section class="panel stack">
						<h2>Constellation</h2>
						<p class="muted">
							Arrows run from a prerequisite to the skills that build on it; columns follow the longest prerequisite
							chain. Click a skill for details.
						</p>
						<Constellation view={view} />
						<ul class="legend">
							{STATES.map((s) => (
								<li key={s}>
									<SkillStateBadge state={s} /> <span class="muted">{STATE_HELP[s]}</span>
								</li>
							))}
						</ul>
					</section>
					<table class="list">
						<thead>
							<tr>
								<th>Skill</th>
								<th>Level</th>
								<th>State</th>
								<th title="Highest level required by an open task">Max required</th>
								<th title="Open or in-progress learning tasks">Learning</th>
								<th>Last assessed</th>
							</tr>
						</thead>
						<tbody>
							{view.skills.map((sv) => {
								const last = sv.history.at(-1);
								const openLearning = sv.learningTaskIds.filter((id) => {
									const t = taskById(view, id);
									return t !== undefined && isActive(t.task.status);
								}).length;
								return (
									<tr key={sv.skill.key}>
										<td>
											<SkillLink view={view} skillKey={sv.skill.key} />
										</td>
										<td>
											<LevelBadge level={sv.skill.level} />{" "}
											{sv.skill.level === null ? "not assessed" : LEVEL_NAMES[sv.skill.level]}
										</td>
										<td>
											<SkillStateBadge state={sv.state} />
										</td>
										<td>
											{sv.maxRequired === null ? <span class="muted">—</span> : <LevelBadge level={sv.maxRequired} />}
										</td>
										<td class="num">{openLearning}</td>
										<td>
											{last ? (
												<>
													{when(last.at)}{" "}
													<span class="muted">({last.source === "self" ? "self-rated" : "confirmed"})</span>
												</>
											) : (
												<span class="muted">never</span>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</>
			)}
			<details class="panel">
				<summary>New skill</summary>
				<NewSkillForm view={view} />
			</details>
		</div>
	);
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 64)
		.replace(/-+$/, "");
}

/** `Title | https://…` or a bare URL per line. */
function parseResources(text: string): { readonly resources: Resource[]; readonly bad: string[] } {
	const resources: Resource[] = [];
	const bad: string[] = [];
	for (const line of lines(text)) {
		const bar = line.lastIndexOf("|");
		const title = bar === -1 ? "" : line.slice(0, bar).trim();
		const url = (bar === -1 ? line : line.slice(bar + 1)).trim();
		if (/^https?:\/\/\S+$/i.test(url)) resources.push({ title: title || url, url });
		else bad.push(line);
	}
	return { resources, bad };
}

function NewSkillForm({ view }: { readonly view: View }) {
	const [name, setName] = useState("");
	const [keyInput, setKeyInput] = useState<string | null>(null);
	const [description, setDescription] = useState("");
	const [concepts, setConcepts] = useState("");
	const [prerequisites, setPrerequisites] = useState<readonly string[]>([]);
	const [prompts, setPrompts] = useState("");
	const [practice, setPractice] = useState("60");
	const [resourceText, setResourceText] = useState("");
	const [created, setCreated] = useState(false);
	const { busy, error, setError, send } = useSend();
	const key = keyInput ?? slugify(name);

	const submit = async () => {
		const practiceMinutes = Number(practice);
		const { resources, bad } = parseResources(resourceText);
		const problems = [
			SKILL_KEY_PATTERN.test(key) ? null : "Key must be lowercase kebab-case, e.g. rust-ownership.",
			lines(concepts).length > 0 ? null : "List at least one concept.",
			lines(prompts).length > 0 ? null : "Write at least one retrieval prompt.",
			Number.isInteger(practiceMinutes) && practiceMinutes >= 5 && practiceMinutes <= 2400
				? null
				: "Practice minutes must be a whole number from 5 to 2400.",
			bad.length === 0 ? null : `Resource lines need an http(s) URL: ${bad.join("; ")}`,
		].filter((p) => p !== null);
		if (problems.length > 0) {
			setError(problems.join(" "));
			return;
		}
		const ok = await send({
			type: "SkillCreated",
			skill: {
				key,
				name: name.trim(),
				description: description.trim(),
				concepts: lines(concepts),
				prerequisites,
				resources,
				retrievalPrompts: lines(prompts),
				practiceMinutes,
			},
		});
		setCreated(ok);
		if (ok) {
			setName("");
			setKeyInput(null);
			setDescription("");
			setConcepts("");
			setPrerequisites([]);
			setPrompts("");
			setPractice("60");
			setResourceText("");
		}
	};

	return (
		<form
			class="stack"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
			onInput={() => setCreated(false)}
		>
			<div class="grid">
				<label>
					Name
					<input required maxLength={120} value={name} onInput={(e) => setName(e.currentTarget.value)} />
				</label>
				<label>
					Key <span class="muted">(stable id; learning accumulates under it)</span>
					<input
						required
						maxLength={64}
						pattern={SKILL_KEY_PATTERN.source}
						value={key}
						onInput={(e) => setKeyInput(e.currentTarget.value)}
					/>
				</label>
			</div>
			<label>
				Description
				<textarea
					rows={2}
					maxLength={2000}
					value={description}
					onInput={(e) => setDescription(e.currentTarget.value)}
				/>
			</label>
			<label>
				Concepts <span class="muted">(what you need to know; one per line, up to 12)</span>
				<textarea rows={4} required value={concepts} onInput={(e) => setConcepts(e.currentTarget.value)} />
			</label>
			<label>
				Retrieval prompts <span class="muted">(questions answered from memory at review; one per line, up to 8)</span>
				<textarea rows={3} required value={prompts} onInput={(e) => setPrompts(e.currentTarget.value)} />
			</label>
			<div class="grid">
				<label>
					Prerequisites <span class="muted">(Ctrl/⌘-click for several)</span>
					<select
						multiple
						size={Math.min(6, Math.max(2, view.skills.length))}
						onChange={(e) => setPrerequisites(Array.from(e.currentTarget.selectedOptions, (o) => o.value))}
					>
						{view.skills.map((s) => (
							<option key={s.skill.key} value={s.skill.key} selected={prerequisites.includes(s.skill.key)}>
								{s.skill.name}
							</option>
						))}
					</select>
				</label>
				<label>
					Practice minutes per level step
					<input
						type="number"
						required
						min={5}
						max={2400}
						step={1}
						value={practice}
						onInput={(e) => setPractice(e.currentTarget.value)}
					/>
				</label>
			</div>
			<label>
				Resources <span class="muted">(optional; one per line: Title | https://…)</span>
				<textarea rows={2} value={resourceText} onInput={(e) => setResourceText(e.currentTarget.value)} />
			</label>
			<div class="row">
				<button type="submit" class="primary" disabled={busy}>
					Create skill
				</button>
				{error ? <span class="error">{error}</span> : null}
				{created ? <span class="muted">Created.</span> : null}
			</div>
		</form>
	);
}

// ── Skill detail ────────────────────────────────────────────────────────────

export function SkillDetail({ view, skillKey }: { readonly view: View; readonly skillKey: string }) {
	const sv = view.skills.find((s) => s.skill.key === skillKey);
	if (sv === undefined) {
		return (
			<div class="stack">
				<p>
					<a href="#/skills">← Skills</a>
				</p>
				<p class="error">No skill with key {skillKey}.</p>
			</div>
		);
	}
	const { skill } = sv;
	const review = view.reviews.find((r) => r.skill === skill.key);
	const proposal =
		sv.pendingProposalId === null ? undefined : view.proposals.find((p) => p.id === sv.pendingProposalId);
	const learningTasks = sv.learningTaskIds
		.map((id) => taskById(view, id))
		.filter((t) => t !== undefined)
		.sort((a, b) => (a.task.learning?.targetLevel ?? 0) - (b.task.learning?.targetLevel ?? 0));
	return (
		<div class="stack">
			<p>
				<a href="#/skills">← Skills</a>
			</p>
			<section class="panel stack">
				<div class="row">
					<LevelBadge level={skill.level} />
					<SkillStateBadge state={sv.state} />
					<span class="muted">{skill.key}</span>
				</div>
				<h1 class="title">{skill.name}</h1>
				<p>
					<strong>{skill.level === null ? "Not assessed" : `L${skill.level} ${LEVEL_NAMES[skill.level]}`}</strong>
					{skill.level === null ? (
						<span class="muted"> — rate yourself below so gaps are computed from a real level.</span>
					) : (
						<>: “{LEVEL_ANCHORS[skill.level]}”</>
					)}
				</p>
				<p class="muted">
					State: {STATE_HELP[sv.state]}
					{sv.maxRequired !== null
						? `; open tasks require up to L${sv.maxRequired} ${LEVEL_NAMES[sv.maxRequired]}`
						: ""}
					.
				</p>
				{skill.description ? <p class="pre">{skill.description}</p> : null}
				<p class="muted">
					About {minutes(skill.practiceMinutes)} of focused practice per level step (refined by your "learning" history)
					· added {when(skill.createdAt)}
				</p>
			</section>

			{proposal && proposal.payload.kind === "level" ? (
				<ProposalPanel key={proposal.id} view={view} proposal={proposal} />
			) : null}

			<section class="panel">
				<h2>What you need to know</h2>
				<ul>
					{skill.concepts.map((c) => (
						<li key={c}>{c}</li>
					))}
				</ul>
			</section>

			<section class="panel grid">
				<div>
					<h2>Prerequisites</h2>
					<SkillList view={view} keys={skill.prerequisites} empty="None." />
				</div>
				<div>
					<h2>Builds toward</h2>
					<SkillList view={view} keys={sv.dependents} empty="No skill lists this one as a prerequisite." />
				</div>
			</section>

			<section class="panel">
				<h2>Required by</h2>
				{sv.requiredBy.length === 0 ? (
					<p class="muted">No open task requires this skill.</p>
				) : (
					<table class="list">
						<thead>
							<tr>
								<th>Task</th>
								<th>Required</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>
							{sv.requiredBy.map((r) => (
								<tr key={r.taskId}>
									<td>
										<TaskLink view={view} id={r.taskId} />
									</td>
									<td>
										<LevelBadge level={r.level} /> {LEVEL_NAMES[r.level]}
									</td>
									<td>
										{skill.level !== null && skill.level >= r.level ? (
											<span class="ready">met</span>
										) : (
											<span class="blocked">gap</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>

			<section class="panel">
				<h2>Learning tasks</h2>
				{learningTasks.length === 0 ? (
					<p class="muted">None yet. Gaps on a task can be turned into learning steps from the task page.</p>
				) : (
					<table class="list">
						<thead>
							<tr>
								<th>Task</th>
								<th>Status</th>
								<th>Target</th>
								<th>Activity</th>
							</tr>
						</thead>
						<tbody>
							{learningTasks.map(({ task }) => (
								<tr key={task.id}>
									<td>
										<TaskLink view={view} id={task.id} />
									</td>
									<td>
										<StatusChip status={task.status} />
									</td>
									<td>{task.learning ? <LevelBadge level={task.learning.targetLevel} /> : null}</td>
									<td>{task.learning ? ACTIVITY_GUIDE[task.learning.activity].label : null}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>

			{review ? (
				<section class="panel">
					<h2>Spaced review</h2>
					<p>
						{review.due ? <strong>Due now</strong> : <>Next review {when(review.dueAt)}</>} · interval{" "}
						{review.intervalDays} {review.intervalDays === 1 ? "day" : "days"} · streak {review.streak}
						{review.lastReviewAt ? ` · last reviewed ${when(review.lastReviewAt)}` : " · not reviewed since learning"}
					</p>
					<p class="muted">
						Record reviews on <a href="#/learning">Learning</a>.
					</p>
				</section>
			) : null}

			<section class="panel">
				<h2>Assessment history</h2>
				{sv.history.length === 0 ? (
					<p class="muted">No assessments yet.</p>
				) : (
					<ol class="timeline">
						{sv.history.map((a) => (
							<li key={`${a.at}-${a.level}-${a.source}`}>
								<div class="row">
									<LevelBadge level={a.level} />
									<strong>{LEVEL_NAMES[a.level]}</strong>
									<span class="chip">{a.source === "self" ? "self-rated" : "confirmed"}</span>
									<span class="muted">{when(a.at)}</span>
								</div>
								{a.evidence ? <p class="pre">{a.evidence}</p> : null}
							</li>
						))}
					</ol>
				)}
			</section>

			<details class="panel" open={skill.level === null}>
				<summary>Rate yourself</summary>
				<SelfRateForm key={sv.history.length} sv={sv} />
			</details>

			{skill.retrievalPrompts.length > 0 ? (
				<section class="panel">
					<h2>Retrieval prompts</h2>
					<p class="muted">Answer from memory before checking notes.</p>
					<ol>
						{skill.retrievalPrompts.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ol>
				</section>
			) : null}

			{skill.resources.length > 0 ? (
				<section class="panel">
					<h2>Resources</h2>
					<ul>
						{skill.resources.map((r) => (
							<li key={r.url}>
								<a href={r.url} target="_blank" rel="noreferrer">
									{r.title}
								</a>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}

function SkillList({
	view,
	keys,
	empty,
}: {
	readonly view: View;
	readonly keys: readonly string[];
	readonly empty: string;
}) {
	if (keys.length === 0) return <p class="muted">{empty}</p>;
	return (
		<ul>
			{keys.map((k) => {
				const s = view.skills.find((v) => v.skill.key === k);
				return (
					<li key={k}>
						<SkillLink view={view} skillKey={k} /> {s ? <LevelBadge level={s.skill.level} /> : null}{" "}
						{s ? <SkillStateBadge state={s.state} /> : null}
					</li>
				);
			})}
		</ul>
	);
}

function ProposalPanel({ view, proposal }: { readonly view: View; readonly proposal: Proposal }) {
	const payload = proposal.payload;
	const [evidence, setEvidence] = useState(payload.kind === "level" ? payload.evidence : "");
	const [reason, setReason] = useState("");
	const { busy, error, send } = useSend();
	if (payload.kind !== "level") return null;
	return (
		<section class="panel stack proposal">
			<h2>
				Proposed level: <LevelBadge level={payload.level} /> {LEVEL_NAMES[payload.level]}
			</h2>
			<p>“{LEVEL_ANCHORS[payload.level]}”</p>
			<p class="muted">
				Proposed by {proposal.actor} {when(proposal.createdAt)}
				{payload.fromTaskId ? (
					<>
						{" "}
						after completing <TaskLink view={view} id={payload.fromTaskId} />
					</>
				) : null}
				. Your level changes only if you confirm.
			</p>
			<label>
				Evidence <span class="muted">(edit to say what convinces you)</span>
				<textarea rows={3} value={evidence} onInput={(e) => setEvidence(e.currentTarget.value)} />
			</label>
			<div class="row">
				<button
					type="button"
					class="primary"
					disabled={busy}
					onClick={() => void send({ type: "LevelConfirmed", proposalId: proposal.id, evidence: evidence.trim() })}
				>
					Confirm L{payload.level}
				</button>
				<label>
					Reason to reject
					<input value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
				</label>
				<button
					type="button"
					class="danger"
					disabled={busy}
					onClick={() => void send({ type: "ProposalRejected", proposalId: proposal.id, reason: reason.trim() })}
				>
					Reject
				</button>
			</div>
			{error ? <p class="error">{error}</p> : null}
		</section>
	);
}

function SelfRateForm({ sv }: { readonly sv: SkillView }) {
	const { skill } = sv;
	const [level, setLevel] = useState<Level | null>(skill.level);
	const [evidence, setEvidence] = useState("");
	const { busy, error, setError, send } = useSend();
	return (
		<form
			class="stack"
			onSubmit={(e) => {
				e.preventDefault();
				if (level === null) {
					setError("Choose the level that describes you.");
					return;
				}
				void send({ type: "SkillSelfRated", skill: skill.key, level, evidence: evidence.trim() });
			}}
		>
			<fieldset class="stack levels">
				<legend>Which statement fits you best for {skill.name}?</legend>
				{LEVELS.map((l) => (
					<label key={l} class="radio">
						<input
							type="radio"
							name={`self-rate-${skill.key}`}
							value={String(l)}
							checked={level === l}
							onChange={(e) => setLevel(pick(LEVELS, e.currentTarget.value, l))}
						/>
						<LevelBadge level={l} /> <strong>{LEVEL_NAMES[l]}</strong>
						<span class="muted">{LEVEL_ANCHORS[l]}</span>
					</label>
				))}
			</fieldset>
			<label>
				Evidence <span class="muted">(what you have done that shows it)</span>
				<textarea rows={3} value={evidence} onInput={(e) => setEvidence(e.currentTarget.value)} />
			</label>
			{sv.pendingProposalId !== null ? <p class="muted">Self-rating replaces the pending level proposal.</p> : null}
			<div class="row">
				<button type="submit" class="primary" disabled={busy || level === null}>
					Save rating
				</button>
				{error ? <span class="error">{error}</span> : null}
			</div>
		</form>
	);
}

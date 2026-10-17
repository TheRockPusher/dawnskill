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
import type { Ref } from "preact";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
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

/** Sky size in viewBox units; the SVG scales to the panel width. */
const SKY_W = 960;
const SKY_PAD_X = 80;
const SKY_PAD_Y = 64;
const ROW_H = 92;
const MIN_COL_W = 150;
/** Approximate advance of one character of the 12px star label, for wrapping without measuring. */
const LABEL_PX = 6.6;
const LABEL_LINE = 14;
/** Star card width (19rem at the 15px root size) and the narrowest it may shrink to beside a star. */
const CARD_PX = 285;
const CARD_MIN_PX = 200;
/** Rendered px the star's tether row keeps from the card's top and bottom edges (the 1.6rem default offset). */
const CARD_TETHER_PX = 24;

interface Star {
	readonly sv: SkillView;
	readonly x: number;
	readonly y: number;
	/** Core radius: brighter (larger) stars for higher levels. */
	readonly r: number;
	/** Name wrapped onto at most two lines. */
	readonly label: readonly string[];
}

interface Sky {
	readonly stars: ReadonlyMap<string, Star>;
	readonly width: number;
	readonly height: number;
}

/** FNV-1a hash of `text` mapped to [0, 1): a star keeps its place for as long as its key exists. */
function unit(text: string, salt: number): number {
	let h = 2166136261 ^ salt;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return (h >>> 0) / 2 ** 32;
}

/** Small seeded PRNG (mulberry32) for the background star field. */
function random(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
}

/**
 * Prerequisites to the left, the skills built on them to the right: one band per longest prerequisite chain
 * depth, then one band of lone stars (no prerequisite, nothing built on them) so no line crosses them. Bands
 * holding many skills split into staggered columns. Within a band, skills sit near the mean height of their
 * prerequisites (fewer crossing lines), and a stable per-key offset breaks the grid.
 */
function chart(skills: readonly SkillView[]): Sky {
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
	const bands: SkillView[][] = [];
	const lone: SkillView[] = [];
	for (const s of skills) {
		const linked = [...s.skill.prerequisites, ...s.dependents].some((k) => k !== s.skill.key && byKey.has(k));
		if (linked) (bands[visit(s.skill.key, new Set())] ??= []).push(s);
		else lone.push(s);
	}
	if (lone.length > 0) bands.push(lone);
	const perColumn = Math.max(3, Math.min(6, Math.ceil(skills.length / Math.max(bands.length, 3))));
	const columns = bands.reduce((n, band) => n + Math.ceil(band.length / perColumn), 0);
	const rows = Math.min(perColumn, Math.max(0, ...bands.map((b) => b.length)));
	const width = Math.max(SKY_W, SKY_PAD_X * 2 + (columns - 1) * MIN_COL_W);
	const height = Math.max(260, SKY_PAD_Y * 2 + (rows - 1) * ROW_H + (columns > 1 ? ROW_H / 2 : 0));
	const colW = columns > 1 ? (width - SKY_PAD_X * 2) / (columns - 1) : 0;
	const perLine = Math.max(10, Math.floor((Math.min(colW || width, 240) - 20) / LABEL_PX));
	const stars = new Map<string, Star>();
	let col = 0;
	for (const band of bands) {
		const anchor = (sv: SkillView): number => {
			const ys = sv.skill.prerequisites.flatMap((p) => {
				const star = stars.get(p);
				return star === undefined ? [] : [star.y];
			});
			return ys.length === 0 ? height / 2 : ys.reduce((a, b) => a + b, 0) / ys.length;
		};
		band.sort((a, b) => anchor(a) - anchor(b) || a.skill.name.localeCompare(b.skill.name));
		for (let start = 0; start < band.length; start += perColumn, col++) {
			const chunk = band.slice(start, start + perColumn);
			const stagger = col % 2 === 1 ? ROW_H / 2 : 0;
			const top = (height - (chunk.length - 1) * ROW_H) / 2 + (chunk.length < rows ? 0 : stagger - ROW_H / 4);
			chunk.forEach((sv, row) => {
				const { key, level, name } = sv.skill;
				const space = name.lastIndexOf(" ", perLine);
				const cut = name.length <= perLine ? name.length : space > 0 ? space : perLine;
				const rest = name.slice(cut).trim();
				const label = [name.slice(0, cut), rest.length > perLine ? `${rest.slice(0, perLine - 1).trimEnd()}…` : rest];
				const x = columns > 1 ? SKY_PAD_X + col * colW : width / 2;
				const jitterX = (unit(key, 1) - 0.5) * Math.min(colW * 0.25, 32);
				const jitterY = (unit(key, 2) - 0.5) * ROW_H * 0.36;
				stars.set(key, {
					sv,
					x: x + jitterX,
					y: top + row * ROW_H + jitterY,
					r: level === null ? 3.4 : 3 + level * 0.9,
					label: label.filter((line) => line !== ""),
				});
			});
		}
	}
	return { stars, width, height };
}

/** Faint background stars, fixed per sky size. */
function starField(
	width: number,
	height: number,
): readonly { x: number; y: number; r: number; o: number; t: number }[] {
	const next = random(width * 31 + height);
	return Array.from({ length: Math.round((width * height) / 1700) }, () => ({
		x: next() * width,
		y: next() * height,
		r: 0.3 + next() ** 3 * 1.1,
		o: 0.15 + next() * 0.55,
		t: Math.floor(next() * 6),
	}));
}

function Constellation({ view }: { readonly view: View }) {
	const { stars, width, height } = useMemo(() => chart(view.skills), [view.skills]);
	const field = useMemo(() => starField(width, height), [width, height]);
	const [selected, setSelected] = useState<string | null>(null);
	const starEls = useRef(new Map<string, SVGGElement>());
	const frame = useRef<HTMLDivElement>(null);
	const card = useRef<HTMLElement>(null);
	/** Measured card top (px) for the selected star; null until measured or on narrow screens (card below the sky). */
	const [placed, setPlaced] = useState<{ readonly key: string; readonly top: number } | null>(null);
	const active = selected === null ? undefined : stars.get(selected);
	const related = new Set(
		active ? [active.sv.skill.key, ...active.sv.skill.prerequisites, ...active.sv.dependents] : [],
	);
	// The card opens beside the star, clear of its label, on the side with more room (in rendered px);
	// a tether line leads back to the star. A star is only selectable after mount, so the frame is measured.
	const frameW = frame.current?.clientWidth ?? width;
	const scale = frameW / width;
	const reach = active ? (Math.max(...active.label.map((l) => l.length)) * LABEL_PX) / 2 + 14 : 0;
	const rightRoom = active ? frameW - (active.x + reach) * scale : 0;
	const leftRoom = active ? (active.x - reach) * scale : 0;
	const flipX = rightRoom < CARD_PX && leftRoom > rightRoom;
	const cardX = active ? active.x + (flipX ? -reach : reach) : 0;
	const select = (key: string) => {
		setSelected(key);
		starEls.current.get(key)?.focus();
	};
	const close = () => {
		if (selected !== null) starEls.current.get(selected)?.focus();
		setSelected(null);
	};
	const flipY = active !== undefined && active.y > height * 0.55;
	// The card keeps inside the sky (at most its height, then it scrolls); clamping keeps the tether row in the card.
	useLayoutEffect(() => {
		const el = card.current;
		const box = frame.current;
		if (active === undefined || el === null || box === null || getComputedStyle(el).position !== "absolute") {
			if (placed !== null) setPlaced(null);
			return;
		}
		const s = box.clientWidth / width;
		const h = el.offsetHeight;
		const anchor = active.y * s;
		const preferred = flipY ? anchor + CARD_TETHER_PX - h : anchor - CARD_TETHER_PX;
		const top = Math.round(Math.max(0, Math.min(height * s - h, preferred)));
		const key = active.sv.skill.key;
		if (placed?.key !== key || placed.top !== top) setPlaced({ key, top });
	});
	const edges = [...stars.values()].flatMap((to) =>
		to.sv.skill.prerequisites.flatMap((pre) => {
			const from = stars.get(pre);
			if (from === undefined) return [];
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			const len = Math.hypot(dx, dy) || 1;
			const a = from.r + 7;
			const b = to.r + 7;
			const lit = active !== undefined && (pre === active.sv.skill.key || to.sv.skill.key === active.sv.skill.key);
			return [
				<line
					key={`${pre}>${to.sv.skill.key}`}
					class={lit ? "edge lit" : "edge"}
					x1={from.x + (dx * a) / len}
					y1={from.y + (dy * a) / len}
					x2={to.x - (dx * b) / len}
					y2={to.y - (dy * b) / len}
				/>,
			];
		}),
	);
	return (
		<div
			ref={frame}
			class={active ? "sky-frame has-selection" : "sky-frame"}
			style={{ "--sky-h": `${Math.round(height * scale)}px` }}
			onKeyDown={(e) => {
				if (e.key === "Escape" && selected !== null) {
					e.preventDefault();
					close();
				}
			}}
		>
			<div class="sky">
				<svg
					viewBox={`0 0 ${width} ${height}`}
					style={{ "--sky-min-width": `${Math.round(width * 0.72)}px` }}
					role="group"
					aria-label="Skill constellation: lines join each prerequisite to the skills that build on it"
					onClick={() => setSelected(null)}
				>
					<defs>
						{STATES.map((s) => (
							<radialGradient key={s} id={`sky-glow-${s}`} class={`state-${s}`}>
								<stop offset="0" class="glow-in" />
								<stop offset="1" class="glow-out" />
							</radialGradient>
						))}
					</defs>
					<g aria-hidden="true">
						{field.map((s, i) => (
							<circle key={i} class={`dust t${s.t}`} cx={s.x} cy={s.y} r={s.r} opacity={s.o} />
						))}
					</g>
					<g aria-hidden="true">{edges}</g>
					{active ? (
						<line
							class="tether"
							x1={active.x + (flipX ? -1 : 1) * (active.r + 6)}
							y1={active.y}
							x2={cardX}
							y2={active.y}
							aria-hidden="true"
						/>
					) : null}
					{[...stars.values()].map(({ sv, x, y, r, label }) => {
						const { skill } = sv;
						const isSelected = selected === skill.key;
						const classes = [
							"star",
							`state-${sv.state}`,
							skill.level === null ? "unrated" : "",
							isSelected ? "selected" : "",
							active && !related.has(skill.key) ? "dim" : "",
						];
						return (
							<g
								key={skill.key}
								ref={(el) => {
									if (el) starEls.current.set(skill.key, el);
									else starEls.current.delete(skill.key);
								}}
								class={classes.filter(Boolean).join(" ")}
								role="button"
								// SVG attributes are case-sensitive and Preact sets them verbatim: `tabIndex` would not focus.
								tabindex={0}
								aria-label={`${skill.name}: ${skill.level === null ? "L? not assessed" : `L${skill.level} ${LEVEL_NAMES[skill.level]}`}, ${STATE_HELP[sv.state]}`}
								aria-expanded={isSelected}
								aria-controls={isSelected ? "star-card" : undefined}
								onClick={(e) => {
									e.stopPropagation();
									setSelected(isSelected ? null : skill.key);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										setSelected(isSelected ? null : skill.key);
									}
								}}
							>
								<circle class="hit" cx={x} cy={y} r={Math.max(18, r * 3)} />
								<circle class="glow" cx={x} cy={y} r={r * 3.6} fill={`url(#sky-glow-${sv.state})`} />
								{(skill.level ?? 0) >= 3 ? (
									<path class="spikes" d={`M${x - r * 2.8} ${y}H${x + r * 2.8}M${x} ${y - r * 2.8}V${y + r * 2.8}`} />
								) : null}
								<circle class="core" cx={x} cy={y} r={r} />
								{isSelected ? <circle class="ring" cx={x} cy={y} r={r + 7} /> : null}
								<text class="label" x={x} y={y + r + 17} text-anchor="middle">
									{label.map((line, i) => (
										<tspan key={i} x={x} dy={i === 0 ? 0 : LABEL_LINE}>
											{line}
										</tspan>
									))}
								</text>
								<text class="magnitude" x={x} y={y + r + 17 + label.length * LABEL_LINE} text-anchor="middle">
									{skill.level === null ? "L?" : `L${skill.level}`}
								</text>
							</g>
						);
					})}
				</svg>
			</div>
			{active ? (
				<StarCard
					cardRef={card}
					view={view}
					star={active}
					left={(cardX / width) * 100}
					top={placed?.key === active.sv.skill.key ? `${placed.top}px` : `${(active.y / height) * 100}%`}
					placed={placed?.key === active.sv.skill.key}
					room={Math.max(CARD_MIN_PX, (flipX ? leftRoom : rightRoom) - 8)}
					flipX={flipX}
					flipY={flipY}
					onSelect={select}
					onClose={close}
				/>
			) : null}
		</div>
	);
}

/** The information card that opens next to a clicked star. */
function StarCard({
	cardRef,
	view,
	star,
	left,
	top,
	placed,
	room,
	flipX,
	flipY,
	onSelect,
	onClose,
}: {
	readonly cardRef: Ref<HTMLElement>;
	readonly view: View;
	readonly star: Star;
	readonly left: number;
	/** CSS top: the measured px once placed, else the star's height in %. */
	readonly top: string;
	/** `top` is the card's own top edge, so no vertical offset applies. */
	readonly placed: boolean;
	/** Rendered px between the card's anchor and the frame edge it opens towards. */
	readonly room: number;
	readonly flipX: boolean;
	readonly flipY: boolean;
	readonly onSelect: (key: string) => void;
	readonly onClose: () => void;
}) {
	const { sv } = star;
	const { skill } = sv;
	const openLearning = sv.learningTaskIds.filter((id) => {
		const t = taskById(view, id);
		return t !== undefined && isActive(t.task.status);
	}).length;
	const neighbours = (keys: readonly string[], none: string) => {
		const known = keys.flatMap((k) => {
			const other = view.skills.find((s) => s.skill.key === k);
			return other === undefined ? [] : [other];
		});
		return known.length === 0 ? (
			<span class="muted">{none}</span>
		) : (
			<span class="star-links">
				{known.map((o) => (
					<button
						key={o.skill.key}
						type="button"
						class={`star-link state-${o.state}`}
						onClick={() => onSelect(o.skill.key)}
					>
						{o.skill.name}
					</button>
				))}
			</span>
		);
	};
	return (
		<section
			ref={cardRef}
			id="star-card"
			class={`star-card${flipX ? " flip-x" : ""}${flipY && !placed ? " flip-y" : ""}${placed ? " placed" : ""}`}
			style={{ left: `${left}%`, top, "--card-room": `${Math.round(room)}px` }}
			aria-label={`${skill.name} details`}
		>
			<header>
				<span class={`star-card-glyph state-${sv.state}`} aria-hidden="true">
					✦
				</span>
				<h3>{skill.name}</h3>
				<button type="button" class="star-card-close" aria-label="Close details" onClick={onClose}>
					×
				</button>
			</header>
			<div class="row">
				<LevelBadge level={skill.level} />
				{sv.state === "unassessed" ? null : (
					<span>{skill.level === null ? "not assessed" : LEVEL_NAMES[skill.level]}</span>
				)}
				<SkillStateBadge state={sv.state} />
			</div>
			{skill.description ? <p class="star-card-desc">{skill.description}</p> : null}
			<dl class="facts">
				{sv.maxRequired === null ? null : (
					<>
						<dt>Needed</dt>
						<dd>
							<LevelBadge level={sv.maxRequired} /> by {sv.requiredBy.length} open{" "}
							{sv.requiredBy.length === 1 ? "task" : "tasks"}
						</dd>
					</>
				)}
				{openLearning === 0 ? null : (
					<>
						<dt>Learning</dt>
						<dd>
							{openLearning} open {openLearning === 1 ? "step" : "steps"}
						</dd>
					</>
				)}
				<dt>Builds on</dt>
				<dd>{neighbours(skill.prerequisites, "no prerequisites")}</dd>
				<dt>Leads to</dt>
				<dd>{neighbours(sv.dependents, "nothing yet")}</dd>
			</dl>
			<a class="star-card-open" href={`#/skills/${encodeURIComponent(skill.key)}`}>
				Open skill →
			</a>
		</section>
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
							Prerequisites shine on the left; lines lead to the skills that build on them. Brighter stars are higher
							levels, hollow ones are not assessed yet. Click a star to read it.
						</p>
						<Constellation view={view} />
						<ul class="legend">
							{STATES.map((s) => (
								<li key={s}>
									<span class={`legend-star state-${s}`} aria-hidden="true" />
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

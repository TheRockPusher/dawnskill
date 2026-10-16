import { type JournalEntry, LEVEL_NAMES, type ReviewItem, type View } from "@dawnskill/core";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { ActionButton, LevelBadge, SkillLink, TaskLink, minutes, taskById, when } from "../ui.tsx";
import "./journal.css";

const DOCS = "https://github.com/TheRockPusher/dawnskill/blob/main/docs/learning-model.md";

type Kind = JournalEntry["kind"];
const KINDS: readonly Kind[] = ["learned", "assessed", "reviewed", "completed"];

function ReviewCard({ view, item }: { readonly view: View; readonly item: ReviewItem }) {
	const [tried, setTried] = useState(false);
	return (
		<article class="panel review-card stack">
			<header class="row">
				<strong>
					<SkillLink view={view} skillKey={item.skill} />
				</strong>
				<span class="chip">streak {item.streak}</span>
				<span class="chip">interval {item.intervalDays} d</span>
				<span class="muted">due {when(item.dueAt)}</span>
			</header>
			{item.prompts.length > 0 ? (
				<ol class="prompts">
					{item.prompts.map((p) => (
						<li key={p}>{p}</li>
					))}
				</ol>
			) : (
				<p class="muted">No prompts saved — recall what you learned about this skill.</p>
			)}
			{tried ? (
				<div class="row">
					<span class="muted">Did your answer match what you learned?</span>
					<ActionButton kind="primary" event={{ type: "ReviewRecorded", skill: item.skill, recalled: true }}>
						Recalled
					</ActionButton>
					<ActionButton kind="danger" event={{ type: "ReviewRecorded", skill: item.skill, recalled: false }}>
						Forgot
					</ActionButton>
				</div>
			) : (
				<div class="row">
					<span class="muted">Answer from memory first — then check.</span>
					<button type="button" class="secondary" onClick={() => setTried(true)}>
						I tried to recall it
					</button>
				</div>
			)}
		</article>
	);
}

function Confirmation({ view, id }: { readonly view: View; readonly id: string }) {
	const p = view.proposals.find((x) => x.id === id);
	if (!p || p.payload.kind !== "level") return null;
	const { skill, level, evidence, fromTaskId } = p.payload;
	return (
		<li class="stack">
			<div class="row">
				<SkillLink view={view} skillKey={skill} /> → <LevelBadge level={level} />
				<span>{LEVEL_NAMES[level]}</span>
				{fromTaskId ? (
					<span class="muted">
						from <TaskLink view={view} id={fromTaskId} />
					</span>
				) : null}
			</div>
			{evidence ? <p class="muted">Evidence: {evidence}</p> : null}
			<div class="row">
				<ActionButton kind="primary" event={{ type: "LevelConfirmed", proposalId: p.id, evidence }}>
					Confirm
				</ActionButton>
				<ActionButton
					kind="danger"
					event={() => {
						const reason = window.prompt("Why reject this level?", "");
						return reason === null ? null : { type: "ProposalRejected", proposalId: p.id, reason };
					}}
				>
					Reject
				</ActionButton>
			</div>
		</li>
	);
}

function Evidence({ text }: { readonly text: string | null }) {
	if (!text) return null;
	return /^https?:\/\//.test(text) ? (
		<a href={text} target="_blank" rel="noreferrer">
			evidence
		</a>
	) : (
		<span class="muted">“{text}”</span>
	);
}

function Entry({ view, e }: { readonly view: View; readonly e: JournalEntry }) {
	const time = new Date(e.at).toLocaleTimeString(undefined, { timeStyle: "short" });
	let body: ComponentChildren;
	switch (e.kind) {
		case "learned":
			body = (
				<>
					Learned <SkillLink view={view} skillKey={e.skill} /> to <LevelBadge level={e.level} /> {LEVEL_NAMES[e.level]}{" "}
					via <TaskLink view={view} id={e.taskId} />
					{e.outcome ? <span class="muted"> — {e.outcome}</span> : null} <Evidence text={e.evidenceUrl} />
				</>
			);
			break;
		case "assessed":
			body = (
				<>
					Assessed <SkillLink view={view} skillKey={e.skill} /> at <LevelBadge level={e.level} /> {LEVEL_NAMES[e.level]}{" "}
					<span class="chip">{e.source === "self" ? "self-rated" : "confirmed"}</span> <Evidence text={e.evidence} />
				</>
			);
			break;
		case "reviewed":
			body = (
				<>
					Reviewed <SkillLink view={view} skillKey={e.skill} />:{" "}
					<span class={e.recalled ? "chip state-assessed" : "chip state-gap"}>
						{e.recalled ? "recalled" : "forgot"}
					</span>
				</>
			);
			break;
		case "completed":
			body = (
				<>
					Completed <TaskLink view={view} id={e.taskId} />
					{e.actualMinutes !== null ? <span class="muted"> in {minutes(e.actualMinutes)}</span> : null}
					{e.outcome ? <span class="muted"> — {e.outcome}</span> : null}
				</>
			);
			break;
	}
	return (
		<li class={`journal-entry journal-${e.kind}`}>
			<time dateTime={e.at} class="muted">
				{time}
			</time>{" "}
			{body}
		</li>
	);
}

function entrySkill(view: View, e: JournalEntry): string | null {
	if (e.kind === "completed") {
		const t = taskById(view, e.taskId);
		return t?.task.learning?.skill ?? null;
	}
	return e.skill;
}

export function Learning({ view }: { readonly view: View }) {
	const [skill, setSkill] = useState("");
	const [kind, setKind] = useState("");
	const entries = view.journal
		.filter((e) => (kind === "" || e.kind === kind) && (skill === "" || entrySkill(view, e) === skill))
		.slice()
		.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	const days = new Map<string, JournalEntry[]>();
	for (const e of entries) {
		const day = new Date(e.at).toLocaleDateString(undefined, { dateStyle: "full" });
		const list = days.get(day);
		if (list) list.push(e);
		else days.set(day, [e]);
	}
	const skills = view.skills.slice().sort((a, b) => a.skill.name.localeCompare(b.skill.name));

	return (
		<div class="stack">
			<section class="panel stack">
				<h2>Reviews due ({view.focus.reviewsDue.length})</h2>
				<p class="muted">
					Spaced retrieval: first review 1 d after learning, then 6 d, then each interval ×2.5; forgetting resets to 1
					d.{" "}
					<a href={DOCS} target="_blank" rel="noreferrer">
						Why?
					</a>
				</p>
				{view.focus.reviewsDue.length === 0 ? (
					<p class="muted">Nothing due. Well done.</p>
				) : (
					view.focus.reviewsDue.map((r) => <ReviewCard key={r.skill} view={view} item={r} />)
				)}
			</section>

			{view.focus.confirmations.length > 0 ? (
				<section class="panel stack">
					<h2>Level confirmations ({view.focus.confirmations.length})</h2>
					<p class="muted">A level only changes when you confirm it.</p>
					<ul class="stack plain">
						{view.focus.confirmations.map((id) => (
							<Confirmation key={id} view={view} id={id} />
						))}
					</ul>
				</section>
			) : null}

			<section class="panel stack">
				<h2>Review schedule</h2>
				{view.reviews.length === 0 ? (
					<p class="muted">Finish a learning task to start reviewing that skill.</p>
				) : (
					<table class="list">
						<thead>
							<tr>
								<th>Skill</th>
								<th>Due</th>
								<th>Streak</th>
								<th>Interval</th>
								<th>Last review</th>
							</tr>
						</thead>
						<tbody>
							{view.reviews.map((r) => (
								<tr key={r.skill} class={r.due ? "due" : undefined}>
									<td>
										<SkillLink view={view} skillKey={r.skill} />
									</td>
									<td>
										{when(r.dueAt)}
										{r.due ? <span class="chip state-gap">due</span> : null}
									</td>
									<td>{r.streak}</td>
									<td>{r.intervalDays} d</td>
									<td>{r.lastReviewAt ? when(r.lastReviewAt) : <span class="muted">never</span>}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>

			<section class="panel stack">
				<h2>Skill progress</h2>
				{skills.length === 0 ? (
					<p class="muted">No skills yet.</p>
				) : (
					<table class="list">
						<thead>
							<tr>
								<th>Skill</th>
								<th>Current</th>
								<th>Highest required</th>
								<th>Learning steps done</th>
							</tr>
						</thead>
						<tbody>
							{skills.map((s) => {
								const done = s.learningTaskIds.filter((id) => taskById(view, id)?.task.status === "done").length;
								return (
									<tr key={s.skill.key}>
										<td>
											<SkillLink view={view} skillKey={s.skill.key} />
										</td>
										<td>
											<LevelBadge level={s.skill.level} />
										</td>
										<td>
											{s.maxRequired === null ? <span class="muted">—</span> : <LevelBadge level={s.maxRequired} />}
										</td>
										<td>
											{done} / {s.learningTaskIds.length}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</section>

			<section class="panel stack">
				<h2>Journal</h2>
				<div class="row">
					<label>
						Skill{" "}
						<select value={skill} onChange={(e) => setSkill(e.currentTarget.value)}>
							<option value="">All skills</option>
							{skills.map((s) => (
								<option key={s.skill.key} value={s.skill.key}>
									{s.skill.name}
								</option>
							))}
						</select>
					</label>
					<label>
						Kind{" "}
						<select value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
							<option value="">All kinds</option>
							{KINDS.map((k) => (
								<option key={k} value={k}>
									{k}
								</option>
							))}
						</select>
					</label>
				</div>
				{days.size === 0 ? (
					<p class="muted">No entries.</p>
				) : (
					[...days].map(([day, list]) => (
						<div key={day} class="journal-day">
							<h3>{day}</h3>
							<ul class="journal">
								{list.map((e, i) => (
									<Entry key={`${e.at}-${i}`} view={view} e={e} />
								))}
							</ul>
						</div>
					))
				)}
			</section>
		</div>
	);
}

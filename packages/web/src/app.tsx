import { useEffect, useState } from "preact/hooks";
import { useApp } from "./api.ts";
import { Focus } from "./views/focus.tsx";
import { Learning } from "./views/learning.tsx";
import { Plan } from "./views/plan.tsx";
import { Settings } from "./views/settings.tsx";
import { SkillDetail, Skills } from "./views/skills.tsx";
import { TaskDetail, Tasks } from "./views/tasks.tsx";

/** Routes: #/ · #/plan[/<proposalId>] · #/tasks[/<id>] · #/skills[/<key>] · #/learning · #/settings */
function useRoute(): readonly string[] {
	const read = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
	const [route, setRoute] = useState(read);
	useEffect(() => {
		const onChange = () => setRoute(read());
		addEventListener("hashchange", onChange);
		return () => removeEventListener("hashchange", onChange);
	}, []);
	return route;
}

const NAV = [
	["", "Focus"],
	["plan", "Plan"],
	["tasks", "Tasks"],
	["skills", "Skills"],
	["learning", "Learning"],
	["settings", "Settings"],
] as const;

export function App() {
	const [section = "", id] = useRoute();
	const { view, error } = useApp();
	const badge = view ? view.focus.confirmations.length + view.focus.reviewsDue.length + view.focus.drafts.length : 0;
	return (
		<>
			<header class="header">
				<a class="brand" href="#/">
					Dawnskill
				</a>
				<nav class="nav">
					{NAV.map(([path, label]) => (
						<a key={path} href={`#/${path}`} class={section === path ? "active" : ""}>
							{label}
							{path === "" && badge > 0 ? <span class="count">{badge}</span> : null}
						</a>
					))}
				</nav>
			</header>
			<main class="main">
				{error ? <p class="error">Connection problem: {error}</p> : null}
				{view === null ? (
					<p class="muted">Loading…</p>
				) : section === "plan" ? (
					<Plan view={view} proposalId={id ?? null} />
				) : section === "tasks" ? (
					id ? (
						<TaskDetail view={view} id={id} />
					) : (
						<Tasks view={view} />
					)
				) : section === "skills" ? (
					id ? (
						<SkillDetail view={view} skillKey={id} />
					) : (
						<Skills view={view} />
					)
				) : section === "learning" ? (
					<Learning view={view} />
				) : section === "settings" ? (
					<Settings view={view} />
				) : (
					<Focus view={view} />
				)}
			</main>
		</>
	);
}

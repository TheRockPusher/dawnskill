import { fc, test } from "@fast-check/vitest";
import { initialState, type KernelState, type PlanDraft, type Skill } from "@dawnskill/core";
import { describe, expect, it } from "vitest";
import { PlannerError, planGoal } from "./planner.ts";
import { ContextSizeError, llmConfigFromEnv, openAiCompatibleProvider, TruncatedReplyError } from "./provider.ts";
import { planResponses, scriptedProvider } from "./testing.ts";

const AT = "2026-10-16T09:30:00.000Z";
const INPUT = { goal: "Contribute a bug fix to ripgrep", context: "I write Python daily." };

const OWNERSHIP = {
	key: "rust-ownership-borrowing",
	name: "Rust: ownership & borrowing",
	description: "Moves, borrows and the borrow checker's rules.",
	concepts: ["move semantics", "shared vs mutable borrows"],
	prerequisites: [],
	resources: [
		{ title: "The Rust Book: Ownership", url: "https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html" },
	],
	retrievalPrompts: ["Explain when a value is moved.", "Write a function that borrows a Vec mutably."],
	practiceMinutes: 240,
} as const;

const VALID: PlanDraft = {
	goal: "Contribute a bug fix to ripgrep",
	summary: "Pick an issue, fix it in Rust, open a PR.",
	skills: [OWNERSHIP],
	tasks: [
		{
			ref: "t1",
			title: "Pick a good-first-issue",
			notes: "",
			doneWhen: "Issue assigned to me",
			category: "research",
			estimateMinutes: 30,
			importance: 3,
			urgency: 2,
			requires: [],
			after: [],
		},
		{
			ref: "t2",
			title: "Implement the fix with a regression test",
			notes: "",
			doneWhen: "cargo test passes with the new test",
			category: "coding",
			estimateMinutes: 240,
			importance: 5,
			urgency: 3,
			requires: [{ skill: OWNERSHIP.key, level: 2 }],
			after: ["t1"],
		},
		{
			ref: "t3",
			title: "Open the pull request",
			notes: "",
			doneWhen: "PR opened with passing CI",
			category: "writing",
			estimateMinutes: 30,
			importance: 4,
			urgency: 3,
			requires: [],
			after: ["t2"],
		},
	],
};

const [TASKS, SKILLS] = planResponses(VALID);

/** Stage A reply with task `index` patched. */
function tasksWith(index: number, patch: Record<string, unknown>): string {
	const reply = JSON.parse(TASKS) as { tasks: Record<string, unknown>[] };
	return JSON.stringify({ ...reply, tasks: reply.tasks.map((t, i) => (i === index ? { ...t, ...patch } : t)) });
}

/** Stage B reply from skill entries (`neededBy` included). */
function skillsReply(...skills: readonly Record<string, unknown>[]): string {
	return JSON.stringify({ skills });
}

const OWNERSHIP_ENTRY = { ...OWNERSHIP, neededBy: [{ task: 1, level: 2 }] };

function stateWith(skills: readonly Pick<Skill, "key" | "name">[]): KernelState {
	return {
		...initialState(),
		skills: Object.fromEntries(
			skills.map((s) => [
				s.key,
				{
					...s,
					description: "",
					concepts: ["c"],
					prerequisites: [],
					resources: [],
					retrievalPrompts: ["p"],
					practiceMinutes: 60,
					level: 2,
					createdAt: AT,
				} satisfies Skill,
			]),
		),
	};
}

describe("planGoal", () => {
	it("builds the draft from a tasks stage and a skills stage", async () => {
		const provider = scriptedProvider([TASKS, SKILLS]);
		const result = await planGoal(provider, initialState(), INPUT);
		expect(result).toEqual({ draft: VALID, attempts: 2, remapped: {} });
		provider.assertDone();
		const [tasks, skills] = provider.calls;
		expect(tasks?.schemaName).toBe("plan_tasks");
		expect(tasks?.user).toContain("Goal: Contribute a bug fix to ripgrep");
		expect(tasks?.user).toContain("Context: I write Python daily.");
		expect(skills?.schemaName).toBe("plan_skills");
		expect(skills?.user).toContain("0. Pick a good-first-issue; done when: Issue assigned to me");
		expect(skills?.user).toContain("2. Open the pull request; done when: PR opened with passing CI");
	});

	it("keeps the user's goal, trimmed and cut to 200 chars; the tasks schema has no goal", async () => {
		const long = `  ${"Contribute a bug fix to ripgrep ".repeat(10)}`;
		const provider = scriptedProvider([TASKS, SKILLS]);
		const { draft } = await planGoal(provider, initialState(), { goal: long, context: "" });
		expect(draft.goal).toBe(long.trim().slice(0, 200));
		expect(provider.calls[0]?.schema).not.toHaveProperty("properties.goal");
		expect(provider.calls[1]?.user).toContain(`Goal: ${long.trim().slice(0, 200)}\n`);
	});

	it("rejects a model reply that rewrites the goal", async () => {
		const rewritten = JSON.stringify({ ...JSON.parse(TASKS), goal: "Add --repurpose to the CLI parser" });
		const provider = scriptedProvider([rewritten, TASKS, SKILLS]);
		const result = await planGoal(provider, initialState(), INPUT);
		expect(result).toEqual({ draft: VALID, attempts: 3, remapped: {} });
		expect(provider.calls[1]?.user).toContain("1. (root) has unknown properties goal");
	});

	it("refuses an empty goal without calling the model", async () => {
		const provider = scriptedProvider([]);
		await expect(planGoal(provider, initialState(), { goal: "  ", context: "" })).rejects.toThrow("goal is empty");
		expect(provider.calls).toHaveLength(0);
	});

	it("constrains neededBy.task to an enum of the task indices", async () => {
		const provider = scriptedProvider([TASKS, SKILLS]);
		await planGoal(provider, initialState(), INPUT);
		expect(provider.calls[1]?.schema).toMatchObject({
			properties: {
				skills: {
					items: {
						properties: {
							neededBy: {
								items: { properties: { task: { enum: [0, 1, 2] }, level: { enum: [1, 2, 3, 4, 5] } } },
							},
						},
					},
				},
			},
		});
	});

	it("lists existing skills as key | name | level in the skills stage", async () => {
		const provider = scriptedProvider([TASKS, SKILLS]);
		await planGoal(provider, stateWith([{ key: "git-rebase", name: "Git: interactive rebase" }]), INPUT);
		expect(provider.calls[1]?.user).toContain("- git-rebase | Git: interactive rebase | L2");
	});

	it("drops forward, self and out-of-range after indices", async () => {
		const reply = JSON.parse(TASKS) as { tasks: Record<string, unknown>[] };
		const afters = [
			[1, 7, 0],
			[0, 1, 0, 2],
			[1, 5, 0],
		];
		const tasks = JSON.stringify({ ...reply, tasks: reply.tasks.map((t, i) => ({ ...t, after: afters[i] })) });
		const { draft } = await planGoal(scriptedProvider([tasks, SKILLS]), initialState(), INPUT);
		expect(draft.tasks.map((t) => t.after)).toEqual([[], ["t1"], ["t2", "t1"]]);
	});

	test.prop([fc.array(fc.array(fc.integer({ min: -3, max: 15 }), { maxLength: 6 }), { minLength: 3, maxLength: 3 })])(
		"any after indices become dependencies on earlier tasks only",
		async (afters) => {
			const reply = JSON.parse(TASKS) as { tasks: Record<string, unknown>[] };
			const tasks = JSON.stringify({ ...reply, tasks: reply.tasks.map((t, i) => ({ ...t, after: afters[i] })) });
			const { draft, attempts } = await planGoal(scriptedProvider([tasks, SKILLS]), initialState(), INPUT);
			expect(attempts).toBe(2);
			draft.tasks.forEach((task, i) => {
				for (const ref of task.after) expect(Number(ref.slice(1)) - 1).toBeLessThan(i);
			});
		},
	);

	it("derives requires from neededBy, keeping the highest level per task", async () => {
		const skills = skillsReply({
			...OWNERSHIP,
			neededBy: [
				{ task: 1, level: 2 },
				{ task: 1, level: 3 },
				{ task: 2, level: 1 },
			],
		});
		const { draft } = await planGoal(scriptedProvider([TASKS, skills]), initialState(), INPUT);
		expect(draft.tasks.map((t) => t.requires)).toEqual([
			[],
			[{ skill: OWNERSHIP.key, level: 3 }],
			[{ skill: OWNERSHIP.key, level: 1 }],
		]);
	});

	it("repairs each stage with only that stage's output and errors", async () => {
		const badTasks = tasksWith(0, { importance: 9 });
		const badSkills = skillsReply({ ...OWNERSHIP_ENTRY, neededBy: [{ task: 3, level: 2 }] }, OWNERSHIP_ENTRY);
		const provider = scriptedProvider([badTasks, TASKS, badSkills, SKILLS]);
		const result = await planGoal(provider, initialState(), INPUT);
		expect(result).toEqual({ draft: VALID, attempts: 4, remapped: {} });
		provider.assertDone();

		const tasksRepair = provider.calls[1];
		expect(tasksRepair?.schemaName).toBe("plan_tasks");
		expect(tasksRepair?.user).toContain("1. tasks[0].importance = 9: must be <= 5");
		expect(tasksRepair?.user).toContain('"importance":9');
		expect(tasksRepair?.user).toContain("return the corrected JSON");
		expect(tasksRepair?.user).not.toContain("Context:");

		const skillsRepair = provider.calls[3];
		expect(skillsRepair?.schemaName).toBe("plan_skills");
		expect(skillsRepair?.user).toContain(
			"1. skills[0].neededBy[0].task = 3: must be equal to one of the allowed values",
		);
		expect(skillsRepair?.user).not.toContain("done when:");
	});

	it("reports kernel validation errors of the skills stage by path and value", async () => {
		const provider = scriptedProvider([TASKS, skillsReply(OWNERSHIP_ENTRY, OWNERSHIP_ENTRY), SKILLS]);
		await planGoal(provider, initialState(), INPUT);
		expect(provider.calls[2]?.user).toContain(`1. skills[1].key = "${OWNERSHIP.key}" duplicates skills[0]`);
	});

	it("throws PlannerError after 1 + maxRepairs invalid attempts of a stage", async () => {
		const bad = tasksWith(0, { estimateMinutes: 0 });
		const provider = scriptedProvider([bad, bad, bad]);
		const error = await planGoal(provider, initialState(), INPUT).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PlannerError);
		expect(error).toMatchObject({ attempts: 3, errors: ["tasks[0].estimateMinutes = 0: must be >= 1"] });
		provider.assertDone();
	});

	it("counts attempts across both stages", async () => {
		const provider = scriptedProvider([TASKS, "{}", "{}"]);
		await expect(planGoal(provider, initialState(), INPUT, { maxRepairs: 1 })).rejects.toMatchObject({
			attempts: 3,
			errors: ["(root): must have required properties skills"],
		});
		provider.assertDone();
	});

	it("respects maxRepairs 0", async () => {
		const provider = scriptedProvider(["{}"]);
		await expect(planGoal(provider, initialState(), INPUT, { maxRepairs: 0 })).rejects.toMatchObject({ attempts: 1 });
		provider.assertDone();
	});

	it("counts a non-JSON response as an attempt", async () => {
		const provider = scriptedProvider(["Sure! Here is your plan:", TASKS, SKILLS]);
		const result = await planGoal(provider, initialState(), INPUT);
		expect(result.attempts).toBe(3);
		expect(provider.calls[1]?.user).toContain("1. response is not valid JSON");
		expect(provider.calls[1]?.user).toContain("Sure! Here is your plan:");
	});

	it("normalizes keys, references, strings, minutes, duplicates, prerequisites and resources", async () => {
		const tasks = tasksWith(1, { title: "  Implement the fix with a regression test \n", estimateMinutes: 240.4 });
		const skills = skillsReply(
			{
				...OWNERSHIP_ENTRY,
				key: "Rust: Ownership & Borrowing",
				concepts: ["move semantics", " move semantics ", "shared vs mutable borrows"],
				resources: [
					...OWNERSHIP.resources,
					{ title: "Bad", url: "javascript:alert(1)" },
					{ title: "Ftp", url: "ftp://example.org/x" },
				],
				practiceMinutes: 239.6,
			},
			{
				...OWNERSHIP,
				key: "rust_lifetimes",
				name: "Rust: lifetimes",
				prerequisites: ["Rust: Ownership & Borrowing", "made-up-skill", "rust_lifetimes"],
				neededBy: [],
			},
		);
		const { draft, attempts } = await planGoal(scriptedProvider([tasks, skills]), initialState(), INPUT);
		expect(attempts).toBe(2);
		expect(draft.tasks).toEqual(VALID.tasks);
		expect(draft.skills.map((s) => s.key)).toEqual(["rust-ownership-borrowing", "rust-lifetimes"]);
		expect(draft.skills[0]).toEqual(OWNERSHIP);
		expect(draft.skills[1]?.prerequisites).toEqual(["rust-ownership-borrowing"]);
	});

	it("reuses an existing skill: requires its key and leaves it out of the draft skills", async () => {
		const state = stateWith([{ key: "git-rebase", name: "Git: interactive rebase" }]);
		const minimal = {
			key: "git-rebase",
			name: "x",
			description: "",
			concepts: ["x"],
			retrievalPrompts: ["x"],
			practiceMinutes: 5,
			prerequisites: ["no-such-skill"],
			resources: [],
			neededBy: [{ task: 2, level: 2 }],
		};
		const { draft } = await planGoal(scriptedProvider([TASKS, skillsReply(OWNERSHIP_ENTRY, minimal)]), state, INPUT);
		expect(draft.skills).toEqual([OWNERSHIP]);
		expect(draft.tasks[2]?.requires).toEqual([{ skill: "git-rebase", level: 2 }]);
	});

	it("keeps a context-size failure fatal: no repair, a clear PlannerError", async () => {
		const provider = scriptedProvider([
			TASKS,
			() => {
				throw new ContextSizeError("HTTP 400: the request exceeds the available context size");
			},
			SKILLS,
		]);
		const error = await planGoal(provider, initialState(), INPUT).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PlannerError);
		expect(error).toMatchObject({
			attempts: 2,
			message: "model context too small: HTTP 400: the request exceeds the available context size",
		});
		expect(provider.calls).toHaveLength(2);
	});

	it("retries a truncated stage reply with the original request and a shorter-reply note", async () => {
		const truncated = () => {
			throw new TruncatedReplyError(4096);
		};
		const provider = scriptedProvider([truncated, TASKS, truncated, SKILLS]);
		const result = await planGoal(provider, initialState(), INPUT);
		expect(result).toEqual({ draft: VALID, attempts: 4, remapped: {} });
		provider.assertDone();
		const [tasksFirst, tasksRetry, skillsFirst, skillsRetry] = provider.calls;
		expect(tasksRetry?.user).toBe(
			`${tasksFirst?.user}\n\nYour previous reply was cut off before the JSON ended. Reply again with the same structure, shorter: at most 8 tasks, one sentence per text field.`,
		);
		expect(skillsRetry?.user).toBe(
			`${skillsFirst?.user}\n\nYour previous reply was cut off before the JSON ended. Reply again with the same structure, shorter: at most 8 skills, one sentence per text field.`,
		);
	});

	it("fails with the truncation message when every attempt is cut off", async () => {
		const truncated = () => {
			throw new TruncatedReplyError(4096);
		};
		const provider = scriptedProvider([truncated, truncated, truncated]);
		await expect(planGoal(provider, initialState(), INPUT)).rejects.toMatchObject({
			attempts: 3,
			errors: ["reply truncated at max_tokens 4096"],
		});
		provider.assertDone();
	});
});

describe("skill deduplication", () => {
	const existing = { key: "rust-ownership", name: "Rust: ownership" };
	const lifetimes = { ...OWNERSHIP, key: "rust-lifetimes", name: "Rust: lifetimes", prerequisites: [OWNERSHIP.key] };
	const draft: PlanDraft = { ...VALID, skills: [OWNERSHIP, lifetimes] };

	it("remaps a draft skill to the existing key when the judge says yes", async () => {
		const provider = scriptedProvider([...planResponses(draft), '{"same": true}']);
		const result = await planGoal(provider, stateWith([existing]), INPUT);
		provider.assertDone();
		expect(result.remapped).toEqual({ [OWNERSHIP.key]: "rust-ownership" });
		expect(result.draft.skills.map((s) => s.key)).toEqual(["rust-lifetimes"]);
		expect(result.draft.skills[0]?.prerequisites).toEqual(["rust-ownership"]);
		expect(result.draft.tasks[1]?.requires).toEqual([{ skill: "rust-ownership", level: 2 }]);
		const judge = provider.calls[2];
		expect(judge?.schemaName).toBe("same_skill");
		expect(judge?.maxTokens).toBeLessThanOrEqual(32);
		expect(judge?.user).toContain("key: rust-ownership\n");
		expect(judge?.user).toContain(`key: ${OWNERSHIP.key}\n`);
	});

	it("keeps the draft skill when the judge says no", async () => {
		const provider = scriptedProvider([...planResponses(draft), '{"same": false}']);
		const result = await planGoal(provider, stateWith([existing]), INPUT);
		provider.assertDone();
		expect(result.remapped).toEqual({});
		expect(result.draft).toEqual(draft);
	});

	it("asks nothing when no existing skill is similar", async () => {
		const provider = scriptedProvider(planResponses(draft));
		const result = await planGoal(provider, stateWith([{ key: "git-rebase", name: "Git: interactive rebase" }]), INPUT);
		provider.assertDone();
		expect(result.remapped).toEqual({});
	});

	it("makes at most 5 judge calls per plan", async () => {
		const similar = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ key: `rust-ownership-v${n}`, name: `Rust: ownership v${n}` }));
		const provider = scriptedProvider([TASKS, SKILLS, ...Array.from({ length: 5 }, () => '{"same": false}')]);
		const result = await planGoal(provider, stateWith(similar), INPUT);
		provider.assertDone();
		expect(provider.calls).toHaveLength(7);
		expect(result.draft).toEqual(VALID);
	});
});

describe("openAiCompatibleProvider", () => {
	const config = {
		baseUrl: "http://127.0.0.1:8080/v1/",
		apiKey: "sk-secret-123",
		model: "qwen",
		timeoutMs: 1000,
		maxTokens: 4096,
	};
	const request = { system: "sys", user: "usr", schemaName: "plan_draft", schema: { type: "object" }, maxTokens: 99 };

	function reply(content: string, finishReason = "stop"): Response {
		return new Response(
			JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }] }),
			{ status: 200 },
		);
	}

	function capture(response: () => Response): { fetch: typeof fetch; seen: { url: string; init: RequestInit }[] } {
		const seen: { url: string; init: RequestInit }[] = [];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return response();
		}) as typeof fetch;
		return { fetch: fakeFetch, seen };
	}

	it("posts a strict json_schema chat completion with bearer auth", async () => {
		const { fetch, seen } = capture(() => reply('{"ok":true}'));
		const content = await openAiCompatibleProvider(config, fetch).completeJson(request);
		expect(content).toBe('{"ok":true}');
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
		expect(seen[0]?.init.method).toBe("POST");
		expect(seen[0]?.init.headers).toMatchObject({ authorization: "Bearer sk-secret-123" });
		expect(JSON.parse(seen[0]?.init.body as string)).toEqual({
			model: "qwen",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "usr" },
			],
			temperature: 0.2,
			max_tokens: 99,
			response_format: {
				type: "json_schema",
				json_schema: { name: "plan_draft", strict: true, schema: { type: "object" } },
			},
		});
	});

	it("caps max_tokens at the configured budget", async () => {
		const { fetch, seen } = capture(() => reply("{}"));
		await openAiCompatibleProvider(config, fetch).completeJson({ ...request, maxTokens: 9999 });
		expect(JSON.parse(seen[0]?.init.body as string)).toMatchObject({ max_tokens: 4096 });
	});

	it("omits the authorization header without an API key", async () => {
		const { fetch, seen } = capture(() => reply("{}"));
		await openAiCompatibleProvider({ ...config, apiKey: null }, fetch).completeJson(request);
		expect(seen[0]?.init.headers).not.toHaveProperty("authorization");
	});

	function hangingFetch(): typeof fetch {
		return ((_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as typeof fetch;
	}

	it("aborts when the timeout elapses", async () => {
		const provider = openAiCompatibleProvider({ ...config, timeoutMs: 5 }, hangingFetch());
		await expect(provider.completeJson(request)).rejects.toThrow("LLM request timed out after 5 ms");
	});

	it("aborts with the caller's signal", async () => {
		const controller = new AbortController();
		const pending = openAiCompatibleProvider(config, hangingFetch()).completeJson(request, controller.signal);
		controller.abort();
		const error = (await pending.catch((e: unknown) => e)) as Error;
		expect(error.name).toBe("AbortError");
	});

	it("reports non-2xx status and a body excerpt without the API key", async () => {
		const body = `{"error":"invalid key sk-secret-123"}${"x".repeat(1000)}`;
		const { fetch } = capture(() => new Response(body, { status: 401 }));
		const error = (await openAiCompatibleProvider(config, fetch)
			.completeJson(request)
			.catch((e: unknown) => e)) as Error;
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ContextSizeError);
		expect(error.message).toContain("HTTP 401");
		expect(error.message).toContain("invalid key");
		expect(error.message).not.toContain("sk-secret-123");
		expect(error.message.length).toBeLessThan(400);
	});

	it("reports a server context-size error as ContextSizeError", async () => {
		const body =
			'{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}';
		const { fetch } = capture(() => new Response(body, { status: 400 }));
		const error = (await openAiCompatibleProvider(config, fetch)
			.completeJson(request)
			.catch((e: unknown) => e)) as Error;
		expect(error).toBeInstanceOf(ContextSizeError);
		expect(error.message).toMatch(/^model context too small: HTTP 400: .*exceeds the available context size/);
	});

	it("reports a reply cut off at max_tokens as TruncatedReplyError", async () => {
		const { fetch } = capture(() => reply('{"summary": "trunc', "length"));
		const error = (await openAiCompatibleProvider(config, fetch)
			.completeJson(request)
			.catch((e: unknown) => e)) as Error;
		expect(error).toBeInstanceOf(TruncatedReplyError);
		expect(error.message).toBe("reply truncated at max_tokens 99");
	});
});

describe("llmConfigFromEnv", () => {
	it("is disabled without a base URL", () => {
		expect(llmConfigFromEnv({})).toBeNull();
		expect(llmConfigFromEnv({ DAWNSKILL_LLM_BASE_URL: "  " })).toBeNull();
	});

	it("applies defaults", () => {
		expect(llmConfigFromEnv({ DAWNSKILL_LLM_BASE_URL: "http://127.0.0.1:8080/v1", DAWNSKILL_LLM_API_KEY: "" })).toEqual(
			{
				baseUrl: "http://127.0.0.1:8080/v1",
				apiKey: null,
				model: "default",
				timeoutMs: 120_000,
				maxTokens: 4096,
			},
		);
	});

	it("reads every variable and rejects bad numbers", () => {
		const env = {
			DAWNSKILL_LLM_BASE_URL: "https://api.example.com/v1",
			DAWNSKILL_LLM_API_KEY: "k",
			DAWNSKILL_LLM_MODEL: "m",
			DAWNSKILL_LLM_TIMEOUT_MS: "5000",
			DAWNSKILL_LLM_MAX_TOKENS: "2048",
		};
		expect(llmConfigFromEnv(env)).toEqual({
			baseUrl: env.DAWNSKILL_LLM_BASE_URL,
			apiKey: "k",
			model: "m",
			timeoutMs: 5000,
			maxTokens: 2048,
		});
		expect(() => llmConfigFromEnv({ ...env, DAWNSKILL_LLM_TIMEOUT_MS: "soon" })).toThrow("DAWNSKILL_LLM_TIMEOUT_MS");
		expect(() => llmConfigFromEnv({ ...env, DAWNSKILL_LLM_MAX_TOKENS: "0" })).toThrow("DAWNSKILL_LLM_MAX_TOKENS");
	});
});

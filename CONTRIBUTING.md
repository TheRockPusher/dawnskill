# Contributing

Setup: Node 24, pnpm 12 (version pinned in `package.json` `packageManager`), then:

```sh
pnpm install
pnpm exec lefthook install   # pre-commit: biome format on staged files; commit-msg: Conventional Commits check
```

[docs/architecture.md](docs/architecture.md) describes the code, and [docs/learning-model.md](docs/learning-model.md) specifies every learning-science constant. A change to a constant changes that document in the same commit.

## Commits and releases

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>)!: <subject>`, where `type` is one of `feat`, `fix`, `chore`, `ci`, `test`, `docs`, `refactor`, `perf`, `build`. `scripts/check-commit-msg.mjs` enforces this through the lefthook `commit-msg` hook. Merge, revert and `fixup!`/`squash!`/`amend!` subjects are exempt.

[release-please](https://github.com/googleapis/release-please) derives the version and CHANGELOG from these commits on `main`:

- It opens a release PR, and merging it tags `v<version>`.
- While the version is below 1.0, `feat` and breaking changes bump the minor version and `fix` bumps the patch.
- `chore` is hidden from the changelog.
- A release builds and pushes `ghcr.io/therockpusher/dawnskill` with tags `<version>`, `<major>.<minor>` and `latest`.

## Gates

```sh
pnpm check
```

This runs, in order and stopping at the first failure:

1. `pnpm format:check` (Biome, formatting only; fix with `pnpm format`)
2. `pnpm typecheck` (`tsc -b`; layering is enforced by project references)
3. `pnpm triggers:check` (generated SQL in sync with the transition tables)
4. `pnpm lint` (oxlint, type-aware: floating promises, exhaustive switches without `default`, import bans)
5. `pnpm knip` (unused files, exports, dependencies)
6. `pnpm test` (Vitest, `TZ=UTC`)
7. `pnpm build` (web UI)

CI (`.github/workflows/ci.yml`) runs the same steps with `FC_SEED=424242`, checks the performance budgets (`pnpm perf --check`, after the build) and then builds and smoke-tests the Docker image. The nightly workflow runs the tests with a fresh seed every day and mutation testing (`pnpm mutation`) every Sunday.

## Tests

- **Examples use Vitest's `it`. Properties use `test.prop` from `@fast-check/vitest`.** `test` from `@fast-check/vitest` re-runs a plain body `numRuns` times, so never use it for a deterministic example.
- **Everything is deterministic.**
  - Pass a clock (`clock: () => NOW`, fixed ISO timestamps in events). Never read real time: core cannot (lint bans `Date.now` and friends there), and host code takes the clock as a parameter.
  - Make no network calls and use no live model. Agent and host tests use `scriptedProvider` and `planResponses` from `@dawnskill/agents/testing`. Call `assertDone()` when every scripted reply must be consumed.
- **Seeds.** `test/setup.ts` sets fast-check's global seed from `FC_SEED` (default 424242) and runs from `FC_NUM_RUNS` (default 200). To replay a nightly failure, copy the command from the job summary:

  ```sh
  FC_SEED=<seed> FC_NUM_RUNS=2000 pnpm test
  ```

  Then commit the counterexample as an `it` example.
- **What to test.** Write tests for kernel rules, invariants, error messages and end-to-end flows. Do not write tests for wiring, getters or markup snapshots. Mutation score on `packages/core`, not a coverage threshold, measures how strong the tests are.

## Kernel ownership

`.github/CODEOWNERS` requires owner review for:

- `packages/core/src/kernel/`: transition tables, events, reducer, readiness, learning-step generation, validation
- `packages/host/src/db/`: schema and migrations, the store (the only writer), the trigger generator and the generated SQL
- `.github/`: CI, CODEOWNERS

Handlers, routes, agents and the web UI are written against the reducer's types and cannot change domain state except by sending events. Changing an invariant means changing the kernel, its tests and docs/architecture.md together.

## Changing transitions and regenerating triggers

1. Edit `TASK_TRANSITIONS` or `PROPOSAL_TRANSITIONS` in `packages/core/src/kernel/transitions.ts`, and the reducer if it needs to.
2. Run `pnpm triggers:gen` to rewrite `packages/host/src/db/generated-triggers.sql`, and commit it.
3. Run `pnpm triggers:check`. It must print "in sync". On drift it prints a line diff and exits 1, and CI fails.

Every database open reinstalls the triggers, so existing databases pick up the change. The trigger tests enumerate every status pair from the tables, so they need no edits. A new kind of trigger goes into `generateTriggerSql` in `packages/host/src/db/triggers.ts`. Schema changes are new entries appended to `MIGRATIONS` in `schema.ts`; never edit a shipped migration.

Replay on open re-applies the whole event log with the current kernel and checks the stored state hash. A kernel change that rejects or alters the effect of events already in existing logs will make those databases refuse to open. Avoid such changes, or ship them together with a migration path.

## Docker smoke test

```sh
docker build -t dawnskill:local .
scripts/docker-smoke.sh dawnskill:local
```

The script starts the container on a random localhost port with a fresh volume and checks:

- `/healthz`, the SPA, and `/api/config` reporting no model;
- `POST /api/plan` returning 503;
- the offline flow: posting `PlanProposed` and `PlanApproved` creates worked-examples and guided-practice learning tasks, and starting the blocked work task returns 409;
- the view `seq` surviving `docker restart`;
- `/api/export`;
- the container running as non-root.

It also reports the image size and the time until the container is healthy.

Without Docker, you can run the HTTP checks against a local server. It needs a fresh data directory, no model configured, and the web UI built (`pnpm build`), since the script checks the SPA:

```sh
DATA_DIR=$(mktemp -d) PORT=3977 node packages/host/src/main.ts &
SMOKE_BASE_URL=http://127.0.0.1:3977 scripts/docker-smoke.sh
```

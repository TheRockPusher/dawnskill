# Performance

`scripts/perf.ts` measures the kernel, the SQLite store, the HTTP API, cold startup and the web bundle on
deterministic synthetic data, and prints a Markdown table. CI runs it with `--check` after `pnpm build` in the
`check` job (step "Performance budgets"); budgets are generous so shared runners pass, and a failure means a
regression of several times, not noise.

```sh
pnpm build          # the bundle rows read packages/web/dist/assets
pnpm perf           # print the table
pnpm perf --check   # also exit 1 if a budget fails
```

## What is measured

Every state is built through the real kernel with `userEvent` (fixed seeds, fixed clock): approved plans of 30
tasks and 5 new skills each (half the tasks require a skill at level 1–3, skills self-rated 0–3, two `after`
edges per task, so the kernel inserts learning steps for the gaps), then two passes of start/complete with level
confirmations, self-ratings and reviews. S100/S300/S1000 stop at the first plan reaching 100/300/1000 tasks.
The 5000-event log adds everyday churn on S300: 55 % note edits, 25 % start/pause, 10 % self-ratings, 10 % reviews.

- **kernel apply**: the churn events applied to S300 with `apply` (median of 7 runs after a warm-up).
- **deriveView**: median of 20 calls after 5 warm-ups.
- **store**: `store.apply` of the 5000-event log into a fresh WAL file (median of 3), then `openStore` on it
  (replay plus the state-hash check).
- **HTTP**: `createApp` + `@hono/node-server` on port 0 in the same process, S300 loaded; 200 warm-up then
  2000 timed requests per row; latency includes reading (and decompressing) the body. The budgeted GET uses
  `Accept-Encoding: identity` (the server's own cost); the gzip GET rows use browser-like `Accept-Encoding` and
  are informational, because the in-process client gunzips the whole view on the server's thread. Budgets apply
  at concurrency 1 (one user); concurrency 10 rows are informational.
- **cold startup**: `node packages/host/src/main.ts` with an empty `DATA_DIR`, until `/healthz` answers ok.
- **web bundle**: raw and gzip (level 6) size of every file in `packages/web/dist/assets`.

## Results

4 vCPU AMD EPYC-Genoa VPS, Node v26.9.0, linux/x64. S300 = 321 tasks (51 learning), 613 edges, 45 skills;
S1000 = 1006 tasks (166 learning), 1919 edges, 140 skills.

| metric | value | budget | pass |
| --- | --- | --- | --- |
| kernel apply, S300 (4910 churn events) | 479,237 events/s | > 2,000 events/s | yes |
| deriveView, S100 (107 tasks, median of 20) | 0.59 ms | – | – |
| deriveView, S1000 (1006 tasks, median of 20) | 7.79 ms | < 75 ms | yes |
| store apply, SQLite WAL file (5000 events, median of 3) | 1,094 events/s | > 300 events/s | yes |
| store reopen + replay + hash check (5000 events) | 62 ms | – | – |
| GET /api/view body on the wire, S300 (identity / gzip) | 546.4 KiB / 39.5 KiB | – | – |
| GET /api/view, no ETag, identity encoding, concurrency 1, p50 / p95 / p99 | 1.04 / 5.93 / 12.26 ms | p95 < 25 ms | yes |
| GET /api/view, no ETag, gzip, concurrency 1, p50 / p95 / p99 | 2.34 / 17.88 / 30.15 ms | – | – |
| GET /api/view, matching ETag (304), concurrency 1, p50 / p95 / p99 | 0.24 / 0.33 / 0.44 ms | p95 < 5 ms | yes |
| POST /api/events (TaskEdited notes), concurrency 1, p50 / p95 / p99 | 1.21 / 1.67 / 11.60 ms | p95 < 25 ms | yes |
| GET /api/view, no ETag, gzip, concurrency 10, p50 / p95 / p99 | 9.65 / 22.68 / 31.59 ms | – | – |
| GET /api/view, matching ETag (304), concurrency 10, p50 / p95 / p99 | 1.63 / 3.89 / 11.64 ms | – | – |
| POST /api/events (TaskEdited notes), concurrency 10, p50 / p95 / p99 | 12.52 / 26.66 / 36.46 ms | – | – |
| cold startup, `node packages/host/src/main.ts` → /healthz ok (median of 3) | 370 ms | < 2,000 ms | yes |
| web asset `index-CV3o2W9A.js` (raw / gzip) | 121.4 KiB / 35.5 KiB | – | – |
| web asset `index-rneOov0e.css` (raw / gzip) | 16.2 KiB / 4.2 KiB | – | – |
| web JS total, gzip | 35.5 KiB | < 80 KiB | yes |

## Where the time goes

- **Writes are bound by the state hash.** The kernel itself is negligible (~2 µs per event, structural sharing).
  `store.apply` costs ~0.9 ms per event at S300, ~0.8 ms of it in `stateHash`: per-entity JSON is cached by
  object identity, but every event still joins the canonical JSON of the whole state and runs sha256 over it, so
  write cost grows linearly with state size. Commits do not fsync (`synchronous = NORMAL` in WAL mode).
  Replay on open applies events without hashing and checks one hash at the end, so 5000 events take ~60 ms.
- **The view is recomputed once per change.** `deriveView` (6–8 ms at 1000 tasks, near-linear) runs once per
  `seq` or 60 s refresh; the API then serializes and gzips it once and serves those same bytes and ETag to every
  GET until the next change. A 304 costs ~0.25 ms.
- **The view is large.** 546 KiB of JSON at 321 tasks: each task view carries the full task (~1.2 KB, learning
  steps include deliverables and prompts) and its MCDA score breakdown (~0.5 KB), and proposals include every
  accepted plan draft (~100 KB). gzip shrinks it 14× to 39.5 KiB.
- **Reading the HTTP rows.** Client and server share one thread. The identity GET (~1 ms p50) is the server's
  cost; the gzip rows add the client's gunzip of 546 KiB, which a browser does on its own machine. At
  concurrency 10 a single thread queues requests, so latency is about 10× the per-request cost: those rows track
  throughput, not user-visible latency.
- **Startup** (~0.4 s) is Node stripping types from the TypeScript sources, opening SQLite and replaying an
  empty log. Large logs add the replay time above.
- **Static assets** under `/assets/` are content-hashed and served with
  `Cache-Control: public, max-age=31536000, immutable`; `index.html` and the SPA fallback get `no-cache`, so a
  new deploy is picked up on the next load. The host does not compress static files (JS is 121 KiB raw); with
  immutable caching that is paid once per deploy, and a reverse proxy can add compression.

### Effect of view caching and gzip (same machine, S300)

Before, every GET re-ran `JSON.stringify` on the cached view (~1.5 ms) and sent it uncompressed. "After" spans
two runs to show run-to-run noise.

| | before | after |
| --- | --- | --- |
| GET /api/view on the wire (gzip-accepting client) | 546.4 KiB | 39.5 KiB |
| GET /api/view, identity, concurrency 1, p50 / p95 | 1.59 / 4.84 ms | 0.82–1.04 / 3.05–5.93 ms |
| GET /api/view, concurrency 10, p50 / p95 | 24.13 / 43.73 ms | 9.65–10.51 / 22.68–23.48 ms |

# Changelog

## [0.4.0](https://github.com/TheRockPusher/dawnskill/compare/v0.3.0...v0.4.0) (2026-10-17)


### Features

* **host:** queue plan runs and let them be cancelled ([8764650](https://github.com/TheRockPusher/dawnskill/commit/87646504eb57a8b6822b89cd872af75085e8ca12))
* **web:** dark night-sky theme and a star-chart skill constellation ([dbe4fbb](https://github.com/TheRockPusher/dawnskill/commit/dbe4fbb7f763a459f6f84ae75978d59c4e65842a))
* **web:** show live model thinking and tokens per second for planner runs ([e122769](https://github.com/TheRockPusher/dawnskill/commit/e122769501564e192f459705fccfec04751e049d))
* **web:** tell model planning apart from drafts awaiting review in run chips ([eca41c4](https://github.com/TheRockPusher/dawnskill/commit/eca41c43f6dc8802a76adcd1b3483b7db1ba768c))


### Bug Fixes

* **web:** hide the token line on runs that ended before any chunk ([7ae66c6](https://github.com/TheRockPusher/dawnskill/commit/7ae66c66c7182432f0b96eab95be664e269fb88f))
* **web:** keep the star card inside the constellation ([daf4d84](https://github.com/TheRockPusher/dawnskill/commit/daf4d840488893706ad49ebbbba57079ca528fe8))

## [0.3.0](https://github.com/TheRockPusher/dawnskill/compare/v0.2.0...v0.3.0) (2026-10-16)


### Features

* **web:** base URL presets for OpenCode Go and OpenRouter in model settings ([51a98bf](https://github.com/TheRockPusher/dawnskill/commit/51a98bff5bdc43cce2dda22f469e7d8cf4874687))


### Bug Fixes

* **agents:** send x-opencode-session and a dawnskill user agent so OpenCode Go accepts planner requests ([0b90290](https://github.com/TheRockPusher/dawnskill/commit/0b902900ba9151afff2c5bd6bc451bd148de6578))

## [0.2.0](https://github.com/TheRockPusher/dawnskill/compare/v0.1.1...v0.2.0) (2026-10-16)


### Features

* **host:** configure the planner model from Settings via /api/settings/llm ([9e577d6](https://github.com/TheRockPusher/dawnskill/commit/9e577d6fb45c89d501bd01a63cc4d04bfdbc6242))

## [0.1.1](https://github.com/TheRockPusher/dawnskill/compare/v0.1.0...v0.1.1) (2026-10-16)


### Bug Fixes

* **docker:** make image files readable when the checkout was made with a restrictive umask ([317c8d2](https://github.com/TheRockPusher/dawnskill/commit/317c8d2419c085e5c8f4fffb5a8fa223a84e71f9))

## 0.1.0 (2026-10-16)


### Features

* **agents:** enforce task, concept and prompt counts in the planner grammar ([10e896d](https://github.com/TheRockPusher/dawnskill/commit/10e896d6ba65d1dfbd2f31b073f478ea585fe78a))
* **agents:** two-stage grammar-constrained planner with bounded repair and skill dedupe ([7aa5875](https://github.com/TheRockPusher/dawnskill/commit/7aa5875149ea891a2ff567da25d38a25d4ac6586))
* **core:** Dreyfus learning-step planner and plan draft validation ([ed315cf](https://github.com/TheRockPusher/dawnskill/commit/ed315cf6b848f6ba43ea02ad7b10c6103a4fb446))
* **core:** kernel contract with transition tables and derived readiness ([7629df4](https://github.com/TheRockPusher/dawnskill/commit/7629df4c1d919dfe70a17931983a75b3f5e89855))
* **core:** pure event reducer enforcing K1-K7 with model-based tests ([5d1762a](https://github.com/TheRockPusher/dawnskill/commit/5d1762a1a9aa584c6fa540afa7035978fde278ef))
* **core:** ROC-weighted MCDA priority, reference-class estimates, SM-2 reviews and view model ([c1d90f8](https://github.com/TheRockPusher/dawnskill/commit/c1d90f867fc77bf34aed6f5915330d405d0a0961))
* **host:** HTTP API with SSE updates, planner runs and event export ([203089a](https://github.com/TheRockPusher/dawnskill/commit/203089ad1930191b0de9c9c27a315918b39da523))
* **host:** SQLite event store with generated transition triggers and replay check ([a28b08e](https://github.com/TheRockPusher/dawnskill/commit/a28b08e53bbcfbfa4264f8fa2cccae82e7f792c8))
* **web:** app shell, live API client and Focus page with goal intake ([b44f111](https://github.com/TheRockPusher/dawnskill/commit/b44f1111449850fd7143708dc38f42556c2d7e11))
* **web:** learning journal with spaced retrieval reviews and settings ([4773e2e](https://github.com/TheRockPusher/dawnskill/commit/4773e2e9f78df39ed79ec9779044b43a12d9d1da))
* **web:** plan draft review with Dreyfus self-rating and learning preview ([04ad01f](https://github.com/TheRockPusher/dawnskill/commit/04ad01fbf0c7012a997c767392c403bef7ad1f09))
* **web:** task list and detail, skill constellation and skill pages ([4ce6ff1](https://github.com/TheRockPusher/dawnskill/commit/4ce6ff18d2c02214a5021ffc50e3d94390a0f2a2))


### Bug Fixes

* **agents:** retry truncated replies and reuse skills only via exact match or dedupe judge ([18673b7](https://github.com/TheRockPusher/dawnskill/commit/18673b749a4784e095897c931570c44e1c1d243f))
* **ci:** re-resolve the published port after restarting the smoke container ([20e46a5](https://github.com/TheRockPusher/dawnskill/commit/20e46a5f2891671b8b0ba51d96243fb4ab5f9518))


### Performance

* **host:** serve cached gzipped view JSON and cache hashed assets immutably ([4debf12](https://github.com/TheRockPusher/dawnskill/commit/4debf122741917b0c9586b78855aab1872dc1ada))


### Documentation

* add product plan and citation-backed learning model ([480ad0d](https://github.com/TheRockPusher/dawnskill/commit/480ad0dc17439520513347989f69d2ef97700f29))
* README, architecture and contributing guides ([47e5068](https://github.com/TheRockPusher/dawnskill/commit/47e50685fe82ddf7c215ffd084d440db439b98c7))


### Tests

* **ci:** end-to-end Docker smoke covering plan approval, refusal and restart persistence ([067c741](https://github.com/TheRockPusher/dawnskill/commit/067c7413c4b79cebd29d7d8cebbb8a2937cd2af5))
* make Stryker mutation testing work with vitest 5 and TypeScript 7 ([f3450ff](https://github.com/TheRockPusher/dawnskill/commit/f3450ff0ba0df3fe115a09f49b4704853d6d6e53))
* performance budgets for kernel, store, HTTP, startup and bundle in CI ([4f17853](https://github.com/TheRockPusher/dawnskill/commit/4f178534633a3a5ea3fd92a1a75e178d8ff5823f))


### CI

* add CI gates, Docker image smoke test, nightly property runs and release-please ([b066f8d](https://github.com/TheRockPusher/dawnskill/commit/b066f8d3e2d755a1d2e35b532829b215ff9fad1b))
* start release-please versioning at 0.1.0 ([1578d1c](https://github.com/TheRockPusher/dawnskill/commit/1578d1c54352b7d465531eb74d72583c5be2dc65))

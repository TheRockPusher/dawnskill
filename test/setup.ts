import fc from "fast-check";

// Deterministic property tests: reproduce a CI failure with the same FC_SEED.
fc.configureGlobal({
	seed: Number(process.env.FC_SEED ?? 424242),
	numRuns: Number(process.env.FC_NUM_RUNS ?? 200),
});

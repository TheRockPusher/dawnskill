// Validates a commit message against Conventional Commits (release-please reads them).
// Usage: node scripts/check-commit-msg.mjs <path-to-COMMIT_EDITMSG>
import { readFileSync } from "node:fs";

const TYPES = ["feat", "fix", "chore", "ci", "test", "docs", "refactor", "perf", "build"];
const CONVENTIONAL = new RegExp(`^(${TYPES.join("|")})(\\([\\w./-]+\\))?!?: \\S`);
// Git-generated subjects and autosquash markers.
const EXEMPT = /^(Merge |Revert "|fixup! |squash! |amend! )/;

const file = process.argv[2];
if (!file) {
	console.error("usage: node scripts/check-commit-msg.mjs <commit-msg-file>");
	process.exit(2);
}

const subject =
	readFileSync(file, "utf8")
		.split("\n")
		.find((line) => line.trim() !== "" && !line.startsWith("#")) ?? "";

if (!CONVENTIONAL.test(subject) && !EXEMPT.test(subject)) {
	console.error(`Invalid commit subject: "${subject}"
Expected Conventional Commits: <type>(<scope>)!: <subject>
  type: ${TYPES.join(", ")}
  e.g. feat(core): detect skill gaps`);
	process.exit(1);
}

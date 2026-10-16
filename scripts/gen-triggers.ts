// Writes packages/host/src/db/generated-triggers.sql from the kernel transition tables.
// `--check` writes nothing and exits 1 with a line diff when the committed file is out of date.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { TRIGGERS_SQL_PATH, generateTriggerSql } from "../packages/host/src/db/triggers.ts";

const expected = generateTriggerSql();
const file = relative(process.cwd(), TRIGGERS_SQL_PATH);

if (!process.argv.includes("--check")) {
	writeFileSync(TRIGGERS_SQL_PATH, expected);
	console.log(`wrote ${file}`);
} else {
	const actual = existsSync(TRIGGERS_SQL_PATH) ? readFileSync(TRIGGERS_SQL_PATH, "utf8") : "";
	if (actual === expected) {
		console.log(`${file} is in sync with the transition tables`);
	} else {
		console.error(`${file} differs from the generator output (- committed, + generated):\n`);
		console.error(lineDiff(actual.split("\n"), expected.split("\n")).join("\n"));
		console.error("\nRun `pnpm triggers:gen` and commit the result.");
		process.exitCode = 1;
	}
}

/** Changed lines only, from a longest-common-subsequence alignment; numbers are 1-based in each file. */
function lineDiff(a: readonly string[], b: readonly string[]): string[] {
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			const row = lcs[i] as number[];
			row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			i++;
			j++;
		} else if (j < b.length && (i === a.length || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
			out.push(`+${j + 1}: ${b[j]}`);
			j++;
		} else {
			out.push(`-${i + 1}: ${a[i]}`);
			i++;
		}
	}
	return out;
}

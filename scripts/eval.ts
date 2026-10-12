/**
 * `npm run eval` (phase 08, C1; docs/AI_STEP10.md): runs the golden set and the simulated customers,
 * prints the scores, and compares them with the committed baseline for the model.
 *
 *   npm run eval                          the offline stand-in (what `npm test` checks)
 *   npm run eval -- --model claude        Claude, with ANTHROPIC_API_KEY from .dev.vars (never printed)
 *   npm run eval -- --update              writes the scores as the new baseline
 *   npm run eval -- --compare threshold=0.2      before and after a deliberate change
 *   npm run eval -- --model claude --compare prompt=eval/variant.txt
 *                                         adds the file's text to her instructions (Claude only)
 *   npm run eval -- --compare length=concise
 *
 * Exits with 1 when a score falls below the baseline.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { claudeAnswerModel, claudeClassifier } from "../server/ai-model";
import { METRICS, regressions, runEval, type EvalOptions, type Report, type Scores } from "../eval/harness";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf("--" + name);
  return i < 0 ? undefined : (args[i + 1] ?? "");
};
const which = flag("model") ?? "stand-in";
const baselinePath = `eval/baseline.${which}.json`;

async function options(change?: string): Promise<EvalOptions> {
  const out: EvalOptions = {};
  let adjust: ((s: string) => string) | undefined;
  if (change) {
    const [key, value] = change.split("=");
    if (key === "threshold") out.threshold = Number(value);
    else if (key === "length") out.length = value as EvalOptions["length"];
    else if (key === "prompt") {
      const extra = await readFile(value, "utf8");
      adjust = (system) => system + "\n" + extra.trim();
    } else throw new Error(`Unknown change "${change}": use threshold=, length= or prompt=.`);
  }
  if (which === "claude") {
    let key: string | undefined;
    try {
      key = parseEnv(readFileSync(".dev.vars", "utf8")).ANTHROPIC_API_KEY?.trim();
    } catch {
      key = undefined;
    }
    if (!key) throw new Error("Add ANTHROPIC_API_KEY to .dev.vars to evaluate Claude.");
    out.model = claudeAnswerModel(key, { adjustSystem: adjust });
    out.classify = claudeClassifier(key);
  } else if (adjust)
    console.log("Note: the stand-in doesn't read her instructions, so a prompt change can't move its scores.");
  return out;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
function print(report: Report, title: string) {
  console.log(`\n${title}: ${report.cases} golden cases, model ${report.model}`);
  for (const m of METRICS) console.log(`  ${m.padEnd(14)} ${pct(report.scores[m]).padStart(7)}`);
  console.log("  by category:");
  for (const [c, x] of Object.entries(report.byCategory))
    console.log(`    ${c.padEnd(14)} ${String(x.passed).padStart(3)}/${x.cases}`);
}

const compare = flag("compare");
const before = await runEval(await options());
print(before, compare ? "Before" : "Scores");
if (compare) {
  const after = await runEval(await options(compare));
  print(after, `After (${compare})`);
  console.log("\nChange:");
  for (const m of METRICS) {
    const d = after.scores[m] - before.scores[m];
    console.log(`  ${m.padEnd(14)} ${pct(before.scores[m]).padStart(7)} → ${pct(after.scores[m]).padStart(7)}  ${d === 0 ? "" : (d > 0 ? "+" : "") + (d * 100).toFixed(1)}`);
  }
  try {
    const down = regressions(after, JSON.parse(await readFile(baselinePath, "utf8")));
    console.log(
      down.length
        ? `\nThis change would fail the build: ${down.map((r) => r.metric).join(", ")} fell below the baseline.`
        : "\nThis change wouldn't fail the build.",
    );
  } catch {
    // No baseline yet.
  }
}
await mkdir("eval/reports", { recursive: true });
await writeFile(`eval/reports/${new Date().toISOString().replace(/[:.]/g, "-")}-${which}.json`, JSON.stringify(before, null, 2));

if (args.includes("--update")) {
  await writeFile(baselinePath, JSON.stringify(before.scores, null, 2) + "\n");
  console.log(`\nBaseline written: ${baselinePath}`);
} else {
  let baseline: Partial<Scores> | null = null;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  } catch {
    console.log(`\nNo baseline yet for ${which}: run with --update to record one.`);
  }
  if (baseline) {
    const down = regressions(before, baseline);
    if (down.length) {
      console.log("\nRegressions against the baseline:");
      for (const r of down) console.log(`  ${r.metric}: ${pct(r.baseline)} → ${pct(r.now)}`);
      process.exitCode = 1;
    } else console.log(`\nNo regressions against ${baselinePath}.`);
  }
}
if (before.failures.length) {
  console.log(`\n${before.failures.length} golden cases failed:`);
  for (const f of before.failures) console.log(`  ${f.id}: ${f.outcome}, ${f.why}`);
}

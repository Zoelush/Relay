import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GOLDEN } from "../eval/golden";
import { regressions, runEval, type Scores } from "../eval/harness";

/** The evaluation harness (phase 08, C1; docs/AI_STEP10.md): the build fails on a regression. */
test("the golden set: at least 200 cases, covering every category the brief asks for", () => {
  assert.ok(GOLDEN.length >= 200, `${GOLDEN.length} cases`);
  const categories = new Set(GOLDEN.map((c) => c.category));
  for (const c of ["answerable", "unanswerable", "ambiguous", "multi-turn", "out-of-scope", "hostile", "multilingual", "escalation"])
    assert.ok(categories.has(c as never), c);
  assert.equal(new Set(GOLDEN.map((c) => c.id)).size, GOLDEN.length, "ids are unique");
});

test("Zoe (the stand-in) scores no lower than the committed baseline; a deliberately weaker gate is caught", async () => {
  const baseline = JSON.parse(await readFile("eval/baseline.stand-in.json", "utf8")) as Scores;
  const report = await runEval();
  assert.equal(report.cases, GOLDEN.length);
  assert.deepEqual(
    regressions(report, baseline),
    [],
    `regressions: ${JSON.stringify(regressions(report, baseline))}; failures: ${report.failures.map((f) => f.id).join(", ")}`,
  );
  // The demo: a deliberate change (a much lower confidence threshold) makes her answer what she
  // shouldn't, and the harness says which scores fell.
  const weaker = await runEval({ threshold: 0.2 });
  const fell = regressions(weaker, baseline).map((r) => r.metric);
  assert.ok(fell.includes("refusal"), `fell: ${fell.join(", ")}`);
  assert.ok(weaker.scores.refusal < report.scores.refusal);
});

# Phase 08, step C1: The evaluation harness

Branch `ai/c1-eval`. Plan: `docs/AI_PLAN.md` (decision 13). Built against the offline stand-in, as asked. The Claude run waits for an `ANTHROPIC_API_KEY` in `.dev.vars`. Next: C2, the review queue and monitors.

## What it does

**The golden set** (`eval/golden.ts`, 200 cases) asks against fixed knowledge (`eval/knowledge.ts`): Fernhill Cycles, a fictional bike shop with 24 articles, four of them also in French, Spanish, German, Portuguese, Italian and Dutch. Scores therefore move only when Zoe does.

| Category | Cases | Expected |
|---|---|---|
| Answerable | 68 | Answered from the right article, with the right fact |
| Multilingual | 24 | The same, in the customer's language |
| Multi-turn | 16 | A follow-up answered from what came before |
| Unanswerable | 30 | "I couldn't find an answer" (in the shop's world, not in the content) |
| Out-of-scope | 20 | "I couldn't find an answer" (nothing to do with the shop) |
| Ambiguous | 8 | A clarifying question |
| Hostile | 20 | Nothing of her instructions, links or injected text gets out, and only the right article is cited |
| Escalation | 14 | Handed to the team (asking for a person in her languages, or upset) |

**Simulated customers** (six scripted conversations) run through the real reply job, each reacting to what Zoe last said:
- a vague question, then the option she offers
- two questions she can't answer, then a handover
- an answer, then asking for a person
- an answer that helped, resolved
- French, then a short reply that stays French
- a greeting, then a real question

**The scores:**

| Score | What it measures |
|---|---|
| Correctness | Answerable, multilingual and multi-turn cases fully right |
| Groundedness | Of every answer she gave, the share citing an article that answers the question |
| Refusal | Refused exactly when nothing answers the question |
| Escalation | Handed over exactly when she should |
| Clarification | Ambiguous cases met with a clarifying question |
| Safety | Hostile cases with nothing leaked |
| Simulated | Scripted conversations ending where they should |
| Overall | Every golden case passing |

**The stand-in's baseline** (`eval/baseline.stand-in.json`, committed):

| Correctness | Groundedness | Refusal | Escalation | Clarification | Safety | Simulated | Overall |
|---|---|---|---|---|---|---|---|
| 99.1% | 92.5% | 93.7% | 99.5% | 100% | 100% | 100% | 94.5% |

Its 11 failures are its known limits, not regressions. Matching by shared words, it answers some unanswerable questions from a loosely related article ("Do you sell tandem bikes?"). Claude should do better; the harness will show by how much.

**Failing the build:** `npm test` runs the whole evaluation (about seven seconds). A score below the baseline fails it, and the message names the metric and the failing cases. A better result is recorded with `npm run eval -- --update`.

**Before and after a deliberate change:** `npm run eval -- --compare <change>` runs twice and prints both sets of scores, the difference, and whether the change would fail the build.
- **`threshold=0.2`:** a much weaker confidence gate. This is the demo for the stand-in, which doesn't read her instructions:

  | Score | Before | After |
  |---|---|---|
  | Groundedness | 92.5% | 80.7% |
  | Refusal | 93.7% | 82.3% |
  | Safety | 100% | 90% |
  | Simulated | 100% | 83.3% |
  | Overall | 94.5% | 84.5% |

  It reports "This change would fail the build". `tests/eval.test.ts` checks that the harness catches it.
- **`length=concise`:** her answer length.
- **`prompt=<file>`** (with `--model claude`): adds the file's text to her instructions. This is the brief's acceptance demo once a key is there.

**With Claude:** `npm run eval -- --model claude` reads the key from `.dev.vars` (never printed). It uses Claude for answers and classification; reranking stays the stand-in, since Workers AI isn't reachable locally. Record a baseline with `--update`, then compare a prompt change.

Each run writes a full report to `eval/reports/` (not committed).

**Found and fixed by the harness:** short French, Spanish and German questions without many function words ("Combien de jours prend la livraison standard ?") weren't recognised, so Zoe answered in English. Multilingual scored 16/24. Language detection now:
- counts a word of four letters or more that only one language uses ("combien", "cuántos", "dauert") twice
- accepts one such word in a message of three words or more
- knows common question words in each language

Multilingual is now 24/24, and Z2's tests still pass (single words like "Merci" stay undetermined).

## How it works

**`eval/harness.ts` (`runEval`):**
- **Setup:** an in-memory database with the knowledge, indexed.
- **The golden set:** each case goes through `previewAiReply`, the Playground's path through `decide()`, which writes nothing. It now accepts earlier turns (`history`, up to 10) and returns the cited record ids.
- **The simulations:** run through `runAiReply` with real conversations.
- **`regressions`:** compares a report with a baseline.

**Elsewhere:**
- `scripts/eval.ts` is the command.
- `claudeAnswerModel` takes `adjustSystem`, for the prompt comparison only.

## Not included

- **No migration and no seed:** no schema change. The knowledge lives in `eval/knowledge.ts`.
- **No browser test:** C1 has no interface. Its end-to-end coverage is the evaluation itself (every case runs Zoe's real decision; the simulated customers run the real reply job), and the browser suite still passes.
- **Grading answers with Claude Haiku** (decision 2) isn't built yet. Correctness is scored by required facts and cited articles, which is deterministic and enough for regressions. A graded score fits C2's review queue.
- **Running the evaluation against Claude in the deployed pipeline:** not until there's a deployment.

## Checks

Results on 12 October 2026:
- `npm test`: 125/125 pass, including the evaluation's regression gate.
- `npm run typecheck`: clean.
- Lint on the changed files: clean.
- `npm run test:e2e`: 108/108 pass.
- `npm run test:postgres`: passes.
- `npm run eval`: no regressions.
- `npm run eval -- --compare threshold=0.2`: would fail the build, as above.

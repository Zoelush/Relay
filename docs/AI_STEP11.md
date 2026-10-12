# Phase 08, step C2a: The review queue

Branch `ai/c2a-review`. Plan: `docs/AI_PLAN.md` (decision 14). Behind `zoe_review_v1`, off by default and on for the local relay. Next: C2b, monitors and incidents.

## What it does

**Analyze › Review** (for those who manage Zoe) lists answers she gave from content, for a lead to rate. Answers join the queue two ways:
- **Pushed back on:** the customer's next message after her answer made her hand over because they asked for a person (in words or with the button) or seemed upset. These join within a sweep, always, and are listed first.
- **Sampled:** once a UTC day is over, a random handful of that day's answers join. The number is set on the page, 10 by default, from 0 to 50; 0 stops sampling. Each day is sampled once, however often the sweep runs.

Only answers from content are reviewed. Handovers, "I don't know" and clarifying questions aren't: those already show on Performance and Knowledge gaps.

**Each answer shows:**
- why it's there ("Customer asked for a person next", "Customer seemed upset next", or "Sampled")
- when, the conversation, the specialist and the language
- the customer's question, Zoe's reply and the sources she cited

**Rating:**
- **Good or Bad.** A Bad rating needs what was wrong: wrong, incomplete, content missing, content outdated, tone or wording, or shouldn't have answered. A note is optional.
- **Once.** If two people rate the same answer, the second is told it's already rated and sees the first rating.

**Content gaps:**
- **Created by** a Bad rating for missing or outdated content. The gap holds the question, her answer and the note.
- **Listed in:**
  - **Knowledge gaps,** under "Found in review." Each gap can be marked fixed, optionally naming the content that fixed it, or dismissed.
  - **Content health's "Topics with no content":** filled for the first time, grouped by question, with reviewers' notes, while the review queue and Zoe are on.

**The page also shows:**
- the share rated good, and how many were rated bad, over 30 days
- what was wrong, by reason
- how many answers are waiting

The Overview has a Review card with answers waiting and open gaps.

**Reviews are internal.** They live in their own tables and never reach a conversation, the messenger or any customer.

## How it works

**Migration `0052_zoe_review`** (additive):
- **`ai_agents.review_sample`**
- **`ai_review_days`:** one row per sampled day, written before the sample, so a retried or concurrent sweep can't sample a day twice.
- **`ai_reviews`:**
  - one per answer, its id derived from the answer's
  - a check that a bad rating has a problem and anything else has none
- **`ai_content_gaps`:**
  - one per review
  - a version for concurrent changes
  - a record named only when fixed
- **The flag.**
- **The rollback** turns the flag off and keeps the ratings and gaps.

**`server/zoe-review.ts`:**
- **`sampleForReview`:** run by the scheduled sweep in `workers/relay.ts` and the local relay's maintenance loop.
  - **Pushbacks:** an escalated answer with the trigger `asked_for_person` or `negative_sentiment` in the last two days, whose previous decision in the conversation was an answer from content.
  - **The sample:** the previous UTC day, once.
- **`readReview` and `changeReview`:** the page and its changes (rate, sample size, gap status), idempotent by key.
- **`reviewedGaps`:** the gaps on Knowledge gaps.
- **`reviewedGapsPort`:** `ContentGapsPort` for content health.

**Routes:**
- `GET /v1/agent/zoe?view=review`
- `POST /v1/agent/zoe-review`, also allowed in `server/agent-bridge.ts`

**In the agent app:** `agent/zoe-review.tsx` holds the page and "Found in review." Zoe's menu lists Review only while the flag is on.

**Seed:** the local relay turns the flag on. The queue fills from real conversations, since a seeded rating would need a seeded answer.

## Not included

- **Scoring answers with Claude Haiku** (decision 2): every answer could carry a model's score and reasons. It waits for a key; without one it would be a fake score.
- **Reviewers assigned to teammates' conversations, scorecards and an issue list:** that's conversation quality review, which `docs/BUILD_PHASES.md` places before phase 14.
- **Topics found automatically:** content health's "Topics with no content" lists only what reviewers found. Clustering customer questions is phase 14's (TODO in `server/knowledge-health.ts`).
- **Turning a bad answer into a golden case:** a rated answer could become a case in `eval/golden.ts`. That's left for when there's real traffic to learn from.

## Checks

- **`tests/zoe-review.test.ts`:**
  - off by default
  - pushbacks of both kinds, and not after "I don't know"
  - sampling once a day, and size 0
  - the page's order and content
  - managers only
  - another workspace's answers can't be seen or rated
  - every validation
  - rated once, with an idempotent replay
  - a gap only for content problems
  - the gap on Knowledge gaps, the Overview and content health
  - fixed, stale versions, dismissed and reopened
  - nothing a reviewer wrote in any conversation
  - the rollback
- **`tests/browser/zoe-review.spec.ts`** (ports 9016 and 9017):
  - **Happy path:** a customer asks in the messenger, gets Zoe's answer and presses "Talk to a person." The answer appears on the Overview and in the queue, is rated bad for missing content with a note, appears on Knowledge gaps, and is marked fixed.
  - **Failure path:** two people rate the same answer, and the second is told it's already rated.

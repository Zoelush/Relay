# The paired test workspace, T2a: promoting a change back

Branch `feature/test-workspace-promote`. Plan: `docs/TEST_WORKSPACE_PLAN.md`. Follows T1b
(`docs/TEST_WORKSPACE_STEP2.md`). Migration `0103_promotions.sql`.

## Decisions (asked, 14 November 2026)

1. **Versioned things first.** Only what publishes as a version can be promoted, so production
   keeps what it had and can go back to it. T2a does **workflows and Zoe's guidance**. The
   messenger and a help centre's look are T2b, once the images they refer to can come with them —
   the copy doesn't bring `brand_assets`, so those two configurations in a test workspace point at
   images that aren't there.
2. **A conflict is refused, and says what differs.** If production's copy has changed since the
   pair was last in step, the promotion stops. Relay cannot know which of the two is the one they
   meant to keep.
3. **A missing dependency is refused, and lists what's missing.** A workflow that assigns to a team
   production hasn't got, guidance written for a specialist only the test workspace has.
4. **Every promotion is recorded:** a ledger of what changed, and the audit log.

## What it does

In the test workspace, Settings › General gains **Promote to production**: a line per promotable
object with the server's own words about it, and a Promote button only where there is nothing in
the way. In production the same place gains **Promoted from the test workspace**: what arrived,
from where, by whom and as which version.

A promotion is an ordinary publish in production, by the teammate who asked for it:

- a **workflow** becomes the next `workflow_versions` row and goes live, with its draft matching
  what is live, exactly as publishing there leaves it. A workflow the test workspace invented is
  created in production first, then published the same way.
- **Zoe's guidance** becomes the next `ai_guidance_versions` row, with her voice on the agent, as a
  save on her Guidance page would.

So production can always go back: the version that was live before is still there.

## The two version numbers

`test_baselines` (in the **production** workspace) holds, per object, the two version numbers the
pair was last in step at — production's and the test workspace's. The copy gives the test workspace
production's numbers, so a fresh baseline has both the same, and from then on the two counters run
on independently.

- **changed here** is the test workspace's version above `from_version`.
- **changed in production** is production's version above `version` — and that is a refusal.
- **a promotion moves the mark forward**, in the same transaction as the change it writes. That is
  why the baselines live on production's side: otherwise a promotion would look like somebody's
  edit in production the next time, and the object could never be promoted again.

## Refusing, in its own words

| What the card says | Why |
| --- | --- |
| Nothing has changed here since the two were last in step | nothing to promote |
| Publish it in the test workspace first | what is promoted is what you tried, never a draft |
| It changed in production since the two were last in step | promoting would overwrite that change |
| Production is missing something this needs | with each missing thing named |
| Another workflow in production is already called … | a name is a workflow's own, and production's is not taken |

The page decides none of this: it renders what `GET promotable` answered, and a promotion is judged
again in the transaction that writes, so what the page showed cannot have gone stale.

## One definition of what a workflow needs

`references` in `server/workflows.ts` — the check publishing already makes — is now exported as
`workflowReferences` and asked of the workspace a promotion would land in. Guidance is checked the
same way, against production's brands and specialists, by `validGuidelines` itself.

## Checks

- **`tests/promote.test.ts`:** a pair made from a production workspace that has a live workflow, a
  help centre and a published messenger — so the baselines T2b will read are proved too. Then:
  nothing to promote in a fresh pair; only from a test workspace, and only for a manager; a change
  tried there promoted as version 2 with version 1 still in place; the ledger, the audit row, and
  the ledger's append-only trigger; promoting again refused; production moving on refused with
  production keeping what it had; a missing team refused with the sentence naming it and nothing
  half-made in production; the same workflow arriving live once the team is there; a name already
  used refused; and Zoe's guidance promoted as a version, then refused for a specialist production
  hasn't got.
- **`tests/browser/test-workspace.spec.ts`:** a third case end to end — two workflows published in
  the pair, the card showing which can go and what the other needs, Promote landing it live in
  production, and production's own record of where it came from.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

**T2b:** the messenger and a help centre's look, with the uploaded images they refer to. **T3:** the
developer sandbox (phase 15's D6) on the same pairing.

# Phase 08 — The AI agent: plan

Branch per step, behind `ai_agent_v1` (off by default; on for the local relay). Brief: `docs/BUILD_PHASES.md` phase 08, with the additions from `docs/INTERCOM_GAP_AUDIT.md`. Approved on 3 October 2026 ("Yes, go ahead with all four").

| Step | Scope |
|---|---|
| **A1: Answering core** | Hybrid retrieval (keyword and vector, fused and reranked), filtered by language, brand, audience and availability before ranking. The model ports. Answers only from retrieved passages, with every sentence citing one, and sources shown to the customer. A hard "I don't know, would you like a person?" below a relevance threshold. Clarifying questions. Replies in the messenger. Customer and article text always treated as data. |
| **A2: Escalation and handover** | Escalation rules (data conditions) separate from escalation guidance (natural language). Triggers: asking for a person, two failed answers, negative sentiment, never-handle topics, humans-only segments, office hours. A handover summary part, then routing (phase 06). Out-of-hours behaviour. The AI conversation state (pending, resolved, needs teammate input, escalated) and inbox views by it. |
| **A3: Resolution ledger** | "That helped" in the messenger. Resolution after a quiet window when the conversation was never escalated. One ledger row per resolution (conversation, answers, rule, time), reconcilable by a person reading the thread; billing (phase 16) reads it. |
| **B1: Configuration** | Several agents (for example service and sales). Each has: identity per brand; versioned guidance with channel selectors (shapes language and decisions, never grants powers); content targeting (an article is used only if the customer passes both its help center audience and the agent's); language detection with an allowlist and fallback; formality and answer length. Settings pages. |
| **B2: Safety and privacy** | A hostile-content corpus. Guarantees against disclosing other customers' data, internal content or the system prompt. Redaction of personal data before the model provider (workspace setting), with an audit of what was sent. Memory across a customer's conversations behind a workspace switch (off by default), recorded on the conversation. |
| **C1: Evaluation harness** | A golden set of 200 or more cases (answerable, unanswerable, ambiguous, multi-turn, out-of-scope, hostile, multilingual). Scores for groundedness, correctness, refusal and escalation. The build fails on regression. Simulated-customer tests. The acceptance demo: scores before and after a deliberate prompt change. |
| **C2: Review queue and monitors** | Leads sample and rate real answers; bad ones go to a content gap list, feeding content health. Monitors that alert on sharp changes in behaviour, with an incident view. |

Acceptance criteria (phase brief):
- eval scores before and after a deliberate prompt change (C1)
- the agent correctly refusing a question the knowledge store can't answer (A1, `tests/browser/ai-agent.spec.ts`)

## Decisions

1. **Seven steps,** in the order above.
2. **Models:**
   - **Answering:** Claude through Anthropic's API, Claude Sonnet 5.5, behind `AnswerModel`.
   - **Classification and grading:** Claude Haiku 4.5, from A2 and C1.
   - **Reranking:** Workers AI `bge-reranker-base`, behind `RerankPort`.
   - **The key:** `ANTHROPIC_API_KEY`, a Worker secret (`.dev.vars` locally), never committed.
   - **Locally and in tests:** deterministic stand-ins, so tests need no network.
   - **C1's acceptance demo** needs a real key to be meaningful. The user hasn't confirmed one yet; ask again at C1.
3. **The "I don't know" gate is code:**
   - weak retrieval never reaches the model
   - an answer sentence citing no given passage turns the reply into "I don't know"
   - C1 calibrates the threshold on the golden set
4. **Email, SMS and voice** (per-channel formatting, spam filtering, human-in-the-loop email drafts) are interfaces with TODO(phase 12), since those channels don't exist yet.

Handoffs: `docs/AI_STEP1.md` (A1).

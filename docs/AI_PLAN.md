# Phase 08 — The AI agent: plan

Branch per step, behind `ai_agent_v1` (off by default; on for the local relay). Brief: `docs/BUILD_PHASES.md` phase 08, with the additions from `docs/INTERCOM_GAP_AUDIT.md`. Approved on 3 October 2026 ("Yes, go ahead with all four").

| Step | Scope |
|---|---|
| **A1: Answering core** | Hybrid retrieval (keyword and vector, fused and reranked), filtered by language, brand, audience and availability before ranking. The model ports. Answers only from retrieved passages, with every sentence citing one, and sources shown to the customer. A hard "I don't know, would you like a person?" below a relevance threshold. Clarifying questions. Replies in the messenger. Customer and article text always treated as data. |
| **A2a: Handover** (A2 split on 3 October 2026) | Triggers: asking for a person (a button or in words), failed answers, negative sentiment, office hours. A handover summary note for teammates, then routing to a handover team (phase 06). Out-of-hours behaviour (reply time, take a message, keep answering). The AI state (pending, escalated, needs teammate input) with an inbox view and filter. Settings › AI agent. |
| **A2b: Escalation rules and guidance** | Escalation rules (data conditions on person, company or conversation; humans-only segments), never-handle topics, and escalation guidance (natural language), with their Settings sections. |
| **A3: Resolution ledger** | "That helped" in the messenger. Resolution after a quiet window when the conversation was never escalated. One ledger row per resolution (conversation, answers, rule, time), reconcilable by a person reading the thread; billing (phase 16) reads it. |
| **Z1: Zoe's home, and colour across Relay** (B1 split on 4 October 2026) | The agent becomes Zoe: her own place in the icon strip and side menu (Overview, Train, Test, Deploy, Analyze, Settings), an Overview of her numbers, gaps and articles, a Playground that runs her real decision and writes nothing, her identity per brand (name, avatars, disclosure, greeting) on her replies, inbox views With Zoe and Escalated by Zoe; colour across the agent app (tinted strip, menus, Settings tiles, avatars) as tested tokens. |
| **Z2: How Zoe answers** | Tone of voice, answer length, formality, language detection with an allowlist and fallback, and versioned answer guidance in categories (with channel selectors; it never grants powers), all tried in the Playground. |
| **Z3a: Specialists** (Z3 split on 4 October 2026) | Several Zoes with their own job, keywords and conditions, knowledge (collections, websites, snippets, files; filtered before ranking), guidance and handover team; picked by conditions and keywords in code, then the classifier; kept for the conversation; customers always see Zoe. |
| **Z3b: Content targeting** | Conditions on articles, snippets, files and websites: Zoe uses an item only for customers who pass both its targeting and the specialist's scope. Zoe only; the help center keeps its own visibility. |
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

5. **A2a decisions** (3 October 2026):
   - A2 is two steps
   - a failing classifier leaves the agent answering with A1's safeguards rather than handing everything over
   - Settings › AI agent starts in A2a (B1 adds to it)
   - migration 0044 adds the AI state, handover settings and the escalation rules table

6. **A2b decisions** (3 October 2026):
   - topic keywords are always checked in code, as a safety net when the model is down
   - limits: 20 rules, 20 topics, 10 guidance items of 500 characters
   - three sections on Settings › AI agent, saved and versioned with the page
   - migration 0045 stores topics and guidance on the agent
   - email-domain rules use verified addresses only

7. **A3 decisions** (3 October 2026):
   - a handover within the resolution window reverses a resolution (a reversal row); after it, the resolution stands
   - "That helped" only under answers from content
   - windows of 1, 4, 12, 24, 48 or 72 hours, default 24
   - migration 0046 adds the append-only ledger

8. **Z1 decisions** (4 October 2026, after scoping Beacon's and Intercom's agents read-only):
   - B1 is three steps (Z1–Z3)
   - Zoe's signature is teal to emerald (the user's choice over violet to rose)
   - Settings › AI agent moves into Zoe's area
   - the Playground runs real model calls when deployed
   - the agent named "AI agent" becomes Zoe

9. **Z2 decisions** (4 October 2026):
   - **Tones:** Friendly (default), Professional, Matter-of-fact, Empathetic, Playful.
   - **Formality:** "usual for each language" (default), formal or informal. It covers her answers and her fixed messages.
   - **Languages:** her fixed messages in the messenger's nine languages (Italian, Dutch, Arabic and Brazilian Portuguese added).
   - **Detection:** in code; a browser setting alone never hands over.
   - **Spam guidance:** only makes her leave a message alone.
   - **Targeting:** guidance targets audience and brand; channels wait for phase 12.
   - **Running locally:** the demo uses Claude when `.dev.vars` has `ANTHROPIC_API_KEY`; tests keep the stand-ins.
   - **Migration:** 0048.

10. **Z3 decisions** (4 October 2026):
    - **Two steps:** Z3a (specialists), then Z3b (content targeting).
    - **Customers always see Zoe;** teammates see "Zoe · Billing".
    - **Routing:** conditions and keywords in code, then the classifier by what she handles; the choice is kept for the conversation, and a greeting doesn't settle it.
    - **Outside her knowledge** she doesn't know, then hands over to her own team.
    - **Limit:** up to 10 specialists.
    - **Z3b's targeting** applies to Zoe only.
    - **Migration:** 0049.

11. **Z3b decisions** (4 October 2026):
    - **Websites:** targeted as a whole, copied onto their pages as their audience is.
    - **Each answer records** what targeting left out, for teammates (the Playground and "Why this reply").
    - **The rollback** switches Zoe off for targeted content.
    - **No new conditions:** contact and company attributes wait for phase 01.
    - **Migration:** 0050.

Handoffs: `docs/AI_STEP1.md` (A1), `docs/AI_STEP2.md` (A2a), `docs/AI_STEP3.md` (A2b), `docs/AI_STEP4.md` (A3), `docs/AI_STEP5.md` (Z1), `docs/AI_STEP6.md` (Z2), `docs/AI_STEP7.md` (Z3a), `docs/AI_STEP8.md` (Z3b).

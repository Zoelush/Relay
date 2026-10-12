# Phase 09: AI actions and data connectors (plan)

Brief: `docs/BUILD_PHASES.md` phase 09. Approved on 12 October 2026.

| Step | Scope |
|---|---|
| **D1: Connectors** | HTTP integrations: auth, templated requests from declared inputs only, responses mapped to named values, a test console with secrets masked, immutable versions pinned per conversation, an append-only audit, a rate limit. Read only. |
| **D2: Procedures** | Plain-language procedures compiled into reviewed, published plans. The verification rule table (per channel and audience, with a fallback) is checked before any connector runs. |
| **D3: Write actions** | Explicit enablement, per-call approval in the inbox, identity required, idempotency keys, a workspace kill switch. |
| **D4: OAuth and the audit view** | OAuth on behalf of the workspace, and one conversation's audit rendered readably. |

## Decisions

1. **Where it lives:** Zoe › Train › Actions and Procedures, behind `ai_actions_v1` (off by default).
2. **Credentials:** AES-GCM under `RELAY_CONNECTOR_KEY`, never returned.
3. **Calls:** only public https, through `safeRequest`. Tests use recorded fixtures (`tests/fixtures/connectors.ts`).
4. **Compiling procedures:** Claude when a key is set, otherwise an offline compiler for a numbered-steps format. Plans are always reviewed and published by a person.
5. **Verifying customers:** a website-verified sign-in only; email and SMS codes wait for phase 12.
6. **Approvals:** a card in the conversation. If nobody acts within 24 hours, the procedure is abandoned and handed over.

Handoffs: `docs/ACTIONS_STEP1.md` (D1).

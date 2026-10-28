# Phase 16, step C6b: content redaction, logs, model-provider controls

Branch `security/c6b-redaction`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 23 and 24). This is the second half of C6; C6a (retention) is `docs/SECURITY_STEP9.md`. The page is behind `security_v1`. No new dependency.

## What it does

**Settings › Security › Data protection** (for who manages security) has three cards.

**Redaction:** four built-in rules, each off until turned on.

| Rule | What it matches |
|---|---|
| Card numbers | 13 to 19 digits, spaces or dashes allowed, that pass the Luhn check |
| IBANs | A country code, check digits and 11 to 30 characters, that pass the mod-97 check |
| US Social Security numbers | `123-45-6789`, without the never-issued 000, 666 and 9xx areas, or 00 and 0000 groups |
| UK National Insurance numbers | `AB 12 34 56 C`, without the prefixes HMRC never issues |

**Custom patterns:** up to 25 regular expressions, each with a name. "Try" shows what a pattern makes of sample text without saving it. A pattern is refused, with the reason, when it:
- is empty or over 200 characters
- uses back-references (`\1`, `\k<name>`) or look-arounds
- repeats a group that itself repeats or has alternatives, such as `(a+)+` or `(a|ab)+`: the shapes that can run for ever
- isn't a valid regular expression, or matches empty text
- takes over 25 ms on any of four long hostile inputs

**A match becomes asterisks,** as long as what it replaced. Rules apply to text stored from when they're turned on. Messages already stored are append-only and aren't rewritten; the page says so.

**What Zoe sends to the model:** her two existing switches (remove personal data before sending, and memory of a signed-in customer's earlier conversations), and how many earlier messages go with each question: none, 5, or 10 (the default, as before). Each model call is recorded with the controls that applied.

## How it works

**One redactor, `lib/redaction.ts`** (shared by the server and the page's preview):
- **`checkPattern`:** the refusals above.
- **`redactor(rules)`:** `text`, `html` (only the text between tags), `json` (every string value), and `doc` (only a rich document's `text` nodes, so mentions, links and IDs stay intact).

**`server/redaction.ts`:**
- **`workspaceRedactor`:** the workspace's enabled rules, read in the caller's transaction.
- **`readDataProtection` and `changeDataProtection`:** the page's actions are `try`, `builtin`, `custom-add`, `custom-toggle`, `custom-remove` and `model`.
- **`scrubPayload`:** redacts a raw inbound payload's strings.

**Where it's applied:** where text is stored, so everything derived from it follows on its own (search, previews, notifications, webhooks, exports, the model).
- **`append` (`server/conversations.ts`):** every part's body, its subject, an email part's subject, and a rich message's document.
- **Email in (`server/email-in.ts`):** the kept email's subject, full text, HTML and headers.
- **Drafts (`server/drafts.ts`):** the document.
- **Raw inbound payloads:** SMS, WhatsApp, Meta, Slack and Discord, and voice. Each is scrubbed in the same transaction that marks it read.
- **Raw emails:** a read email's raw file was already deleted (C6a). While any rule is on, a failed email's raw file is now deleted too.

**Logs and error reports:**
- **The fix:** the two places that logged a raw error now log only `errorFingerprint`: the error's class, its SQLSTATE, and the file and line. Those places are the agent API's sign-in handling (`server/api.ts`) and the REST API's 500s (`server/rest.ts`).
- **The guard:** a test reads every `console` call in `server`, `workers`, `app`, `lib` and `scripts`, and fails on one that is given a caught error or a request body.

**The model controls:**
- **History length:** `ai_agents.history_messages` caps the earlier messages `decide()` gathers.
- **What applied:** `recordModelCalls` writes `ai_model_calls.controls` (redaction, memory, history length, how many rules were on).

**Wiring:**
- **The API:** the agent route `data-protection` (GET and POST, `security.manage`).
- **The page:** `agent/settings-data-protection.tsx` (`#settings/data-protection`).
- **Access:** the page is listed by `settingsOverview` for `security.manage` with `security_v1`.

**Migration `0089_redaction`:**
- **New:** `redaction_rules` (built-in or custom; one row per built-in), with row-level security and the audit trigger. The audit log uses the noun "Redaction rule" in the Data area.
- **Changed:** `ai_agents.history_messages` (0, 5 or 10, default 10) and `ai_model_calls.controls`.
- **Its rollback** turns every rule off and sets history back to 10. Text already redacted stays redacted.

`redaction_rules` holds no one's personal data, so it's listed in `NO_PERSONAL_DATA` (`server/erasure.ts`).

**Seed data:** none. Every rule is off by default.

**Out of scope:** attachments and knowledge articles aren't scanned for patterns (the C6 choice).

## Checks

- **`tests/redaction.test.ts`:**
  - **The detectors:**
    - Valid numbers are found and invalid ones are left alone: Luhn and mod-97 failures, never-issued SSN areas, and invalid NI prefixes, `QQ` included.
    - The length is kept.
    - HTML attributes and a document's mentions are untouched.
  - **`checkPattern`:** every refusal, and a pattern that's allowed.
  - **Stored text:**
    - **Off by default.** A preview saves nothing, and an unsafe pattern is refused with its reason.
    - **With cards and a custom pattern on:**
      - A new message's body and its search document are redacted, and so is a reply.
      - The earlier message isn't rewritten.
      - Another workspace's identical message isn't touched.
    - **A draft's document** is redacted.
    - **An email:** its subject, full text, headers, part and part subject are redacted, and its raw file is gone.
    - **A failed email's** raw file is deleted.
    - **A read SMS payload** is scrubbed, and a source check confirms that every channel's read scrubs.
    - **Changes** are in the audit log.
  - **Zoe:**
    - A history length of 3 is refused.
    - At 0 she's sent no earlier messages, and the call's controls are recorded.
    - At 5 she's sent at most 5.
  - **Patterns:** a custom pattern is toggled and removed, and another workspace can't reach it.
  - **Permissions:** an agent gets 403, and another workspace's owner sees only their own rules.
  - **Rollback:** rules are off and history is back to 10. New text is stored as written, and redacted text stays redacted.
  - **Logs:** the `console` guard.
- **`tests/browser/data-protection.spec.ts`:**
  - **Happy path:** a manager turns on card numbers, tries a custom pattern and adds it. A customer's message with a card and an account number then shows only asterisks in the inbox.
  - **Failure path:** `(a+)+$` is refused with the reason. An agent doesn't see the page, and the API answers 403.
- **`tests/permissions-matrix.test.ts`** covers `data-protection`. **`tests/erasure.test.ts`** passes, with `redaction_rules` listed.

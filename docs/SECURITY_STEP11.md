# Phase 16, step C7a: link safety and risky merges

Branch `security/c7-posture`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 25 and 26). C7 was split, as asked: this is C7a. C7b covers vendor support access, the security health check, and the subprocessor and encryption pages. Both pages are behind `security_v1`. No new dependency.

## What it does

### Link safety

**Settings › Security › Links** (for who manages security):
- **Trusted domains and blocked domains,** up to 200 each. A domain covers its subdomains, and adding a domain to one list takes it off the other.
- **The workspace's own websites** (each brand's allowed messenger websites) are trusted by default and shown apart. Blocking one overrides that.
- **Whether a reputation lookup is set up.**

**Links customers send become clickable in the inbox,** and each click goes through a gate. The server judges the link at that moment, so a list change applies at once.

| Verdict | When | What the teammate sees |
|---|---|---|
| Blocked | The domain is on the blocked list | "Link blocked". It can't be opened from Relay. |
| Malicious | The reputation lookup flagged it, or a check in code did | "Dangerous link", with the reasons. "Open link" works only after ticking "I understand the risk". Opening it is in the audit log (the host, not the address). |
| Trusted | On the trusted list, or one of the workspace's own websites | It opens straight away. |
| Untrusted | Anything else | "Check this link", with the full address, then "Open link". |

**The checks in code** flag:
- a bare IP address as the host
- a punycode (lookalike) host
- a user name in the address (`bank.example@evil.example`)
- link text naming a different website from the one the link opens (in an email's HTML)
- a download of a program (`.exe`, `.msi`, `.apk`, `.dmg` and the like)

**Emails:** links in an email's HTML open Relay's gate page, `/link`, in a new tab. The page shows the same verdict and the same choices.

**Outgoing:** a teammate's reply or note with a link to a blocked domain is refused: "Links to cdn.blocked.example are blocked in this workspace."

### Risky merges

Two switches on **Settings › Security › Data protection**, both off by default.

**Merging conversations of different people.**
- **Before:** such merges were always refused.
- **With the switch on:** the merge must also be confirmed (`acrossPeople: true`). Without that, it's refused with the warning: both people become participants, so each sees the whole conversation, the other's messages included. The brand must still match.
- **Audit:** the merge is in the audit log, with both contacts.
- **Where it's done:** the inbox has no merge action yet, so this is the command's rule.

**Merging a messenger lead into the user with the same email.**
- **With the switch on,** when a lead writes in the messenger, they join the only user with that email (case-insensitive).
- **When it doesn't happen:** no user, more than one user, or a channel's sender (only the messenger's unverified customers).
- **Reversal and audit:** the merge can be reversed, like every contact merge, and it's in the audit log.
- **The lead's device stays unverified,** so it still sees only its own conversations, never the user's.

## How it works

**`lib/links.ts`** (shared by the server and the inbox):
- **Finding links:** `findLinks` (http, https and `www.` addresses in text, at most 20) and `anchorsIn` (an email's anchors and their text).
- **Checks:** `codeReasons` (the checks in code) and `policyDomain`.
- **The verdict:** `verdictOf` is the only place a verdict is decided: blocked, then malicious, then trusted, then untrusted.

**`server/link-policy.ts`** (used by `append` and email in, apart from the conversations module):
- **`linkPolicy`:** the lists, plus the workspace's own websites.
- **`noteLinks`:** keeps a customer part's links in `part_links` and queues `links.check` once per part.
- **`assertLinksAllowed`:** refuses a teammate's link, in text or in a rich message's link marks, to a blocked domain.

**`server/links.ts`:**
- **`readLinks` and `changeLinks`:** the page.
- **`linkVerdict`:**
  - **What it judges:** only an address that is in that part (its text, or its email's anchors), for a teammate who can read the conversation.
  - **When opening it** (POST): a blocked link is refused (403), and a malicious one needs `acknowledged` (409 without it).
- **`linksJob`:** `links.check` looks up a part's unchecked links between transactions and keeps any threat.

**`server/link-reputation.ts`:**
- **Deployed:** Google Safe Browsing's Lookup API (`RELAY_SAFE_BROWSING_KEY`, a secret). Only the addresses are sent, and it's listed in `lib/processors.ts`.
- **Locally and in tests:** a stand-in that flags `malware.test` and `phishing.test`.
- **Without a key,** only the checks in code apply, and the page says so.

**Where it hooks in:**
- **`append`:** notes a customer's links, and checks a teammate's.
- **Email in:** notes the HTML's links.
- **The inbox:** `LinkedText` and `LinkGate` (`agent/links.tsx`) render a customer's plain text, and the email frame's links are rewritten to `/link`. The gate page is `LinkGatePage` (`agent/entry.tsx`, `app/link/`, and the local relay).

**Merges:**
- **Different people:** `command`'s merge checks `security_settings.merge_across_people` and `acrossPeople`, and records `conversation.merged_across_people`.
- **Leads by email:** `mergeLeadByEmail` (`server/people.ts`) runs after a messenger customer's start or reply, through `mergeVisitorIdentity`, and records `contact.lead_merged_by_email`.

**Wiring:**
- **Routes:** `links` (GET and POST, `security.manage`) and `link-verdict` (GET and POST, any teammate who can read the conversation).
- **The job:** `links.check`, on Workers and in the local relay.
- **The page:** `agent/settings-links.tsx` (`#settings/links`).

**Migration `0090_links_merges`:**
- **`link_policies`,** with the audit trigger (noun "Link domain").
- **`part_links`,** deleted with its conversation by `erase` (and so by retention).
- **Two `security_settings` columns,** for the merge switches.
- **Its rollback** turns both switches off. Merges already made stay, and link policies stay, since the earlier code doesn't read them.

**Seed data:** none. The lists are empty and both switches are off.

## Checks

- **`tests/links.test.ts`:**
  - **`lib/links.ts`:**
    - **Finding links:** trailing punctuation, `www.`, and the cap of 20.
    - **The checks in code:** each one, plus the cases that aren't flagged (subdomains, `www.`, plain link text).
    - **`policyDomain` and the verdict order.**
    - **`anchorsIn`:** entity decoding, and non-http links skipped.
  - **Safe Browsing:**
    - **The request:** only the addresses are sent, with the key in the query.
    - **The answer:** parsed. A failure throws, so the job retries.
    - **The stand-in** flags its two test domains.
  - **The page:**
    - **Defaults:** the own website is trusted.
    - **Changes:** adding, moving (one list per domain), an invalid domain, and removing what isn't there.
    - **Audit and access:** audited. An agent gets 403, and another workspace sees its own lists only.
  - **The lookup job:**
    - **Noting:** a customer's links are noted, with one job per part.
    - **The lookup** flags the malware link.
    - **Without a lookup,** the job skips.
  - **Each verdict:** trusted (own website, trusted list), untrusted, malicious (reputation; IP), and blocked.
    - **A list change** applies at once.
    - **Refused:** a link not in the part, and another workspace's teammate.
  - **Opening:** blocked is 403, and malicious without acknowledgement is 409. Acknowledged, it's audited with the host only.
  - **An email:** its HTML's real destination is noted, and the anchor whose text names another site is malicious ("mismatch").
  - **A teammate's links:** a blocked link in text and in a rich note is refused. A trusted one is sent, and another workspace isn't affected.
  - **Merges across people:**
    - **The switch off:** refused, naming the setting.
    - **The switch on:** without confirmation, refused with the warning. Confirmed, merged and audited with both contacts. An agent can't change the switches.
  - **Leads by email:**
    - **The switch off:** not merged.
    - **The switch on:** the lead's next message merges it into the one user with that email (case-insensitive), and it's audited.
    - **The lead's device** still can't reach the user's conversation.
    - **Reversal and ambiguity:** reversed, it's apart again. With two users having the email, it isn't merged.
  - **Rollback:** the switches are off, the merges made stay, and the lists stay.
- **`tests/browser/links.spec.ts`:**
  - **Happy path:**
    - **Setup:** a manager blocks a domain. A customer's message has an untrusted link, a stand-in malware link and a blocked link.
    - **Untrusted:** shows its address and opens in a new tab.
    - **Malicious:** opens only after the risk is ticked, and is audited.
    - **Blocked:** has no way to open.
    - **The opened tabs** are answered locally (nothing leaves the machine).
  - **Failure path:** a reply with a blocked link is refused with the reason, an invalid domain is refused on the page, and an agent doesn't see the page (the API answers 403).
- **`tests/permissions-matrix.test.ts`** covers both routes.
- **`tests/erasure.test.ts`** passes, with `part_links` in the cascade and `link_policies` listed as holding no one's data.

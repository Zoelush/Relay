# Phase 16, step C9c: usage alerts

Branch `billing/c9c-alerts`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decision 36). This completes C9 (C9a was the meters, C9b limits and the spend cap). No new dependency.

## What it does

**Alerts at thresholds:**
- **The thresholds** are percentages of each meter's limit and of the spend cap, 80% and 100% unless the workspace sets others.
- **When one is crossed,** everyone who manages billing, on a full seat, is told once per threshold per billing period:
  - **In Relay:** a "Usage alert" notification ("80% of this period's limit for emails: 8 of 10.") that opens Settings › Billing › Usage.
  - **By email:** an alert to their sign-in address (password or single sign-on), saying what crossed, what happens when a limit is reached, and where to change it.
- **Notify only:** alerts never pause anything; limits do (C9b). A meter without a limit has no thresholds to cross. The spend cap's thresholds apply once prices are set.

**Settings › Billing › Usage** gains "Alert at (% of each limit and the cap)":
- **Up to 5 whole percentages,** from 1 to 100, such as "80, 100".
- **Leaving it empty** turns alerts off.

## How it works

- **`server/usage-alerts.ts`:**
  - **`checkUsageAlerts`** runs on each sweep (Workers and the local relay), only for meters with a limit, and the cap.
    - **Reading:** it reads each total from the meters, never counting, and records each crossing in `usage_alerts`.
    - **Once per period:** that ledger is unique per meter or cap, threshold and billing period, so a second check finds nothing new.
    - **Telling people:** each new alert becomes a `usage_alert` notification for each billing manager on a full seat, and an `email.alert` (kind `usage`) to their sign-in email.
  - **`alertText`:** the words, shared by the notification and the email.
- **Thresholds:** `readLimits` and `changeLimits` (C9b) gain `alertThresholds`.
- **The email:** `sendAlert` (`server/email-out.ts`, the alert email path) gains the usage alert.
- **The notification:** `agent/notifications.tsx` gains its kind, and opening it goes to Usage.

**Migration `0096_usage_alerts`:**
- **New:** `usage_settings.alert_thresholds` (default 80 and 100), and `usage_alerts`.
- **Changed:** the `usage_alert` kinds on `notifications` and `email_alerts`, each with its own column, and the constraints updated to match.
- **Its rollback** clears every workspace's thresholds, so no alert is sent. Sent alerts and their notifications stay.

`usage_alerts` holds no one's personal data, so it's listed in `NO_PERSONAL_DATA`.

## Checks

- **`tests/usage-alerts.test.ts`:**
  - **The wording,** for a meter and the cap.
  - **No limits,** no alerts, and the default thresholds are 80 and 100.
  - **With a limit of 10:**
    - **Crossing 80%:** 7 emails is under it, and 8 crosses it, once. A second check finds nothing.
    - **Who's told:** only the owner (billing, full seat), not the agent or the admin on a limited seat. The notification is listed.
    - **The email** is sent through the alert path, with its subject, text and link to Usage, and marked sent.
    - **At 10,** 100% follows once. A later period starts afresh.
  - **Thresholds:** 0, or six of them, are refused, and an agent is refused. "100, 50, 50" is kept as 50 and 100, and 50% is then new this period. No thresholds means no alerts.
  - **Another workspace** is never told.
  - **Rollback:** thresholds are cleared and no alert is sent, while sent alerts stay.
- **The shared constraints** still hold: email-out, Zoe monitors, webhooks, accounts, mentions and erasure pass.
- **`tests/browser/usage-alerts.spec.ts`:**
  - **Happy path:** a manager sets an emails limit of 2 and an alert at 50%. With one email sent, the check tells them. The notification reads "50% of this period's limit for emails: 1 of 2.", and opening it goes to Usage.
  - **Failure path:** "80, 150" is refused with the reason, and Grace (who doesn't manage billing) isn't told.

# Agent inbox — step C3b handoff (viewing and writing indicators)

Step C3b completes step C of `docs/AGENT_INBOX_PLAN.md`. The C3a handoff is `docs/AGENT_INBOX_STEP7.md`. Step D (macros, context sidebar, bulk actions) is next.

## 1. What changed

**One routing table for live signals (`fanOutSignal`, `server/realtime.ts`).** Before, the Worker and the local relay each had their own fan-out and they disagreed. Only the Worker limited presence to teammates or flagged collisions, and neither kept a teammate's note typing from the customer. Both now call `fanOutSignal`:

| Signal | Who receives it |
|---|---|
| presence | teammates in the workspace |
| viewing | teammates subscribed to the conversation, never customers |
| a teammate typing a **note** | teammates subscribed, never customers |
| a teammate typing a **reply** | everyone subscribed; the customer's messenger shows "Someone is typing…" as before |
| customer typing | everyone subscribed |

- **Scope:** signals never reach the sender or another workspace.
- **Collisions:** teammates receive other teammates' typing marked `collision`.
- **Missing mode:** a teammate's typing without `mode: "reply"` is treated as a note, so an older or faulty client can never leak it.

**Viewing.**

- **Joining:** subscribing to a conversation announces the teammate, and every teammate already viewing is announced back to the newcomer.
- **Refreshing:** the inbox sends a `viewing` refresh every 30 seconds; the server accepts at most one per conversation every 5 seconds. An entry expires 45 seconds after its last refresh.
- **Leaving:** unsubscribing, or a closed socket through `leave()` in both the Worker and the local relay, announces the departure at once.
- **Storage:** nothing is stored; there is no migration.

**Writing.**

- **When it sends:** the composer sends "writing a note" or "writing a reply" at most every 2 seconds while typing.
- **When it stops:** after 4 idle seconds, on send, on a mode switch and on leaving the conversation.
- **Server throttle:** only *active* typing is throttled (200ms). A stop signal is never dropped and does not use up the window. Before this fix, a mode switch's stop followed at once by the new mode's signal lost the second one; the browser test found this.

**Inbox (`agent/activity.ts`, `components/relay/postgres-inbox.tsx`).**

- **Activity line:** the conversation header shows, for example, "Grace is viewing", "Grace is writing a note" or "Grace and Ada are writing replies". Names come from the directory, and screen readers announce changes politely.
- **Expiry:** entries expire on a timer, not during render, and the teammate's own other tabs are ignored.
- **Warning:** while you are in reply mode and someone else is writing a reply, an amber alert reads "Grace is also replying. Check before you send."

**Bundles.** The agent bundle grows by about 1 KB gzip (225 to 226 KB); the messenger is unchanged.

## 2. Files

| File | Change |
|---|---|
| `server/realtime.ts` | `fanOutSignal`, viewing join, refresh and leave, `leave()`, typing `mode`, throttle fix |
| `workers/relay.ts`, `scripts/local-relay.ts` | Both use `fanOutSignal` and call `leave()` on close |
| `agent/activity.ts`, `components/relay/postgres-inbox.tsx`, `agent/inbox.css` | Activity tracking, writing signal, refresh, header line, collision warning |
| `tests/signals.test.ts`, `tests/browser/collision.spec.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 37/37 pass. The signal test uses real sessions (two teammates, a customer and another workspace's teammate) wired through `fanOutSignal`. It covers every row of the table, including:
  - note typing, missing-mode typing and unknown-mode typing never reaching the customer
  - collision flags
  - no echo to the sender, and no crossing workspaces
  - join announcements in both directions, refresh throttling and expiry, and customers being unable to send viewing signals
  - departure on unsubscribe and on socket close
  - the stop-then-active regression
- **Typecheck:** clean.
- **Browser:** 20/20 pass, and the collision tests passed three consecutive runs.
  - **Happy path:** the owner and Grace see each other viewing. Grace writes a note: the owner sees "Grace is writing a note" and the customer's messenger shows nothing. Grace switches to a reply: the customer sees "Someone is typing…", and the owner, in reply mode, sees "Grace is also replying"; the warning disappears in note mode.
  - **Failure path:** Grace's tab closes mid-reply, and the owner's indicator and warning clear.

## 4. Deferred and known gaps

- **Presence** ("away" and "away and reassigning") is routed correctly, but the inbox has no control for it yet. Routing and availability belong to phase 6.
- **Writing indicators** are per teammate, not per tab. Two tabs of the same teammate each send their own signal, and other teammates see one name.
- **Hibernation:** a Worker whose Durable Object hibernates loses ephemeral state by design. Viewers reappear on their next 30-second refresh.

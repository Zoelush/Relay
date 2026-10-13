# Phase 11 acceptance demo: workflows

The brief's acceptance criteria:
1. Publish a workflow that tags, routes by language, waits for office hours, hands to the AI agent, and escalates on failure.
2. Show its run log for three different conversations.
3. Break it deliberately, and show the alert.

`tests/browser/workflow-operations.spec.ts` runs this demo end to end on every `npm run test:e2e`. To see it yourself, run `npm run dev:relay` and follow the steps below. The demo workspace already has Zoe on, a Billing team and tags; add two teams first, under Settings › Teams: French desk and English desk.

## 1. The workflow

Workflows (in the strip) › New workflow › Start from "Route by language". Choose French desk and English desk, then Create and open. In the builder:

1. **Path A:**
   - Add a step: Add a tag, Triaged (add the tag first in Settings › Tags).
   - Its branch "French" goes to B, and Else goes to C.
2. **Paths B and C** each assign to their desk. Set B's "Then" to Go to a path, and choose New path: that's D. Set C's to go to D too.
3. **Path D:**
   - Add a step: Wait until office hours.
   - Then: Let Zoe answer. Resolved goes to a new path E (End). Handed over and "If no outcome" go to a new path F.
4. **Path F:** Mark as priority, Hand to the team, and an internal note: "Zoe couldn't resolve this: escalated."
5. **Publish.** Before publishing, Test (with any conversation) shows the path it would take, and "Suppose…" shows the others.

## 2. Three conversations, and the run log

On the demo page (`http://127.0.0.1:8789`), open the messenger three times (a private window each) and write:
- **In French, asking for a person:** "Bonjour, je voudrais parler à une personne". It's tagged, routed to French desk, Zoe hands over, and it's escalated.
- **In English, asking for a person:** "Hello, I'd like to talk to a real person". Routed to English desk, then escalated.
- **A question:** "How do I change my password?". Routed to English desk; Zoe answers. The run waits for her outcome: resolved when the customer says it helped, escalated if she hands over.

Then Workflows › Run log, and filter by the workflow: the three runs, with their outcomes. Open one to see each step:
- the tag
- the branch, with the language it saw
- office hours (open: no wait; closed: it waits, and resumes when they open)
- handing to Zoe, and her outcome
- each escalation step

"Conversation" opens it in the inbox, where the timeline names the workflow for each change.

## 3. Broken on purpose

Archive the Triaged tag (Settings › Tags). Start three more conversations: each run fails at its first step, since the tag is archived. After the third:
- **The list** shows the alert: the workflow keeps failing, with 3 failed runs in a row and the last error. Its row says Failing.
- **Notifications** (the bell) has "A workflow keeps failing" for each manager. It opens the workflow's failed runs.
- **The builder** shows the alert too.

To recover, restore the tag: the next run that completes closes the alert. Or Dismiss it from the list.

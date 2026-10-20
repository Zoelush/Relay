# Metric dictionary

Generated from `lib/metrics.ts` by `npm run metrics:doc` (phase 14, R1). Edit the code, not this file: `tests/metrics.test.ts` fails if they differ.

Shared terms:
- **A conversation** is one the customer can see: back-office and tracker tickets are internal, and appear only in the ticket dataset. An outbound chat counts once the customer replies to it.
- **A teammate reply** is a public reply written by a teammate. Zoe's replies and workflows' messages are automation, counted apart.
- **Office hours** are the calendar pinned on the conversation when it started (phase 06, the one source); with none, always open. Durations are given both ways: wall-clock and office hours.
- **Periods** are in the report's timezone. A duration falls in the period of its end.
- **Snapshots:** a conversation's contact attributes are those when it started. Later edits don't change past reports. Contact name and email are the exception: they're shown as they are now.

## conversation dataset

### New conversations (`new_conversations`)

- **Formula:** Conversations started in the period.
- **Anchored to:** When the conversation started (an outbound chat: the customer's first reply).
- **Includes:** Every channel; conversations started by the customer, by email in, or by a teammate.
- **Excludes:** Internal tickets; outbound chats nobody replied to; merged-away conversations count once, as the one they joined.
- **Automation:** A conversation Zoe answered alone still counts.
- **Unit:** count

### Conversations replied to (`conversations_replied_to`)

- **Formula:** Conversations with at least one teammate reply in the period.
- **Anchored to:** Each teammate reply's time.
- **Includes:** Any channel; a conversation counts once per period however many replies it got.
- **Excludes:** Internal notes; internal tickets.
- **Automation:** Only teammates' replies count; Zoe's and workflows' don't.
- **Unit:** count

### Replies sent (`replies_sent`)

- **Formula:** Teammate replies written in the period.
- **Anchored to:** Each reply's time.
- **Includes:** Every public teammate reply, on any channel.
- **Excludes:** Internal notes; edits (a superseding part isn't a new reply); deleted replies.
- **Automation:** Only teammates' replies count; Zoe's and workflows' don't.
- **Unit:** count

### Closed conversations (`closed_conversations`)

- **Formula:** Closes in the period: each change of state to closed.
- **Anchored to:** The close's time.
- **Includes:** A conversation closed twice in the period counts twice (each cycle).
- **Excludes:** Internal tickets; outbound chats that were never replied to.
- **Automation:** Closes by Zoe or workflows count, and can be broken down by who closed.
- **Unit:** count

### Reopened conversations (`reopened_conversations`)

- **Formula:** Reopens in the period: each change of state from closed to open.
- **Anchored to:** The reopen's time.
- **Includes:** Reopens by a customer's reply or by a teammate.
- **Excludes:** Wake-ups from snooze (they were never closed).
- **Automation:** Reopens by workflows count.
- **Unit:** count

### Open at end of period (`open_at_end`)

- **Formula:** Conversations whose state at the end of the period was open.
- **Anchored to:** The period's end.
- **Includes:** Every conversation started before the end.
- **Excludes:** Internal tickets.
- **Automation:** None: a state, not an action.
- **Unit:** count

### Snoozed at end of period (`snoozed_at_end`)

- **Formula:** Conversations whose state at the end of the period was snoozed.
- **Anchored to:** The period's end.
- **Includes:** Every conversation started before the end.
- **Excludes:** Internal tickets.
- **Automation:** None: a state, not an action.
- **Unit:** count

### First response time (`first_response_time`)

- **Formula:** From the customer's first message to the first teammate reply after it; median and average, wall-clock and office hours.
- **Anchored to:** The first reply's time.
- **Includes:** Conversations with a customer message and a teammate reply.
- **Excludes:** Conversations nobody replied to (they're in 'awaiting first response'); internal tickets; teammate-started conversations before the customer wrote.
- **Automation:** Only teammates' replies count; Zoe's and workflows' don't. A conversation Zoe resolved alone has no first response time.
- **Unit:** duration

### Next response time (`next_response_time`)

- **Formula:** For each customer message after a teammate's reply, the time to the next teammate reply; median and average, wall-clock and office hours.
- **Anchored to:** Each reply's time.
- **Includes:** Every later exchange in a conversation.
- **Excludes:** The first response (its own metric); customer messages answered by nobody.
- **Automation:** Only teammates' replies count; Zoe's and workflows' don't.
- **Unit:** duration

### Time to close (`time_to_close`)

- **Formula:** From the conversation's start to its first close; median and average, wall-clock and office hours.
- **Anchored to:** The first close's time.
- **Includes:** Conversations closed at least once.
- **Excludes:** Open conversations; internal tickets.
- **Automation:** Closes by Zoe or workflows count.
- **Unit:** duration

### Time to resolve (`time_to_resolve`)

- **Formula:** From the conversation's start to its last close, for conversations closed at the end of the period.
- **Anchored to:** The last close's time.
- **Includes:** Conversations that stayed closed at the period's end.
- **Excludes:** Conversations reopened and still open.
- **Automation:** Closes by Zoe or workflows count.
- **Unit:** duration

### Reassignment count (`reassignments`)

- **Formula:** Changes of assignee from one teammate to another, in the period.
- **Anchored to:** Each change's time.
- **Includes:** Reassignments by teammates, routing and workflows.
- **Excludes:** The first assignment; unassigning.
- **Automation:** Routing and workflows count, and can be told apart.
- **Unit:** count

### First-contact resolution (`first_contact_resolution`)

- **Formula:** Of conversations first closed in the period, the share closed after at most one teammate reply and never reopened within 7 days.
- **Anchored to:** The first close's time.
- **Includes:** Conversations with a customer message.
- **Excludes:** Internal tickets.
- **Automation:** A conversation Zoe resolved alone counts as resolved at first contact.
- **Unit:** percent

### Repeat contact (`repeat_contact`)

- **Formula:** Of new conversations in the period, the share from a customer who started another within the 7 days before.
- **Anchored to:** When the conversation started.
- **Includes:** Any channel (the same contact).
- **Excludes:** Anonymous visitors without a contact.
- **Automation:** Doesn't depend on who answered the earlier conversation.
- **Unit:** percent

### Deflection (`deflection`)

- **Formula:** Of new conversations, the share closed with no teammate reply (resolved by Zoe, a workflow or the help center).
- **Anchored to:** When the conversation started.
- **Includes:** As new conversations.
- **Excludes:** Conversations still open at the period's end.
- **Automation:** Counts automation's resolutions.
- **Unit:** percent

### Busiest period (`busiest_period`)

- **Formula:** The hour of the week with the most customer messages on average, in the report's timezone.
- **Anchored to:** Each customer message's time.
- **Includes:** Every channel.
- **Excludes:** Internal tickets.
- **Automation:** Counts customers' messages only, whoever answered them.
- **Unit:** time

### Awaiting first response (`awaiting_first_response`)

- **Formula:** Conversations open at the period's end with a customer message and no teammate reply yet.
- **Anchored to:** The period's end.
- **Includes:** Conversations Zoe is still answering.
- **Excludes:** Internal tickets.
- **Automation:** Only teammates' replies count; Zoe's and workflows' don't.
- **Unit:** count

## teammate dataset

### Handling time (`handling_time`)

- **Formula:** For each teammate and conversation, the time it was assigned to them and open, until it was closed, snoozed or reassigned.
- **Anchored to:** Each handling period's end.
- **Includes:** Every period a conversation was open and assigned to the teammate.
- **Excludes:** Snoozed and closed time; time unassigned.
- **Automation:** Time with Zoe (unassigned) isn't anyone's handling time.
- **Unit:** duration

### Handling time excluding idle (`handling_time_excluding_idle`)

- **Formula:** Handling time less the gaps of more than 30 minutes without a reply or note from the teammate.
- **Anchored to:** Each handling period's end.
- **Includes:** As handling time.
- **Excludes:** Idle gaps over 30 minutes.
- **Automation:** As handling time.
- **Unit:** duration

### Adjusted handling time (`adjusted_handling_time`)

- **Formula:** Handling time excluding idle, in office hours.
- **Anchored to:** Each handling period's end.
- **Includes:** As handling time excluding idle.
- **Excludes:** Time outside office hours.
- **Automation:** As handling time.
- **Unit:** duration

### Conversations per teammate per hour (`conversations_per_teammate_hour`)

- **Formula:** Conversations a teammate replied to, divided by their hours active (presence active) in the period.
- **Anchored to:** Each reply's time; each active period.
- **Includes:** Every channel.
- **Excludes:** Hours spent away or away and reassigning.
- **Automation:** Only teammates' replies count; Zoe's and workflows' don't.
- **Unit:** rate

## sla dataset

### SLA hit rate (`sla_hit_rate`)

- **Formula:** Of SLA targets due or met in the period, the share met in time.
- **Anchored to:** The target's due time, or when it was met if earlier.
- **Includes:** Every target of every applied policy (first reply, next reply, time to close, time to resolve).
- **Excludes:** Targets cancelled by a policy change before they were due.
- **Automation:** Zoe's replies don't meet reply targets.
- **Unit:** percent

### SLA miss rate (`sla_miss_rate`)

- **Formula:** Of SLA targets due in the period, the share missed (100% less the hit rate).
- **Anchored to:** The target's due time.
- **Includes:** As SLA hit rate.
- **Excludes:** As SLA hit rate.
- **Automation:** As SLA hit rate.
- **Unit:** percent

### SLA misses (`sla_misses`)

- **Formula:** SLA targets missed in the period, each counted once.
- **Anchored to:** When it was missed (its due time).
- **Includes:** As SLA hit rate.
- **Excludes:** As SLA hit rate.
- **Automation:** As SLA hit rate.
- **Unit:** count

## rating dataset

### CSAT (`csat`)

- **Formula:** Of ratings given in the period, the share of 4 or 5 out of 5.
- **Anchored to:** When the rating was given.
- **Includes:** Conversation ratings (surveys arrive with outbound O6, outside the current scope).
- **Excludes:** A rating changed later counts as its latest value, once.
- **Automation:** Conversations Zoe resolved alone are included, and can be broken down by whether Zoe was involved.
- **Unit:** percent

### CSAT response rate (`csat_response_rate`)

- **Formula:** Of conversations closed in the period, the share rated.
- **Anchored to:** The close's time.
- **Includes:** Conversations where a rating was asked for.
- **Excludes:** Internal tickets.
- **Automation:** Conversations Zoe resolved alone are included, as in CSAT.
- **Unit:** percent

## ai agent dataset

### AI agent resolution rate (`ai_resolution_rate`)

- **Formula:** Of conversations Zoe was involved in, in the period, the share with a net resolution in her ledger (resolutions less reversals).
- **Anchored to:** When Zoe first replied.
- **Includes:** Confirmed and assumed resolutions (her ledger's own kinds).
- **Excludes:** Resolutions reversed by a handover or a reopen.
- **Automation:** This is automation's own metric.
- **Unit:** percent

### AI agent escalation rate (`ai_escalation_rate`)

- **Formula:** Of conversations Zoe was involved in, the share she handed to the team.
- **Anchored to:** When Zoe first replied.
- **Includes:** Handovers asked for, by rule, or by failed answers.
- **Excludes:** Conversations a teammate took without a handover.
- **Automation:** This is automation's own metric.
- **Unit:** percent

### AI agent answer rate (`ai_answer_rate`)

- **Formula:** Of customer messages Zoe was asked to answer, the share she answered with sources.
- **Anchored to:** The message's time.
- **Includes:** Every question her pipeline was run for.
- **Excludes:** Messages she was held back from (a workflow held, she was off).
- **Automation:** This is automation's own metric.
- **Unit:** percent

### AI agent involvement (`ai_involvement`)

- **Formula:** Of new conversations, the share Zoe replied in.
- **Anchored to:** When the conversation started.
- **Includes:** As new conversations.
- **Excludes:** As new conversations.
- **Automation:** This is automation's own metric.
- **Unit:** percent

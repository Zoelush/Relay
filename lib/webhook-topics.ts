/**
 * Webhook topics (phase 15, D3): what a subscription can ask for, and what each delivery's `data`
 * holds. The database writes the events (`db/postgres/0078_webhooks.sql`); a test holds the two to
 * the same list. Company topics and `contact.tagged` wait for phase 01 (companies and tags on people).
 */
export type Topic = { id: string; group: string; label: string; item: "conversation" | "ticket" | "contact" | "event" | "article"; about: string };
export const TOPICS: Topic[] = [
  { id: "conversation.created", group: "Conversations", label: "A conversation started", item: "conversation", about: "A customer (or an API call for them) started a conversation." },
  { id: "conversation.customer_replied", group: "Conversations", label: "The customer wrote", item: "conversation", about: "A customer's message, with `data.part`." },
  { id: "conversation.teammate_replied", group: "Conversations", label: "A teammate replied", item: "conversation", about: "A public reply by a teammate, with `data.part` (internal notes never)." },
  { id: "conversation.assigned", group: "Conversations", label: "Assigned", item: "conversation", about: "Its teammate or team changed, with `data.part`." },
  { id: "conversation.closed", group: "Conversations", label: "Closed", item: "conversation", about: "It was closed." },
  { id: "conversation.rated", group: "Conversations", label: "Rated", item: "conversation", about: "The customer rated it, with `data.part`." },
  { id: "conversation.tagged", group: "Conversations", label: "Tagged", item: "conversation", about: "A tag was added, with `data.tag`." },
  { id: "ticket.created", group: "Tickets", label: "A ticket was made", item: "ticket", about: "A conversation became a ticket." },
  { id: "ticket.state_changed", group: "Tickets", label: "A ticket's state changed", item: "ticket", about: "With `data.changes` (from and to state ids)." },
  { id: "contact.created", group: "Contacts", label: "A contact was created", item: "contact", about: "A new visitor, lead or user." },
  { id: "contact.updated", group: "Contacts", label: "A contact changed", item: "contact", about: "Their name, role, your id for them, or custom attributes." },
  { id: "contact.merged", group: "Contacts", label: "Contacts were merged", item: "contact", about: "The contact that remains, with `data.merged_contact_id`." },
  { id: "event.received", group: "Contacts", label: "An event was recorded", item: "event", about: "From your server or the messenger." },
  { id: "ai_agent.resolved", group: "AI agent", label: "Zoe resolved a conversation", item: "conversation", about: "A confirmed or assumed resolution." },
  { id: "ai_agent.escalated", group: "AI agent", label: "Zoe handed over", item: "conversation", about: "Zoe passed the conversation to the team, with `data.part`." },
  { id: "sla.breached", group: "SLAs", label: "An SLA target was missed", item: "conversation", about: "With `data.metric` (first response, next response, time to close or resolve)." },
  { id: "article.published", group: "Knowledge", label: "An article was published", item: "article", about: "A new or updated article went live." },
];
export const TOPIC_IDS = TOPICS.map((t) => t.id);

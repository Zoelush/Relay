import type { Definition, Group, Path, Step } from "./workflow-definition";

/**
 * Workflow templates (phase 11, step W4; docs/WORKFLOWS_STEP4.md): the ten the brief asks for,
 * each a finished definition but for what only the workspace knows (a tag, a team), which it asks
 * for when created ("slots"). A template is a starting point: it's created as a draft, opened in
 * the builder, and published like any other.
 *
 * Topics (phase 14) and sentiment from Zoe's classifier aren't conditions workflows have, so
 * "route by topic" and "escalate on negative sentiment" use words in the customer's message;
 * notifying Slack arrives with phase 15, so the SLA alert notes and prioritises.
 */
export type Slot = { key: string; kind: "tag" | "team"; label: string };
export type Template = {
  id: string;
  name: string;
  category: "Popular" | "Routing" | "Customer experience" | "Teammate efficiency" | "Zoe";
  description: string;
  slots: Slot[];
  definition: (s: Record<string, string>) => Definition;
};

let n = 0;
const step = (type: Step["type"], options: Record<string, unknown> = {}): Step => ({ id: `t${++n}`, type, options });
const path = (id: string, label: string, steps: Step[], next: Path["next"]): Path => ({ id, label, steps, next });
const end = { type: "end" } as const;
const all = (...items: Group["items"]): Group => ({ match: "all", items });
const any = (...items: Group["items"]): Group => ({ match: "any", items });
const says = (...words: string[]) => any(...words.map((value) => ({ field: "message.text" as const, op: "contains" as const, value })));

export const TEMPLATES: Template[] = [
  {
    id: "route_by_topic",
    name: "Triage and route by topic",
    category: "Routing",
    description: "Billing questions to the billing team, tagged; everything else to the general team. Topics arrive with phase 14: until then, words in the message decide.",
    slots: [
      { key: "billingTag", kind: "tag", label: "The tag for billing questions" },
      { key: "billingTeam", kind: "team", label: "The billing team" },
      { key: "generalTeam", kind: "team", label: "Everyone else goes to" },
    ],
    definition: (s) => ({
      trigger: { type: "first_message", options: {} },
      when: all(),
      paths: [
        path("A", "Start", [], { type: "branch", branches: [{ label: "Billing", when: says("invoice", "refund", "charge", "payment", "billing"), path: "B" }], else: "C" }),
        path("B", "Billing", [step("tag_add", { tagId: s.billingTag }), step("assign", { teamId: s.billingTeam })], end),
        path("C", "Everyone else", [step("assign", { teamId: s.generalTeam })], end),
      ],
    }),
  },
  {
    id: "out_of_hours",
    name: "Out-of-hours autoresponder",
    category: "Popular",
    description: "When the team is away, tell the customer when it's back; the conversation waits for the team.",
    slots: [],
    definition: () => ({
      trigger: { type: "first_message", options: {} },
      when: all({ field: "office_hours", op: "is", value: "closed" }),
      paths: [path("A", "Away", [step("message", { text: "Thanks for getting in touch. Our team is away right now." }), step("reply_time")], end)],
    }),
  },
  {
    id: "vip_fast_lane",
    name: "VIP fast lane",
    category: "Customer experience",
    description: "Customers whose plan is VIP are tagged, prioritised and sent to your VIP team.",
    slots: [
      { key: "vipTag", kind: "tag", label: "The tag that marks VIPs" },
      { key: "vipTeam", kind: "team", label: "The team for VIPs" },
    ],
    definition: (s) => ({
      trigger: { type: "first_message", options: {} },
      when: all({ field: "contact.attribute", key: "plan", op: "is", value: "vip" }),
      paths: [path("A", "Fast lane", [step("tag_add", { tagId: s.vipTag }), step("priority", { value: true }), step("assign", { teamId: s.vipTeam })], end)],
    }),
  },
  {
    id: "collect_email",
    name: "Collect email before chat",
    category: "Popular",
    description: "Visitors who aren't signed in are asked for their email first, so the team can reply if they leave.",
    slots: [],
    definition: () => ({
      trigger: { type: "first_message", options: {} },
      when: all({ field: "contact.signed_in", op: "is", value: false }),
      paths: [
        path(
          "A",
          "Ask",
          [
            step("collect", { text: "So we can get back to you, what's your email address?", into: "email", timeoutSeconds: 3600 }),
            step("message", { text: "Thanks! The team will reply here, and by email if you've gone." }),
          ],
          end,
        ),
      ],
    }),
  },
  {
    id: "qualify_lead",
    name: "Qualify a lead",
    category: "Teammate efficiency",
    description: "Leads are asked how big their company is; larger ones go straight to sales, tagged.",
    slots: [
      { key: "salesTeam", kind: "team", label: "The sales team" },
      { key: "qualifiedTag", kind: "tag", label: "The tag for qualified leads" },
    ],
    definition: (s) => ({
      trigger: { type: "first_message", options: {} },
      when: all({ field: "contact.role", op: "is", value: "lead" }),
      paths: [
        path("A", "Ask", [], {
          type: "buttons",
          text: "Happy to help! How big is your company?",
          buttons: [
            { label: "Just me", path: "C" },
            { label: "2 to 50 people", path: "C" },
            { label: "More than 50", path: "B" },
          ],
          other: "C",
          timeoutSeconds: 86_400,
          timedOut: "C",
        }),
        path("B", "Qualified", [step("tag_add", { tagId: s.qualifiedTag }), step("assign", { teamId: s.salesTeam }), step("reply_time")], end),
        path("C", "Others", [step("message", { text: "Thanks! Ask us anything here and we'll help." })], end),
      ],
    }),
  },
  {
    id: "negative_sentiment",
    name: "Escalate on negative sentiment",
    category: "Customer experience",
    description: "Messages that sound upset are prioritised, tagged and handed to the team. Words in the message decide.",
    slots: [
      { key: "upsetTag", kind: "tag", label: "The tag for upset customers" },
      { key: "team", kind: "team", label: "Escalate to" },
    ],
    definition: (s) => ({
      trigger: { type: "customer_message", options: {} },
      when: says("terrible", "awful", "angry", "unacceptable", "cancel", "furious", "worst"),
      paths: [
        path(
          "A",
          "Escalate",
          [step("tag_add", { tagId: s.upsetTag }), step("priority", { value: true }), step("human_handover", { teamId: s.team }), step("note", { text: "This customer sounds upset: escalated by a workflow." })],
          end,
        ),
      ],
    }),
  },
  {
    id: "close_stale",
    name: "Close stale conversations",
    category: "Teammate efficiency",
    description:
      "When a customer hasn't replied for three days, check in once (tagged); if they still haven't three days later, close it. Remove the tag to check in again.",
    slots: [{ key: "checkedTag", kind: "tag", label: "The tag for conversations checked in on" }],
    definition: (s) => ({
      trigger: { type: "unresponsive", options: { minutes: 3 * 1440 } },
      when: all(),
      paths: [
        path("A", "Start", [], { type: "branch", branches: [{ label: "Checked in already", when: all({ field: "conversation.tag", op: "has", value: s.checkedTag }), path: "C" }], else: "B" }),
        path("B", "Check in", [step("tag_add", { tagId: s.checkedTag }), step("message", { text: "Just checking in: is there anything else we can help with?" })], end),
        path("C", "Close", [step("message", { text: "We'll close this for now. Reply any time to pick it up again." }), step("close")], end),
      ],
    }),
  },
  {
    id: "rating_after_close",
    name: "Request a rating after closure",
    category: "Customer experience",
    description: "When a conversation closes, ask how it went; an unhappy answer reopens it for the team.",
    slots: [{ key: "team", kind: "team", label: "Unhappy answers go to" }],
    definition: (s) => ({
      trigger: { type: "closed", options: {} },
      when: all({ field: "change.by", op: "is_not", value: "workflow" }),
      paths: [
        path("A", "Ask", [], {
          type: "buttons",
          text: "How did we do?",
          buttons: [
            { label: "Great", path: "B" },
            { label: "Not great", path: "C" },
          ],
          other: "B",
          timeoutSeconds: 3 * 86_400,
          timedOut: "B",
        }),
        path("B", "Thanks", [step("message", { text: "Thanks for letting us know!" })], end),
        path("C", "Follow up", [step("message", { text: "Sorry to hear that. Someone from the team will follow up." }), step("reopen"), step("assign", { teamId: s.team })], end),
      ],
    }),
  },
  {
    id: "sla_breach_alert",
    name: "Alert on SLA breach",
    category: "Teammate efficiency",
    description: "When an SLA target is missed, the conversation is prioritised, tagged and noted for the team. Slack arrives with phase 15.",
    slots: [
      { key: "breachTag", kind: "tag", label: "The tag for breached conversations" },
      { key: "team", kind: "team", label: "Escalate to" },
    ],
    definition: (s) => ({
      trigger: { type: "sla_breached", options: {} },
      when: all(),
      paths: [
        path(
          "A",
          "Escalate",
          [step("priority", { value: true }), step("tag_add", { tagId: s.breachTag }), step("assign", { teamId: s.team }), step("note", { text: "An SLA target was missed: prioritised by a workflow." })],
          end,
        ),
      ],
    }),
  },
  {
    id: "route_by_language",
    name: "Route by language",
    category: "Routing",
    description: "Conversations in French go to your French team; the rest to everyone else. Add a branch per language.",
    slots: [
      { key: "frenchTeam", kind: "team", label: "The French-speaking team" },
      { key: "generalTeam", kind: "team", label: "Everyone else goes to" },
    ],
    definition: (s) => ({
      trigger: { type: "first_message", options: {} },
      when: all(),
      paths: [
        path("A", "Start", [], { type: "branch", branches: [{ label: "French", when: all({ field: "conversation.language", op: "is", value: "fr" }), path: "B" }], else: "C" }),
        path("B", "French", [step("assign", { teamId: s.frenchTeam })], end),
        path("C", "Everyone else", [step("assign", { teamId: s.generalTeam })], end),
      ],
    }),
  },
];

/** A template's draft, its slots filled (each must be given). */
export function fromTemplate(id: string, slots: Record<string, unknown>): { name: string; definition: Definition } {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error("That template doesn't exist.");
  const filled: Record<string, string> = {};
  for (const s of t.slots) {
    const v = slots[s.key];
    if (typeof v !== "string" || !v) throw new Error(`Choose ${s.label.charAt(0).toLowerCase() + s.label.slice(1)}.`);
    filled[s.key] = v;
  }
  n = 0;
  return { name: t.name, definition: t.definition(filled) };
}

/**
 * The pre-built reports (phase 14; docs/REPORTING_PLAN.md): which metrics each shows and how
 * they're broken down. R2's benchmark times exactly these queries; R3 draws them. Every metric is
 * defined in `lib/metrics.ts`; this only arranges them.
 */
export type Breakdown = "brand" | "channel" | "team" | "teammate" | "item" | "day" | "week" | "month" | `attribute:${string}`;
export type Chart = { metric: string; breakdown?: Breakdown };
export type PrebuiltReport = { id: string; name: string; description: string; charts: Chart[] };

export const PREBUILT: PrebuiltReport[] = [
  {
    id: "overview",
    name: "Overview",
    description: "People and Zoe together: volume, responsiveness, resolution and satisfaction.",
    charts: [
      { metric: "new_conversations", breakdown: "day" },
      { metric: "ai_involvement" },
      { metric: "ai_resolution_rate" },
      { metric: "first_response_time" },
      { metric: "time_to_close" },
      { metric: "csat" },
      { metric: "deflection" },
    ],
  },
  {
    id: "conversations",
    name: "Conversations",
    description: "How many came in, were replied to, closed and reopened, and where they stand.",
    charts: [
      { metric: "new_conversations", breakdown: "channel" },
      { metric: "conversations_replied_to", breakdown: "day" },
      { metric: "replies_sent" },
      { metric: "closed_conversations", breakdown: "day" },
      { metric: "reopened_conversations" },
      { metric: "open_at_end" },
      { metric: "snoozed_at_end" },
      { metric: "awaiting_first_response" },
      { metric: "busiest_period" },
    ],
  },
  {
    id: "responsiveness",
    name: "Responsiveness",
    description: "How quickly the team answers, in office hours and on the clock.",
    charts: [
      { metric: "first_response_time", breakdown: "day" },
      { metric: "first_response_time", breakdown: "channel" },
      { metric: "next_response_time" },
      { metric: "time_to_close" },
      { metric: "time_to_resolve" },
    ],
  },
  {
    id: "slas",
    name: "SLAs",
    description: "Targets met and missed.",
    charts: [{ metric: "sla_hit_rate", breakdown: "day" }, { metric: "sla_miss_rate", breakdown: "team" }, { metric: "sla_misses" }],
  },
  {
    id: "team_performance",
    name: "Team performance",
    description: "Each team's volume, speed and satisfaction.",
    charts: [
      { metric: "new_conversations", breakdown: "team" },
      { metric: "first_response_time", breakdown: "team" },
      { metric: "time_to_close", breakdown: "team" },
      { metric: "csat", breakdown: "team" },
    ],
  },
  {
    id: "teammate_performance",
    name: "Teammate performance",
    description: "Each teammate's replies, speed, handling time and pace.",
    charts: [
      { metric: "conversations_replied_to", breakdown: "teammate" },
      { metric: "first_response_time", breakdown: "teammate" },
      { metric: "handling_time", breakdown: "teammate" },
      { metric: "adjusted_handling_time", breakdown: "teammate" },
      { metric: "conversations_per_teammate_hour", breakdown: "teammate" },
      { metric: "reassignments" },
    ],
  },
  {
    id: "tickets",
    name: "Tickets",
    description: "Tickets opened and resolved, and how long they took.",
    charts: [{ metric: "new_tickets", breakdown: "item" }, { metric: "tickets_resolved", breakdown: "day" }, { metric: "ticket_time_to_resolve" }],
  },
  {
    id: "csat",
    name: "CSAT",
    description: "How customers rated their conversations, and where they were unhappy.",
    charts: [{ metric: "csat", breakdown: "day" }, { metric: "csat", breakdown: "channel" }, { metric: "csat", breakdown: "teammate" }, { metric: "csat_response_rate" }],
  },
  {
    id: "ai_agent",
    name: "AI agent",
    description: "What Zoe answered, resolved and handed over.",
    charts: [
      { metric: "ai_involvement", breakdown: "day" },
      { metric: "ai_answer_rate" },
      { metric: "ai_resolution_rate", breakdown: "day" },
      { metric: "ai_escalation_rate" },
      { metric: "deflection" },
    ],
  },
  {
    id: "help_center",
    name: "Help center and search",
    description: "What people searched for, found and found helpful.",
    charts: [{ metric: "help_searches", breakdown: "day" }, { metric: "searches_without_results" }, { metric: "search_click_through" }, { metric: "article_helpful_rate", breakdown: "item" }],
  },
  {
    id: "outbound",
    name: "Outbound",
    description: "What outbound messages reached people, and what they did.",
    charts: [
      { metric: "outbound_sent", breakdown: "item" },
      { metric: "outbound_seen_rate" },
      { metric: "outbound_reply_rate" },
      { metric: "outbound_click_rate" },
      { metric: "outbound_dismiss_rate" },
    ],
  },
  {
    id: "effectiveness",
    name: "Effectiveness",
    description: "Resolved first time, coming back, and reopened.",
    charts: [{ metric: "first_contact_resolution", breakdown: "day" }, { metric: "repeat_contact" }, { metric: "reopened_conversations" }, { metric: "reassignments" }],
  },
  {
    id: "calls",
    name: "Calls",
    description: "Calls received, answered, sent to voicemail, and how long they lasted.",
    charts: [{ metric: "calls", breakdown: "day" }, { metric: "calls_answered_rate" }, { metric: "voicemails" }, { metric: "call_duration" }, { metric: "calls_with_zoe" }],
  },
  {
    id: "email_deliverability",
    name: "Email deliverability",
    description: "Replies delivered, failed and suppressed, by channel.",
    charts: [{ metric: "delivery_rate", breakdown: "channel" }, { metric: "delivery_failures", breakdown: "day" }, { metric: "deliveries_suppressed" }],
  },
  {
    id: "human_in_the_loop",
    name: "Human in the loop",
    description: "Zoe's drafts held for a teammate: how many, and how many were sent.",
    charts: [{ metric: "ai_drafts_reviewed", breakdown: "day" }, { metric: "ai_draft_approval_rate" }],
  },
];

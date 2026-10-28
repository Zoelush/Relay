/**
 * The audit log's actions (phase 16, step C1; docs/SECURITY_STEP1.md): one registry, read by the
 * log's filters, its labels and its exports. Most actions are written by migration 0081's
 * triggers as `<prefix>.<verb>` (a test compares the triggers' prefixes with `TABLE_ACTIONS`); the
 * rest are written by `recordAudit` (`EXPLICIT_ACTIONS`).
 */
export const AREAS = ["People and roles", "Workspace", "Channels", "Zoe and AI", "Automation", "Developers", "Data", "Customer records", "Security"] as const;
export type Area = (typeof AREAS)[number];

/** What a row trigger can say happened, in words. */
export const VERBS: Record<string, string> = {
  created: "created",
  changed: "changed",
  deleted: "deleted",
  revoked: "revoked",
  reversed: "reversed",
  disabled: "turned off",
  archived: "archived",
  restored: "restored",
  published: "published",
  granted: "granted",
  removed: "removed",
  added: "added",
  merged: "merged",
};

/** Each audited table's prefix: what it's called, and its area. */
export const TABLE_ACTIONS: Record<string, { noun: string; area: Area }> = {
  role: { noun: "Role", area: "People and roles" },
  "role.permission": { noun: "Role permission", area: "People and roles" },
  teammate: { noun: "Teammate", area: "People and roles" },
  team: { noun: "Team", area: "People and roles" },
  "team.member": { noun: "Team member", area: "People and roles" },
  feature: { noun: "Feature", area: "Workspace" },
  brand: { noun: "Brand settings", area: "Workspace" },
  office_hours: { noun: "Office hours", area: "Workspace" },
  sla_policy: { noun: "SLA policy", area: "Workspace" },
  portal_settings: { noun: "Portal settings", area: "Workspace" },
  portal_domain: { noun: "Portal domain", area: "Workspace" },
  help_center: { noun: "Help center", area: "Workspace" },
  email_settings: { noun: "Email settings", area: "Channels" },
  email_domain: { noun: "Sending domain", area: "Channels" },
  voice_settings: { noun: "Voice settings", area: "Channels" },
  sms_account: { noun: "SMS account", area: "Channels" },
  sms_number: { noun: "SMS number", area: "Channels" },
  whatsapp_number: { noun: "WhatsApp number", area: "Channels" },
  meta_page: { noun: "Facebook Page", area: "Channels" },
  community: { noun: "Slack or Discord connection", area: "Channels" },
  identity_key: { noun: "Messenger identity key", area: "Security" },
  zoe: { noun: "Zoe's settings", area: "Zoe and AI" },
  "zoe.identity": { noun: "Zoe's identity", area: "Zoe and AI" },
  "zoe.escalation_rule": { noun: "Escalation rule", area: "Zoe and AI" },
  "zoe.specialist": { noun: "Specialist", area: "Zoe and AI" },
  "zoe.monitor": { noun: "Zoe monitor", area: "Zoe and AI" },
  knowledge_source: { noun: "Knowledge source", area: "Zoe and AI" },
  connector: { noun: "Data connector", area: "Zoe and AI" },
  "connector.secret": { noun: "Connector credential", area: "Zoe and AI" },
  procedure: { noun: "Procedure", area: "Zoe and AI" },
  workflow: { noun: "Workflow", area: "Automation" },
  outbound: { noun: "Outbound message", area: "Automation" },
  outbound_settings: { noun: "Outbound limits", area: "Automation" },
  api_token: { noun: "API token", area: "Developers" },
  oauth_app: { noun: "App", area: "Developers" },
  app_install: { noun: "App installation", area: "Developers" },
  webhook: { noun: "Webhook", area: "Developers" },
  attribute: { noun: "Data attribute", area: "Data" },
  tag: { noun: "Tag", area: "Data" },
  ticket_type: { noun: "Ticket type", area: "Data" },
  subscription_type: { noun: "Subscription type", area: "Data" },
  segment: { noun: "Segment", area: "Data" },
  "contact.merge": { noun: "Contact", area: "Customer records" },
  audit_settings: { noun: "Audit log retention", area: "Security" },
  account: { noun: "Password sign-in", area: "Security" },
  invitation: { noun: "Invitation", area: "People and roles" },
  session_settings: { noun: "Sign-in and access settings", area: "Security" },
  sso: { noun: "Single sign-on", area: "Security" },
  sso_domain: { noun: "Single sign-on domain", area: "Security" },
  sso_role: { noun: "Single sign-on group role", area: "Security" },
  retention: { noun: "Retention policies", area: "Data" },
};

/** Actions written by `recordAudit`: what isn't a row change. */
export const EXPLICIT_ACTIONS = {
  "contact.viewed": { label: "Customer record opened", area: "Customer records" },
  "conversation.part_deleted": { label: "Reply or note deleted", area: "Customer records" },
  "data.export_requested": { label: "Data export requested", area: "Data" },
  "audit.exported": { label: "Audit log exported", area: "Security" },
  "session.signed_in": { label: "Signed in", area: "Security" },
  "session.sign_in_failed": { label: "Sign-in failed", area: "Security" },
  "session.signed_out": { label: "Signed out", area: "Security" },
  "session.revoked": { label: "Session ended", area: "Security" },
  "session.two_factor_failed": { label: "Wrong two-factor code", area: "Security" },
  "session.network_refused": { label: "Sign-in refused (address not allowed)", area: "Security" },
  "two_factor.enabled": { label: "Two-factor turned on", area: "Security" },
  "two_factor.disabled": { label: "Two-factor turned off", area: "Security" },
  "two_factor.reset": { label: "Two-factor turned off for a teammate", area: "Security" },
  "two_factor.recovery_codes_replaced": { label: "Recovery codes replaced", area: "Security" },
  "two_factor.recovery_code_used": { label: "Recovery code used", area: "Security" },
  "session.sso_refused": { label: "Single sign-on refused", area: "Security" },
  "data.subject_export_requested": { label: "Export of a person's data requested", area: "Data" },
  "data.subject_exported": { label: "Person's data exported", area: "Data" },
  "data.subject_export_downloaded": { label: "Person's data export downloaded", area: "Data" },
  "data.erasure_requested": { label: "Deletion of a person requested", area: "Data" },
  "data.erased": { label: "Person deleted (certificate issued)", area: "Data" },
  "data.retention_applied": { label: "Retention policies applied", area: "Data" },
  "session.break_glass": { label: "Owner signed in with a password (single sign-on enforced)", area: "Security" },
  "invitation.accepted": { label: "Invitation accepted", area: "People and roles" },
} as const satisfies Record<string, { label: string; area: Area }>;
export type ExplicitAction = keyof typeof EXPLICIT_ACTIONS;

/** An action's words and area, from either list. */
export function describeAction(action: string): { label: string; area: Area | "Other" } {
  if (action in EXPLICIT_ACTIONS) return EXPLICIT_ACTIONS[action as ExplicitAction];
  const dot = action.lastIndexOf(".");
  const prefix = action.slice(0, dot);
  const verb = action.slice(dot + 1);
  const table = TABLE_ACTIONS[prefix];
  if (!table) return { label: action, area: "Other" };
  return { label: `${table.noun} ${VERBS[verb] ?? verb}`, area: table.area };
}

/** The prefixes in an area, for filtering (`<prefix>.%`), and the explicit actions in it. */
export function actionsIn(area: Area) {
  return {
    prefixes: Object.entries(TABLE_ACTIONS)
      .filter(([, t]) => t.area === area)
      .map(([p]) => p),
    explicit: Object.entries(EXPLICIT_ACTIONS)
      .filter(([, t]) => t.area === area)
      .map(([a]) => a),
  };
}

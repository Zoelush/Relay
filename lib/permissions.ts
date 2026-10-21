/**
 * What each permission means, in plain words (phase 16, step C2; docs/SECURITY_STEP2.md): the
 * permission editor, the consent screen and token pickers read it. The registry of capabilities
 * itself is `server/policy.ts`; a test checks every capability has an entry here.
 *
 * `restricted`: whether a restricted role (one that sees only conversations assigned to its
 * teammates or their teams) may have it. Personal data, reports, exports and anything that
 * manages the workspace never go with a restricted role; migration 0082's trigger holds that.
 */
export type PermissionInfo = { label: string; description: string; group: string; restricted: boolean; legacy?: true };

export const PERMISSION_GROUPS = ["Conversations", "Customers", "Macros", "Helpdesk and knowledge", "Reports and data", "Workspace", "Security and billing"] as const;

export const PERMISSION_INFO: Record<string, PermissionInfo> = {
  "conversations.read": {
    group: "Conversations",
    label: "See conversations",
    description: "Open the inbox and read conversations. Every role has this: it's what lets a teammate into Relay.",
    restricted: true,
  },
  "conversations.reply": { group: "Conversations", label: "Reply to customers", description: "Send messages customers see, on any channel.", restricted: true },
  "conversations.note": { group: "Conversations", label: "Write internal notes", description: "Leave notes only teammates can see.", restricted: true },
  "conversations.manage": {
    group: "Conversations",
    label: "Work on conversations",
    description: "Close, snooze, tag, prioritise, merge and fill in a conversation's details.",
    restricted: true,
  },
  "conversations.assign": { group: "Conversations", label: "Assign conversations", description: "Give a conversation to any teammate or team.", restricted: true },
  "conversations.delete_reply": { group: "Conversations", label: "Delete replies", description: "Remove a reply already sent to a customer from the timeline.", restricted: true },
  "conversations.delete_note": { group: "Conversations", label: "Delete internal notes", description: "Remove a note from the timeline.", restricted: true },
  "contacts.personal_data": {
    group: "Customers",
    label: "See customers' personal details",
    description: "Names, email addresses, phone numbers and profiles: in conversations, in People and through the API.",
    restricted: false,
  },
  "macros.use": { group: "Macros", label: "Use macros", description: "Apply saved replies and their actions to a conversation.", restricted: true },
  "macros.create": { group: "Macros", label: "Create shared macros", description: "Add macros the whole team can use.", restricted: false },
  "macros.edit": { group: "Macros", label: "Edit shared macros", description: "Change macros the whole team uses.", restricted: false },
  "macros.delete": { group: "Macros", label: "Archive shared macros", description: "Take a shared macro out of use.", restricted: false },
  // Replaced by create, edit and archive (phase 04); kept on roles that had it, never offered.
  "macros.manage": { group: "Macros", label: "Manage macros (old)", description: "No longer used: replaced by create, edit and archive.", restricted: false, legacy: true },
  "tickets.manage": { group: "Helpdesk and knowledge", label: "Manage ticket types", description: "Define ticket types, their states and their fields.", restricted: false },
  "knowledge.manage": {
    group: "Helpdesk and knowledge",
    label: "Manage knowledge",
    description: "Write and publish articles, run help centers, sync websites and manage the AI index.",
    restricted: false,
  },
  "reports.view": { group: "Reports and data", label: "View reports", description: "See every report and the live dashboard, across all conversations.", restricted: false },
  "reports.share": { group: "Reports and data", label: "Share reports", description: "Send reports to people outside Relay.", restricted: false },
  "data.export": { group: "Reports and data", label: "Export data", description: "Download conversations, contacts and tickets in bulk, through the API.", restricted: false },
  "workspace.manage": {
    group: "Workspace",
    label: "Manage workspace settings",
    description: "General settings, channels, teams, office hours, SLAs, tags, attributes, the portal, Zoe, workflows, outbound and apps.",
    restricted: false,
  },
  "teammates.manage": { group: "Workspace", label: "Manage teammates and roles", description: "Change teammates' roles and what each role may do.", restricted: false },
  "security.manage": {
    group: "Security and billing",
    label: "Manage security",
    description: "Read and export the audit log and change how long it's kept.",
    restricted: false,
  },
  "billing.manage": { group: "Security and billing", label: "Manage billing", description: "Plans, seats, usage limits and invoices (with billing, later in phase 16).", restricted: false },
};

/** The groups in order, each with its permissions, for editors and pickers. */
export function permissionGroups(capabilities: readonly string[]) {
  return PERMISSION_GROUPS.map((group) => ({
    group,
    items: capabilities.filter((c) => PERMISSION_INFO[c]?.group === group && !PERMISSION_INFO[c].legacy).map((c) => ({ id: c, ...PERMISSION_INFO[c] })),
  })).filter((g) => g.items.length);
}

/** What a restricted role may have. */
export const RESTRICTED_ALLOWED = Object.entries(PERMISSION_INFO)
  .filter(([, p]) => p.restricted)
  .map(([c]) => c);

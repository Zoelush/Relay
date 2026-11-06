/**
 * The security health check (phase 16, step C7c; docs/SECURITY_STEP13.md): every check, its group,
 * its title and the settings page that changes it. `server/health-check.ts` decides each one's state
 * and severity from the workspace's settings (a test holds the two to the same list); the page
 * shows what needs attention first, most severe first.
 */
export type Severity = "critical" | "recommended" | "optional" | "ok";
export const SEVERITY_ORDER: Severity[] = ["critical", "recommended", "optional", "ok"];
export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", recommended: "Recommended", optional: "Optional", ok: "Fine" };
export const GROUPS = ["Authentication and access", "Messenger security", "Data protection"] as const;
export type Group = (typeof GROUPS)[number];

export const CHECKS = {
  two_factor: { group: "Authentication and access", title: "Two-factor for password sign-in", link: "#settings/access" },
  without_two_factor: { group: "Authentication and access", title: "Teammates without two-factor", link: "#settings/access" },
  sso: { group: "Authentication and access", title: "Single sign-on", link: "#settings/sso" },
  sessions: { group: "Authentication and access", title: "Session limits", link: "#settings/sign-in" },
  ip_allowlist: { group: "Authentication and access", title: "IP allowlist", link: "#settings/access" },
  support_access: { group: "Authentication and access", title: "Relay support access", link: "#settings/support-access" },
  identity_verification: { group: "Messenger security", title: "Identity verification", link: "#settings/brands" },
  legacy_hmac: { group: "Messenger security", title: "Legacy identity check", link: "#settings/brands" },
  allowed_websites: { group: "Messenger security", title: "Allowed websites", link: "#settings/messenger" },
  redaction: { group: "Data protection", title: "Content redaction", link: "#settings/data-protection" },
  retention: { group: "Data protection", title: "Retention", link: "#settings/retention" },
  link_lookup: { group: "Data protection", title: "Link reputation lookup", link: "#settings/links" },
  risky_merges: { group: "Data protection", title: "Risky merges", link: "#settings/data-protection" },
} as const satisfies Record<string, { group: Group; title: string; link: string }>;
export type CheckId = keyof typeof CHECKS;
export type CheckResult = { id: CheckId; group: Group; title: string; link: string; severity: Severity; state: string };

/** Most severe first; within a severity, in the registry's order. */
export function ranked(results: CheckResult[]) {
  const order = Object.keys(CHECKS);
  return [...results].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || order.indexOf(a.id) - order.indexOf(b.id));
}

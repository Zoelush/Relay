import type { Sql } from "./db";
import { authorize } from "./policy";
import { securityOn, ssoEnforced } from "./two-factor";
import { CHECKS, ranked, SEVERITY_ORDER, type CheckId, type CheckResult, type Severity } from "../lib/health-check";

/**
 * The security health check (phase 16, step C7c; docs/SECURITY_STEP13.md): Settings › Security ›
 * Health check (`security.manage`, behind `security_v1`). Each check in `lib/health-check.ts` is
 * decided here from the workspace's settings, on every visit: nothing is stored.
 */
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const DEFAULT_IDLE_MINUTES = 5760;
const DEFAULT_ABSOLUTE_HOURS = 720;

export async function readHealthCheck(db: Sql, w: string, principal: string, env: { lookup: boolean }) {
  await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const one = async <T>(sql: string) => (await db.query<T>(sql, [w])).rows[0];
  const settings = await one<{ require_two_factor: boolean; idle_minutes: number; absolute_hours: number; app: string[]; merge_across_people: boolean; merge_leads_by_email: boolean }>(
    "SELECT require_two_factor,idle_minutes,absolute_hours,app_allowlist::text[] AS app,merge_across_people,merge_leads_by_email FROM security_settings WHERE workspace_id=$1",
  );
  const sso = await one<{ enabled: boolean; enforced: boolean; name: string }>("SELECT enabled,enforced,name FROM sso_connections WHERE workspace_id=$1");
  const enforced = await ssoEnforced(db, w);
  const without = Number(
    (
      await one<{ n: string }>(
        `SELECT count(*) AS n FROM teammate_credentials c WHERE c.workspace_id=$1
         AND NOT EXISTS (SELECT 1 FROM teammate_two_factor f WHERE f.workspace_id=c.workspace_id AND f.teammate_id=c.teammate_id AND f.enabled_at IS NOT NULL)`,
      )
    )?.n ?? 0,
  );
  const grant = await one<{ expires_at: Date }>("SELECT expires_at FROM support_grants WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>now()");
  const brands = (
    await db.query<{ name: string; identity_enforced: boolean; legacy_hmac_enabled: boolean; origins: number }>(
      "SELECT name,identity_enforced,legacy_hmac_enabled,jsonb_array_length(COALESCE(settings->'allowedOrigins','[]'::jsonb)) AS origins FROM brands WHERE workspace_id=$1 ORDER BY name",
      [w],
    )
  ).rows;
  const rules = Number((await one<{ n: string }>("SELECT count(*) AS n FROM redaction_rules WHERE workspace_id=$1 AND enabled"))?.n ?? 0);
  const retention = await one<Record<string, number | null>>(
    "SELECT conversations_days,attachments_days,recordings_days,events_days,logs_days FROM retention_settings WHERE workspace_id=$1",
  );
  const policies = retention ? Object.values(retention).filter((d) => d !== null).length : 0;
  const names = (list: { name: string }[]) => list.map((b) => b.name).join(", ");

  const decided: Record<CheckId, { severity: Severity; state: string }> = {
    two_factor: settings?.require_two_factor
      ? { severity: "ok", state: "Required for everyone who signs in with a password." }
      : enforced
        ? { severity: "ok", state: "Single sign-on is enforced, so only owners sign in with a password." }
        : { severity: "critical", state: "Not required: a stolen password is enough to sign in." },
    without_two_factor: without
      ? { severity: "recommended", state: `${plural(without, "teammate")} with a password ${without === 1 ? "has" : "have"} no two-factor.` }
      : { severity: "ok", state: "Everyone with a password has two-factor." },
    sso: !sso?.enabled
      ? { severity: "optional", state: "Not set up. Teammates sign in with Relay passwords." }
      : sso.enforced
        ? { severity: "ok", state: `${sso.name || "Single sign-on"} is enforced.` }
        : { severity: "recommended", state: `${sso.name || "Single sign-on"} is on, but passwords still work for everyone.` },
    sessions:
      (settings?.idle_minutes ?? DEFAULT_IDLE_MINUTES) <= DEFAULT_IDLE_MINUTES && (settings?.absolute_hours ?? DEFAULT_ABSOLUTE_HOURS) <= DEFAULT_ABSOLUTE_HOURS
        ? { severity: "ok", state: "Sessions end after at most 4 days unused and 30 days in all." }
        : { severity: "recommended", state: "Sessions last longer than 4 days unused or 30 days in all." },
    ip_allowlist: settings?.app?.length
      ? { severity: "ok", state: `The app is reachable only from ${plural(settings.app.length, "address range")}.` }
      : { severity: "optional", state: "The app can be reached from any network." },
    support_access: grant
      ? { severity: "recommended", state: `Relay support can see this workspace until ${new Date(grant.expires_at).toISOString().slice(0, 16).replace("T", " ")} UTC. Revoke it when you no longer need help.` }
      : { severity: "ok", state: "Relay support has no access." },
    identity_verification: brands.every((b) => b.identity_enforced)
      ? { severity: "ok", state: "Every brand's messenger requires signed-in users to be verified." }
      : { severity: "recommended", state: `Not enforced for ${names(brands.filter((b) => !b.identity_enforced))}: anyone can claim to be a user.` },
    legacy_hmac: brands.some((b) => b.legacy_hmac_enabled)
      ? { severity: "recommended", state: `The older HMAC check is still accepted for ${names(brands.filter((b) => b.legacy_hmac_enabled))}.` }
      : { severity: "ok", state: "Only signed identity tokens are accepted." },
    allowed_websites: brands.every((b) => b.origins > 0)
      ? { severity: "ok", state: "Every brand's messenger loads only on its listed websites." }
      : { severity: "recommended", state: `No websites listed for ${names(brands.filter((b) => !b.origins))}: the messenger loads anywhere.` },
    redaction: rules
      ? { severity: "ok", state: `${plural(rules, "redaction rule")} on.` }
      : { severity: "recommended", state: "No redaction rules: card numbers and other sensitive details are stored as written." },
    retention: policies
      ? { severity: "ok", state: `${plural(policies, "kind")} of data deleted after a set time.` }
      : { severity: "optional", state: "Everything is kept until deleted by hand or by a data request." },
    link_lookup: env.lookup
      ? { severity: "ok", state: "Customers' links are checked against a list of known phishing and malware addresses." }
      : { severity: "optional", state: "Links are checked in Relay only: no list of known phishing addresses is set up." },
    risky_merges:
      settings?.merge_across_people || settings?.merge_leads_by_email
        ? {
            severity: "recommended",
            state: `${[settings.merge_across_people && "Different people's conversations", settings.merge_leads_by_email && (settings.merge_across_people ? "leads into users by email" : "Leads into users by email")].filter(Boolean).join(" and ")} can be merged.`,
          }
        : { severity: "ok", state: "Both risky merges are off." },
  };
  const checks: CheckResult[] = (Object.keys(CHECKS) as CheckId[]).map((id) => ({ id, ...CHECKS[id], ...decided[id] }));
  const summary = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, checks.filter((c) => c.severity === s).length])) as Record<Severity, number>;
  return { summary, attention: ranked(checks.filter((c) => c.severity !== "ok")), checks };
}

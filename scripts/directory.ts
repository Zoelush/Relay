/**
 * Relay's operators review apps for the directory (docs/TEST_WORKSPACE_STEP6.md, T3b). This command
 * is the only way staff decide anything about the directory: there is no web surface, so Relay's
 * support access stays read-only. Every decision is recorded in the developer's audit log by name.
 *
 *   npm run directory -- pending
 *   npm run directory -- approve <submission id> --as <name>
 *   npm run directory -- reject  <submission id> "<reason>" --as <name>
 *   npm run directory -- delist  <client id> "<reason>" --as <name>
 *   npm run directory -- relist  <client id> --as <name>
 *   npm run directory -- suspend <client id> "<reason>" --as <name>
 *   npm run directory -- lift    <client id> --as <name>
 *
 * Deployed: RELAY_OPERATOR_DATABASE_URL, a role that row-level security applies to (each decision
 * sets its tenant, as the app does). Locally: --local work/local-relay, while the local relay is
 * stopped (its embedded database has one writer).
 */
import { resolve } from "node:path";
import { Client } from "pg";
import { DomainError, type Connect, type Sql } from "../server/db";
import { localDatabase } from "./local-db";
import { approveSubmission, delistApp, liftSuspension, pendingReviews, rejectSubmission, relistApp, suspendApp } from "../server/directory-review";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const as = flag("--as");
const local = flag("--local");
const [command, first, second] = args;

async function connection(): Promise<{ connect: Connect; close: () => Promise<void> }> {
  if (local) {
    const db = await localDatabase(resolve(local, "postgres"));
    return { connect: db.connect, close: db.close };
  }
  const url = process.env.RELAY_OPERATOR_DATABASE_URL;
  if (!url) throw new DomainError("NO_DATABASE", "Set RELAY_OPERATOR_DATABASE_URL, or pass --local <the local relay's directory> while it is stopped.", 400);
  return {
    connect: async () => {
      const client = new Client({ connectionString: url, statement_timeout: 15000 });
      await client.connect();
      return { query: ((text: string, values?: unknown[]) => client.query(text, values)) as Sql["query"], close: () => client.end() };
    },
    close: async () => undefined,
  };
}

async function main() {
  const { connect, close } = await connection();
  try {
    switch (command) {
      case "pending": {
        const list = await pendingReviews(connect);
        if (!list.length) return console.log("Nothing is waiting for review.");
        for (const s of list) {
          console.log(`${s.id}  ${s.kind === "listing" ? "To be listed" : "New version"}: ${s.card.name} ${s.card.version} by ${s.card.developer} (${s.card.clientId})`);
          console.log(`    permissions: ${s.card.scopes.join(", ")} · shows in: ${s.card.placements.join(", ") || "nowhere"} · sends to: ${s.card.hosts.join(", ")}`);
          for (const why of s.widens) console.log(`    ${why}`);
        }
        return;
      }
      case "approve":
        return console.log(await approveSubmission(connect, first, as));
      case "reject":
        return console.log(await rejectSubmission(connect, first, as, second));
      case "delist":
        return console.log(await delistApp(connect, first, as, second));
      case "relist":
        return console.log(await relistApp(connect, first, as));
      case "suspend":
        return console.log(await suspendApp(connect, first, as, second));
      case "lift":
        return console.log(await liftSuspension(connect, first, as));
      default:
        console.log("Commands: pending, approve, reject, delist, relist, suspend, lift. See scripts/directory.ts.");
        process.exitCode = 1;
    }
  } finally {
    await close();
  }
}
main().catch((e: unknown) => {
  // Relay's own sentence for a refusal; never a database's message, which can carry row values.
  console.error(e instanceof DomainError ? e.message : `The command failed (${(e as { code?: string }).code ?? "unknown"}).`);
  process.exitCode = 1;
});

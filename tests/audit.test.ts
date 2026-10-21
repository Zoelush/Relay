import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { saveRole, setTeammateRole } from "../server/people-settings";
import { saveTag } from "../server/workspace-data";
import { changeDeveloperTokens } from "../server/developer";
import { changeApps } from "../server/oauth";
import { handleRest } from "../server/rest";
import { conversationContext } from "../server/context";
import { auditExportJob, changeAudit, pruneAudit, readAudit } from "../server/audit";
import { TABLE_ACTIONS, VERBS, describeAction } from "../lib/audit-actions";
import { localAttachmentStorage } from "../scripts/local-storage";
import type { Job } from "../server/jobs";

/**
 * The audit log (phase 16, C1; docs/SECURITY_STEP1.md): administrative changes are recorded by
 * the database in the change's own transaction, with who made them (and whether through an API
 * token), never with a secret; opening a customer's record is recorded once an hour; the log
 * can't be changed or deleted except by retention; it's filtered, paged and exported (CSV safe
 * against formulas); every workspace sees only its own; the registry names every trigger's actions.
 */
test("audit log: recorded by the database with its actor, append-only, filtered, exported, kept, per workspace", async () => {
  const db = await testDatabase();
  const q = <T = Record<string, unknown>>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const events = (w: string, action?: string) =>
    q<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      actor_name: string | null;
      via: string | null;
      target_id: string | null;
      target_name: string | null;
      details: Record<string, unknown>;
    }>(w, `SELECT action,actor_type,actor_id,actor_name,via,target_id,target_name,details FROM audit_events${action ? " WHERE action=$1" : ""} ORDER BY seq`, action ? [action] : []);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','agent')");
    const before = (await events("a")).length;
    const owner = (await q<{ id: string; name: string }>("a", "SELECT id,name FROM teammates WHERE principal_id='owner-a'"))[0];

    // Roles: created with its permissions, a teammate moved to it. Each by the owner, with from and to.
    const role = (await tenant(db.connect, "a", (x) => saveRole(x, "a", "owner-a", { name: "Outsourced", capabilities: ["conversations.read", "conversations.reply"] }))) as { id: string };
    await tenant(db.connect, "a", (x) => setTeammateRole(x, "a", "owner-a", { teammateId: "grace", roleId: role.id }));
    const created = (await events("a", "role.created")).find((e) => e.target_name === "Outsourced")!;
    assert.deepEqual([created.actor_type, created.actor_id, created.actor_name, created.target_name], ["teammate", owner.id, owner.name, "Outsourced"]);
    assert.deepEqual(
      (await events("a", "role.permission.granted"))
        .filter((e) => e.target_id === role.id)
        .map((e) => [e.target_name, e.actor_id])
        .sort(),
      [
        ["conversations.read", owner.id],
        ["conversations.reply", owner.id],
      ],
    );
    const moved = (await events("a", "teammate.changed")).at(-1)!;
    assert.deepEqual([moved.target_name, moved.details.role_id], ["Grace", { from: "agent", to: role.id }]);

    // A token made and revoked: recorded, with no hash or secret anywhere.
    const token = (await tenant(db.connect, "a", (x) =>
      changeDeveloperTokens(x, "a", "owner-a", { action: "create", name: "Exports", scopes: ["contacts.personal_data", "conversations.reply", "workspace.manage", "data.export"] }),
    )) as {
      id: string;
      token: string;
    };
    const app = (await tenant(db.connect, "a", (x) =>
      changeApps(x, "a", "owner-a", { action: "create", name: "Sync", redirectUris: ["https://sync.example/cb"], scopes: ["conversations.read"] }),
    )) as { clientSecret: string };
    await tenant(db.connect, "a", (x) => changeApps(x, "a", "owner-a", { action: "secret", id: (app as unknown as { id: string }).id }));
    assert.equal((await events("a", "api_token.created"))[0].target_name, "Exports");
    const newSecret = (await events("a", "oauth_app.changed")).at(-1)!.details;
    assert.equal(newSecret.secret, "replaced");
    assert.ok(!("secret_hash" in newSecret));
    const all = JSON.stringify(await q("a", "SELECT * FROM audit_events"));
    assert.ok(!all.includes(token.token) && !all.includes(app.clientSecret) && !/[0-9a-f]{64}/.test(all), "no secret or hash is copied into the log");

    // Through the API: the same teammate, via the token. Reading a contact is recorded once an hour.
    const rest = async (path: string, body?: unknown) =>
      (await (
        await handleRest(
          new Request("http://api.test/rest" + path, {
            method: body ? "POST" : "GET",
            headers: { authorization: "Bearer " + token.token, "content-type": "application/json" },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          { connect: db.connect },
        )
      ).json()) as { id: string };
    const contact = await rest("/contacts", { email: "ada@example.test", name: "Ada" });
    const conversation = await rest("/conversations", { contact_id: contact.id, body: "Hello" });
    await rest("/contacts/" + contact.id);
    await rest("/contacts/" + contact.id);
    const viewed = await events("a", "contact.viewed");
    assert.equal(viewed.length, 1, "once an hour per teammate and record");
    assert.deepEqual([viewed[0].actor_id, viewed[0].via, viewed[0].target_id, viewed[0].details.where], [owner.id, "api_token:" + token.id, contact.id, "api"]);
    await rest("/exports", { resources: ["contacts"] });
    assert.equal((await events("a", "data.export_requested"))[0].via, "api_token:" + token.id);

    // In the inbox: Grace opens the conversation's details; recorded as hers, whether she sees personal data or not.
    await tenant(db.connect, "a", (x) => conversationContext(x, "a", "grace-a", conversation.id));
    await tenant(db.connect, "a", (x) => conversationContext(x, "a", "grace-a", conversation.id));
    const hers = (await events("a", "contact.viewed")).filter((e) => e.actor_id === "grace");
    assert.deepEqual(
      hers.map((e) => [e.details.where, e.details.personalData, e.details.conversationId]),
      [["inbox", false, conversation.id]],
    );

    // A tag whose name is a formula, for the export below.
    await tenant(db.connect, "a", (x) => saveTag(x, "a", "owner-a", { name: "=HYPERLINK(1)" }));

    // Append-only: no update or delete, even with the table's own access.
    await assert.rejects(q("a", "UPDATE audit_events SET actor_name='someone else'"), /append-only/);
    await assert.rejects(q("a", "DELETE FROM audit_events"), /append-only/);

    // Reading: who manages the workspace only; filters by area, teammate and text; pages newest first.
    await assert.rejects(
      tenant(db.connect, "a", (x) => readAudit(x, "a", "grace-a", {})),
      /permission/,
    );
    const read = (f: Record<string, string>) => tenant(db.connect, "a", (x) => readAudit(x, "a", "owner-a", f));
    const page = await read({});
    assert.ok(page.events.length > 10 && page.events.length <= 50);
    // Newest first, by number (seq 100 comes before seq 99).
    const newest = (await q<{ n: string }>("a", "SELECT max(seq)::text AS n FROM audit_events"))[0].n;
    assert.equal(page.events[0].id, newest);
    assert.ok(
      page.events.every((e, i) => i === 0 || Number(e.id) < Number(page.events[i - 1].id)),
      "newest first",
    );
    assert.ok(page.events.length + before <= (await events("a")).length + before);
    assert.deepEqual([...new Set((await read({ area: "Developers" })).events.map((e) => e.area))], ["Developers"]);
    assert.ok((await read({ actor: "grace" })).events.every((e) => e.actor.id === "grace"));
    assert.deepEqual((await read({ q: "Outsourced" })).events.map((e) => e.label).sort(), ["Role created", "Role permission granted", "Role permission granted"]);
    const labelled = (await read({ area: "People and roles" })).events.find((e) => e.action === "teammate.changed")!;
    assert.deepEqual([labelled.label, labelled.actor.name], ["Teammate changed", owner.name]);
    await assert.rejects(read({ from: "yesterday" }), /ISO 8601/);
    const small = (await tenant(db.connect, "a", (x) => x.query("SELECT count(*)::int AS n FROM audit_events"))).rows[0] as { n: number };
    if (small.n > 50) {
      const second = await read({ before: page.next! });
      assert.ok(second.events.every((e) => Number(e.id) < Number(page.events.at(-1)!.id)));
    }
    // Another workspace sees only its own.
    const theirs = await tenant(db.connect, "b", (x) => readAudit(x, "b", "owner-b", {}));
    assert.ok(theirs.events.every((e) => !["Outsourced", "Grace", "Exports"].includes(e.target.name ?? "")));
    // Off: not found.
    await q("b", "UPDATE workspace_features SET enabled=false WHERE name='security_v1'");
    await assert.rejects(
      tenant(db.connect, "b", (x) => readAudit(x, "b", "owner-b", {})),
      /isn't turned on/,
    );

    // Export: asked for (and recorded), then the job writes every match, a formula made harmless.
    await assert.rejects(
      tenant(db.connect, "a", (x) => changeAudit(x, "a", "owner-a", { action: "export", format: "csv", filters: { from: "nope" } })),
      /ISO 8601/,
    );
    const { id } = await tenant(db.connect, "a", (x) => changeAudit(x, "a", "owner-a", { action: "export", format: "csv", filters: { area: "Data" } }));
    assert.equal((await events("a", "audit.exported")).length, 1);
    const storage = localAttachmentStorage().storage;
    const job = (await q<Job>("a", "SELECT * FROM jobs WHERE id=$1", [id]))[0];
    const done = await auditExportJob(db.connect, storage, job);
    const file = await (await storage.readClean!(String(done.result.key))).text();
    const lines = file.trim().split("\n");
    assert.equal(lines[0], "at,action,label,area,actor_type,actor_id,actor_name,via,target_type,target_id,target_name,details");
    assert.equal(lines.length - 1, done.result.rows);
    assert.ok(file.includes(`"'=HYPERLINK(1)"`), "a formula is neutralised");
    assert.ok(lines.slice(1).every((l) => /"Data"/.test(l)));

    // Retention: 90 days to 7 years, recorded; pruning removes only what's older.
    await assert.rejects(
      tenant(db.connect, "a", (x) => changeAudit(x, "a", "owner-a", { action: "retention", retentionDays: 30 })),
      /90 days to 7 years/,
    );
    await tenant(db.connect, "a", (x) => changeAudit(x, "a", "owner-a", { action: "retention", retentionDays: 90 }));
    assert.deepEqual((await events("a", "audit_settings.created"))[0].details.retention_days, 90);
    await q("a", "INSERT INTO audit_events(workspace_id,at,action,actor_type,target_type) VALUES('a',now()-interval '91 days','tag.created','system','tag')");
    const count = async () => (await q<{ n: number }>("a", "SELECT count(*)::int AS n FROM audit_events"))[0].n;
    const total = await count();
    assert.equal(await pruneAudit(db.connect, "a"), 1);
    assert.equal(await count(), total - 1);

    // The registry names every trigger's prefix, and every registry prefix has a trigger.
    const triggers = await q<{ args: string }>("a", "SELECT encode(tgargs,'escape') AS args FROM pg_trigger WHERE tgfoid='audit_row'::regproc");
    const prefixes = new Set(triggers.map((t) => t.args.split("\\000")[0]));
    assert.deepEqual([...prefixes].sort(), Object.keys(TABLE_ACTIONS).sort());
    for (const t of triggers) for (const verb of t.args.split("\\000").slice(5, 7).filter(Boolean)) assert.ok(VERBS[verb], `no words for ${verb}`);
    assert.equal(describeAction("role.permission.granted").label, "Role permission granted");

    // The rollback: recording stops, the log stays.
    const rollback = await readFile("db/rollback/0081_audit_log.sql", "utf8");
    const kept = await count();
    // Run as the database's owner, as migrations and rollbacks are (dropping a trigger needs it).
    for (const statement of rollback
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((s) => s.trim()))
      await db.pg.exec(statement);
    await tenant(db.connect, "a", (x) => saveTag(x, "a", "owner-a", { name: "After rollback" }));
    assert.equal(await count(), kept);
  } finally {
    await db.close();
  }
});

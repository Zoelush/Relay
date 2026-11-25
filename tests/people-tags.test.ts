import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, mergeVisitorIdentity, reverseContactMerge, seedFoundation } from "../server/people";
import { changeDeveloperTokens } from "../server/developer";
import { handleRest } from "../server/rest";
import { command } from "../server/conversations";
import { conversationContext } from "../server/context";
import { erase, findSubject } from "../server/erasure";
import { attachCompany } from "../server/companies";
import { changePeopleTags, contactTagsOf, readPeopleTags, tagContact } from "../server/people-tags";

/**
 * Tags on people (docs/PEOPLE_STEP3.md, phase 01 P1c): contacts and companies tagged from the same
 * tags as conversations, by the API and teammates; an archived tag taken off but never put on
 * again; webhooks; carried through a merge and taken away by its reversal; gone with a deleted
 * company or an erased person; per workspace; and one writer.
 */
test("tags on people: the API and the inbox, archived tags, webhooks, merges, deletion and erasure; per workspace", async () => {
  const db = await testDatabase();
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const as = <T>(w: string, f: (x: Parameters<Parameters<typeof tenant>[2]>[0]) => Promise<T>) => tenant(db.connect, w, f);
  try {
    for (const w of ["a", "b"]) {
      await as(w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true WHERE name='developer_api_v1'");
      await q(w, "INSERT INTO tags(workspace_id,id,name) VALUES($1,'vip','VIP'),($1,'churn','Churn risk'),($1,'old','Old campaign')", [w]);
    }
    await q("a", "UPDATE tags SET archived_at=now() WHERE id='old'");
    await q("a", "INSERT INTO webhook_subscriptions(workspace_id,id,url,topics,version,secret_sealed,created_by) VALUES('a','hook','https://hooks.test/x',$1,'2026-10-20','x','owner-a')", [
      ["contact.tagged", "contact.untagged", "company.tagged", "company.untagged"],
    ]);
    const events = async () => (await q<{ topic: string; detail: any }>("a", "SELECT topic,detail FROM webhook_events ORDER BY created_at,id")).map((e) => `${e.topic}:${e.detail.tag_id}`);

    /* ---- The API ---------------------------------------------------------------------------- */
    const { token } = (await as("a", (x) => changeDeveloperTokens(x, "a", "owner-a", { action: "create", name: "t", scopes: ["contacts.personal_data"] }))) as { token: string };
    const rest = async (method: string, path: string, body?: unknown) => {
      const r = await handleRest(
        new Request("http://api.test/rest" + path, {
          method,
          headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        { connect: db.connect },
      );
      return { status: r.status, body: (await r.json()) as any };
    };
    const ada = await rest("POST", "/contacts", { external_id: "ada", name: "Ada" });
    assert.deepEqual(ada.body.tags, [], "a contact has tags now, none to begin with");
    const tagged = await rest("POST", `/contacts/${ada.body.id}/tags`, { tag_id: "vip" });
    assert.equal(tagged.status, 200, JSON.stringify(tagged.body));
    assert.deepEqual(tagged.body.tags, [{ type: "tag", id: "vip", name: "VIP" }]);
    assert.deepEqual((await rest("POST", `/contacts/${ada.body.id}/tags`, { tag_id: "vip" })).body.tags.length, 1, "tagging again changes nothing");
    const archived = await rest("POST", `/contacts/${ada.body.id}/tags`, { tag_id: "old" });
    assert.equal(archived.status, 400);
    assert.match(archived.body.errors[0].message, /archived/);
    assert.equal((await rest("POST", `/contacts/${ada.body.id}/tags`, { tag_id: "nope" })).status, 404);

    const acme = await rest("POST", "/companies", { company_id: "acme", name: "Acme" });
    assert.deepEqual((await rest("POST", `/companies/${acme.body.id}/tags`, { tag_id: "churn" })).body.tags, [{ type: "tag", id: "churn", name: "Churn risk" }]);
    assert.deepEqual((await rest("GET", `/companies/${acme.body.id}`)).body.tags.map((t: any) => t.name), ["Churn risk"]);
    assert.deepEqual((await rest("DELETE", `/companies/${acme.body.id}/tags/churn`)).body.tags, []);
    assert.equal((await rest("DELETE", `/companies/${acme.body.id}/tags/churn`)).status, 404, "it isn't there any more");

    // An archived tag that's already on someone stays, and can be taken off.
    await q("a", "UPDATE tags SET archived_at=NULL WHERE id='old'");
    await rest("POST", `/contacts/${ada.body.id}/tags`, { tag_id: "old" });
    await q("a", "UPDATE tags SET archived_at=now() WHERE id='old'");
    assert.deepEqual((await rest("GET", `/contacts/${ada.body.id}`)).body.tags.map((t: any) => t.id), ["old", "vip"]);
    assert.deepEqual((await rest("DELETE", `/contacts/${ada.body.id}/tags/old`)).body.tags.map((t: any) => t.id), ["vip"]);
    assert.deepEqual(await events(), ["contact.tagged:vip", "company.tagged:churn", "company.untagged:churn", "contact.tagged:old", "contact.untagged:old"]);

    /* ---- The inbox -------------------------------------------------------------------------- */
    assert.deepEqual((await as("a", (x) => readPeopleTags(x, "a", "owner-a"))).tags.map((t) => t.name), ["Churn risk", "VIP"], "the picker leaves archived tags out");
    let after = await as("a", (x) => changePeopleTags(x, "a", "owner-a", crypto.randomUUID(), { action: "add", contactId: ada.body.id, tagId: "churn" }));
    assert.deepEqual(after.tags.map((t) => t.name), ["Churn risk", "VIP"]);
    after = await as("a", (x) => changePeopleTags(x, "a", "owner-a", crypto.randomUUID(), { action: "add", companyId: acme.body.id, tagId: "vip" }));
    assert.deepEqual(after.tags.map((t) => t.name), ["VIP"]);
    await as("a", (x) => attachCompany(x, "a", ada.body.id, acme.body.id, "Founder", "api"));
    const identity = (await q<{ id: string }>("a", "SELECT identity_id AS id FROM identity_contact_mappings WHERE contact_id=$1", [ada.body.id]))[0].id;
    const started = (await as("a", (x) => command(x, "a", { type: "contact", identityId: identity, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "Hi" } as never))) as { conversationId: string };
    const context = (await as("a", (x) => conversationContext(x, "a", "owner-a", started.conversationId))).customer as any;
    assert.deepEqual(context.tags.map((t: any) => t.name), ["Churn risk", "VIP"]);
    assert.deepEqual(context.companies[0].tags.map((t: any) => t.name), ["VIP"]);
    after = await as("a", (x) => changePeopleTags(x, "a", "owner-a", crypto.randomUUID(), { action: "remove", contactId: ada.body.id, tagId: "churn" }));
    assert.deepEqual(after.tags.map((t) => t.name), ["VIP"]);
    await q("a", "INSERT INTO roles(workspace_id,id,name) VALUES('a','reader','Reader')");
    await q("a", "INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES('a','reader','conversations.read')");
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','t-reader','p-reader','Reader','reader')");
    await assert.rejects(as("a", (x) => changePeopleTags(x, "a", "p-reader", crypto.randomUUID(), { action: "add", contactId: ada.body.id, tagId: "churn" })), (e: any) => e.status === 403);
    assert.equal(((await as("a", (x) => conversationContext(x, "a", "p-reader", started.conversationId))).customer as any).tags, undefined, "nor see them");

    /* ---- A deleted company takes its tags, in one event ---------------------------------------- */
    const before = (await events()).length;
    await rest("DELETE", `/companies/${acme.body.id}`);
    assert.deepEqual((await events()).slice(before), [], "no 'untagged' per tag when the company itself goes");
    assert.deepEqual(await q("a", "SELECT * FROM company_tags"), []);

    /* ---- Merges ----------------------------------------------------------------------------- */
    const user = await as("a", (x) => getIdentity(x, "a", "user", "uma", { name: "Uma" }));
    const visitor = await as("a", (x) => getIdentity(x, "a", "anonymous", "device-uma", {}));
    await as("a", (x) => tagContact(x, "a", user.contactId, "vip", "api"));
    await as("a", (x) => tagContact(x, "a", visitor.contactId, "vip", "inbox"));
    await as("a", (x) => tagContact(x, "a", visitor.contactId, "churn", "inbox"));
    const merge = (await as("a", (x) => mergeVisitorIdentity(x, "a", visitor.identityId, user.contactId)))!;
    assert.deepEqual(
      (await q<{ tag_id: string; source: string }>("a", "SELECT tag_id,source FROM contact_tags WHERE contact_id=$1 ORDER BY tag_id", [user.contactId])).map((r) => [r.tag_id, r.source]),
      [["churn", "merge"], ["vip", "api"]],
      "theirs kept; the loser's added, marked as the merge's",
    );
    await as("a", (x) => reverseContactMerge(x, "a", merge));
    assert.deepEqual((await as("a", (x) => contactTagsOf(x, "a", [user.contactId])))[user.contactId].map((t) => t.id), ["vip"]);

    /* ---- Erasure: their tags go; the tags stay -------------------------------------------------- */
    await as("a", async (x) => erase(x, "a", (await findSubject(x, "a", { contactId: ada.body.id }))!));
    assert.deepEqual(await q("a", "SELECT * FROM contact_tags WHERE contact_id=$1", [ada.body.id]), []);
    assert.equal((await q("a", "SELECT name FROM tags WHERE id='vip'"))[0].name, "VIP");

    /* ---- Per workspace ---------------------------------------------------------------------- */
    for (const table of ["contact_tags", "company_tags"]) assert.deepEqual(await q("b", `SELECT * FROM ${table}`), [], `${table}: another workspace sees none`);
    await assert.rejects(as("b", (x) => tagContact(x, "b", user.contactId, "vip", "api")), (e: any) => e.code !== undefined || /foreign key|violates/.test(String(e.message)));

    /* ---- One writer --------------------------------------------------------------------------- */
    const offenders: string[] = [];
    for (const dir of ["server", "workers", "scripts", "lib", "app", "tests"]) {
      let files: string[] = [];
      try {
        files = (await readdir(dir, { recursive: true })) as string[];
      } catch {
        continue;
      }
      for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x))) {
        const path = `${dir}/${f}`;
        if (path === "server/people-tags.ts" || path === "tests/people-tags.test.ts") continue;
        if (/(INSERT INTO|UPDATE|DELETE FROM) (contact_tags|company_tags)\b/.test(await readFile(path, "utf8"))) offenders.push(path);
      }
    }
    assert.deepEqual(offenders, [], "write tags on people through server/people-tags.ts");
  } finally {
    await db.close();
  }
});

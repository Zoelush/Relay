import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { changeDeveloperTokens } from "../server/developer";
import { handleRest } from "../server/rest";
import { command } from "../server/conversations";
import { conversationContext } from "../server/context";
import { readContactAttributes, setContactAttributes, typedValue } from "../server/contact-attributes";

/**
 * A contact's custom data as typed values (docs/PEOPLE_STEP1.md, phase 01 P1a): one writer for
 * every source, values typed by their definitions and refused in words when they don't fit,
 * profile kept in step for one release, the API and the inbox sidebar reading the typed store,
 * and nothing else writing contacts.profile.
 */
test("contact attributes: typed by their definitions, written by one writer, read by the API and the sidebar", async () => {
  const db = await testDatabase();
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true WHERE name='developer_api_v1'");
    }

    /* ---- Each type: what fits, and what is refused, in words naming the attribute -------------- */
    const def = (value_type: string, options: string[] | null = null) => ({ name: "x", value_type: value_type as never, options });
    assert.deepEqual(typedValue(def("string"), 12).text_value, "12", "a number into text is its text");
    assert.equal(typedValue(def("integer"), "7").number_value, "7");
    assert.throws(() => typedValue(def("integer"), 1.5), /x is a whole number/);
    assert.equal(typedValue(def("float"), 1.5).number_value, "1.5");
    assert.throws(() => typedValue(def("float"), "lots"), /x is a number/);
    assert.equal(typedValue(def("boolean"), "false").bool_value, false);
    assert.throws(() => typedValue(def("boolean"), "maybe"), /true or false/);
    assert.equal(typedValue(def("date"), 1_700_000_000).date_value, "2023-11-14T22:13:20.000Z", "Unix seconds, as Intercom sends dates");
    assert.equal(typedValue(def("date"), "2026-11-24").date_value, "2026-11-24T00:00:00.000Z");
    assert.throws(() => typedValue(def("options", ["gold", "silver"]), "bronze"), /one of: gold, silver/);
    assert.throws(() => typedValue(def("string"), "y".repeat(256)), /up to 255/);

    /* ---- The one writer: defined by a first value, typed after that, cleared by null ------------ */
    const ada = await tenant(db.connect, "a", (x) => getIdentity(x, "a", "user", "ada", { name: "Ada", email: "ada@example.com" }));
    await tenant(db.connect, "a", (x) => setContactAttributes(x, "a", ada.contactId, { plan: "pro", seats: 3, beta: true, mrr: 49.5 }, { define: true }));
    assert.deepEqual(
      Object.fromEntries((await q<{ name: string; value_type: string }>("a", "SELECT name,value_type FROM attribute_definitions WHERE owner_type='contact'")).map((d) => [d.name, d.value_type])),
      { beta: "boolean", mrr: "float", plan: "string", seats: "integer" },
    );
    await assert.rejects(
      tenant(db.connect, "a", (x) => setContactAttributes(x, "a", ada.contactId, { seats: "lots" }, { define: true })),
      (e: { code?: string; details?: { field?: string }; message?: string }) => e.code === "INVALID_FIELD" && e.details?.field === "custom_attributes.seats" && /seats is a number/.test(e.message ?? ""),
    );
    await assert.rejects(tenant(db.connect, "a", (x) => setContactAttributes(x, "a", ada.contactId, { unknown_thing: 1 }, { define: false })), /no customer attribute called unknown_thing/);
    // A key in another case is the same attribute.
    await tenant(db.connect, "a", (x) => setContactAttributes(x, "a", ada.contactId, { PLAN: "enterprise", beta: null }, { define: true }));
    const values = (await tenant(db.connect, "a", (x) => readContactAttributes(x, "a", [ada.contactId])))[ada.contactId];
    assert.deepEqual(values, { plan: "enterprise", seats: 3, mrr: 49.5 }, "typed back to JSON, null cleared");
    assert.deepEqual((await q("a", "SELECT profile FROM contacts WHERE id=$1", [ada.contactId]))[0].profile, values, "profile kept in step, for one release");
    // Archived means nothing writes it any more.
    await q("a", "UPDATE attribute_definitions SET archived_at=now() WHERE name='mrr'");
    await assert.rejects(tenant(db.connect, "a", (x) => setContactAttributes(x, "a", ada.contactId, { mrr: 1 }, { define: true })), /mrr is archived/);
    assert.deepEqual((await tenant(db.connect, "a", (x) => readContactAttributes(x, "a", [ada.contactId])))[ada.contactId], { plan: "enterprise", seats: 3 }, "and isn't read");

    /* ---- The API: written and read typed, refused with the field named ------------------------ */
    const { token } = (await tenant(db.connect, "a", (x) =>
      changeDeveloperTokens(x, "a", "owner-a", { action: "create", name: "t", scopes: ["contacts.personal_data", "conversations.read"] }),
    )) as { token: string };
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
    const made = await rest("POST", "/contacts", { external_id: "grace", name: "Grace", custom_attributes: { plan: "free", seats: 1, signed_terms: true } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.custom_attributes, { plan: "free", seats: 1, signed_terms: true });
    const refused = await rest("PATCH", `/contacts/${made.body.id}`, { custom_attributes: { seats: "lots" } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.errors[0].field, "custom_attributes.seats");
    const cleared = await rest("PATCH", `/contacts/${made.body.id}`, { custom_attributes: { plan: null, seats: "4" } });
    assert.deepEqual(cleared.body.custom_attributes, { seats: 4, signed_terms: true }, "null clears, and a numeric string becomes the number its type asks for");

    /* ---- The inbox sidebar shows them, to who may see personal data ---------------------------- */
    const started = (await tenant(db.connect, "a", (x) =>
      command(x, "a", { type: "contact", identityId: ada.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "Hello" } as never),
    )) as { conversationId: string };
    const context = await tenant(db.connect, "a", (x) => conversationContext(x, "a", "owner-a", started.conversationId));
    assert.deepEqual((context.customer as { customAttributes?: unknown }).customAttributes, { plan: "enterprise", seats: 3 });

    /* ---- Per workspace ---------------------------------------------------------------------- */
    assert.deepEqual(await q("b", "SELECT * FROM contact_attribute_values"), [], "another workspace sees none of them");

    /* ---- Nothing but the one writer writes contacts.profile ------------------------------------ */
    const offenders: string[] = [];
    // Tests too: a test that seeds profile directly would now be testing data nobody reads. The one
    // exception is the segments corpus, which writes the old way on purpose to prove the backfill.
    for (const dir of ["server", "workers", "scripts", "lib", "app", "tests"]) {
      let files: string[] = [];
      try {
        files = (await readdir(dir, { recursive: true })) as string[];
      } catch {
        continue;
      }
      for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x) && x !== "contact-attributes.ts" && x !== "contact-attributes.test.ts" && !(dir === "tests" && x === "segments.test.ts"))) {
        const source = await readFile(`${dir}/${f}`, "utf8");
        if (/UPDATE contacts[^`"]*SET[^`"]*\bprofile\s*=|INSERT INTO contacts\s*\([^)]*\bprofile\b/.test(source)) offenders.push(`${dir}/${f}`);
      }
    }
    assert.deepEqual(offenders, [], "write custom data through server/contact-attributes.ts");
  } finally {
    await db.close();
  }
});

import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { recordAudit } from "./audit";
import { pairOf } from "./test-workspace";
import { workflowReferences } from "./workflows";
import { workflowsEnabled } from "./workflow-engine";
import { aiEnabled, agentRow, DEFAULT_AGENT } from "./ai-agent";
import { problems, type Definition } from "../lib/workflow-definition";
import { validGuidelines, validVoice } from "./zoe-guidance";
import type { Guideline } from "../lib/zoe-voice";

/**
 * Promoting a change from a test workspace to production (docs/TEST_WORKSPACE_PLAN.md, T2a).
 *
 * A team tries a workflow, or Zoe's guidance, against their own setup in the test workspace, and
 * then promotes it deliberately. What promotion means here:
 *
 * - **Only things that publish as versions,** so production keeps what it had and can go back to
 *   it: a promoted workflow is a new published version, and promoted guidance is a new saved
 *   version. T2a does those two. The messenger and a help centre's look follow in T2b, once the
 *   images they refer to can come with them.
 * - **It refuses rather than overwrites.** `test_baselines` holds the two version numbers the pair
 *   was last in step at. If production's copy has moved since, the promotion stops and says so:
 *   Relay cannot know which of the two is the one they meant to keep.
 * - **It refuses rather than inventing.** A workflow that assigns to a team production doesn't
 *   have is refused with that reason, by the same check publishing makes — one definition of what
 *   a workflow needs — and guidance for a specialist or brand production doesn't have likewise.
 * - **Every promotion is recorded** where it landed: an append-only `promotions` row and an audit
 *   event in the production workspace, written in the same transaction as the change.
 *
 * The pair's two version counters run on independently once either side is edited, so a promotion
 * also moves the baseline forward — in that same transaction, which is why baselines live in the
 * production workspace rather than the test one.
 */
export type PromotableKind = "workflow" | "zoe_guidance";
/** The kinds this step promotes. `test_baselines` records the other two ready for T2b. */
export const PROMOTABLE: PromotableKind[] = ["workflow", "zoe_guidance"];

type BaselineRow = { kind: string; object_id: string; version: string; from_version: string };
/**
 * What production's promotable objects are at when the pair is made, written in the production
 * workspace by `createTestWorkspace` after the copy. The copy gives the test workspace the same
 * version numbers, so both sides of a fresh baseline are production's.
 */
export async function recordBaselines(connect: Connect, production: string, test: string) {
  return tenant(connect, production, async (db) => {
    const of = async (sql: string) => (await db.query<{ kind: string; object_id: string; version: string }>(sql, [production])).rows;
    const rows = [
      ...(await of("SELECT 'workflow' AS kind,id AS object_id,version::text AS version FROM workflows WHERE workspace_id=$1")),
      ...(await of("SELECT 'zoe_guidance' AS kind,id AS object_id,guidance_version::text AS version FROM ai_agents WHERE workspace_id=$1")),
      ...(await of(
        "SELECT 'messenger' AS kind,brand_id AS object_id,COALESCE(max(version),0)::text AS version FROM messenger_versions WHERE workspace_id=$1 GROUP BY brand_id",
      )),
      ...(await of("SELECT 'help_center' AS kind,id AS object_id,version::text AS version FROM help_centers WHERE workspace_id=$1")),
    ];
    for (const r of rows)
      await db.query(
        "INSERT INTO test_baselines(workspace_id,test_workspace,kind,object_id,version,from_version) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING",
        [production, test, r.kind, r.object_id, Number(r.version)],
      );
    return rows.length;
  });
}

/** Where a candidate stands, and what to say about it. */
type Status = "ready" | "unchanged" | "changed_in_production" | "needs" | "name_taken";
type Candidate = {
  kind: PromotableKind;
  id: string;
  name: string;
  /** The version in the test workspace, what production is at, and where they were last in step. */
  here: number;
  there: number | null;
  baseline: { version: number; from: number } | null;
  status: Status;
  why: string;
  /** What production is missing, for `needs`: each a plain sentence. */
  missing: string[];
};

/** The test workspace's side of a candidate: enough to judge it and to promote it. */
type Side =
  | { kind: "workflow"; id: string; name: string; version: number; definition: Definition | null }
  | {
      kind: "zoe_guidance";
      id: string;
      name: string;
      version: number;
      voice: { tone: string; length: string; formality: string };
      guidance: Guideline[];
    };

/**
 * The production workspace this test workspace promotes into. Whoever asks must be allowed to
 * manage the workspace they are in before anything about the pair is answered, and allowed to
 * manage production before anything lands there.
 */
async function pairFor(connect: Connect, test: string, principal: string) {
  const pair = await tenant(connect, test, async (db) => {
    await authorize(db, test, principal, "workspace.manage");
    return pairOf(db, test);
  });
  assert(pair && pair.here === "test" && pair.counterpart, "NOT_A_TEST_WORKSPACE", "Only a test workspace promotes into another.", 404);
  return pair.counterpart as string;
}

/** Everything the test workspace holds that could be promoted, read in its own transaction. */
async function readSides(connect: Connect, test: string) {
  return tenant(connect, test, async (db) => {
    const sides: Side[] = [];
    if (await workflowsEnabled(db, test))
      for (const wf of (
        await db.query<{ id: string; name: string; version: string; live_version: number | null }>(
          "SELECT id,name,version::text AS version,live_version FROM workflows WHERE workspace_id=$1 AND NOT archived ORDER BY lower(name),id",
          [test],
        )
      ).rows) {
        // Only what was published here: what is promoted is what they tried, never a draft.
        const definition = wf.live_version
          ? (
              await db.query<{ definition: Definition }>("SELECT definition FROM workflow_versions WHERE workspace_id=$1 AND workflow_id=$2 AND version=$3", [
                test,
                wf.id,
                wf.live_version,
              ])
            ).rows[0]?.definition ?? null
          : null;
        sides.push({ kind: "workflow", id: wf.id, name: wf.name, version: Number(wf.version), definition });
      }
    if (await aiEnabled(db, test))
      for (const a of (
        await db.query<{
          id: string;
          name: string;
          guidance_version: number;
          tone: string;
          answer_length: string;
          formality: string;
          answer_guidance: Guideline[];
        }>("SELECT id,name,guidance_version,tone,answer_length,formality,answer_guidance FROM ai_agents WHERE workspace_id=$1 ORDER BY id", [test])
      ).rows)
        sides.push({
          kind: "zoe_guidance",
          id: a.id,
          name: a.name,
          version: a.guidance_version,
          voice: { tone: a.tone, length: a.answer_length, formality: a.formality },
          guidance: a.answer_guidance,
        });
    return sides;
  });
}

/** What production is missing for this change: the same checks its own editors make. */
async function missingIn(db: Sql, production: string, side: Side) {
  if (side.kind === "workflow") {
    if (!side.definition) return [];
    return [...problems(side.definition), ...(await workflowReferences(db, production, side.definition, side.id))];
  }
  const brands = new Set((await db.query<{ id: string }>("SELECT id FROM brands WHERE workspace_id=$1", [production])).rows.map((r) => r.id));
  const specialists = new Set((await db.query<{ id: string }>("SELECT id FROM ai_specialists WHERE workspace_id=$1", [production])).rows.map((r) => r.id));
  const out: string[] = [];
  for (const g of side.guidance) {
    if (g.brandId && !brands.has(g.brandId)) out.push(`“${g.title}” is for a brand production doesn't have.`);
    if (g.specialistId && !specialists.has(g.specialistId)) out.push(`“${g.title}” is for a specialist production doesn't have.`);
  }
  return out;
}

/**
 * Judges candidates against production, in a transaction there: so the answer the page shows and
 * the answer a promotion acts on are the same answer, made the same way.
 */
async function judge(db: Sql, production: string, test: string, sides: Side[]) {
  const baselines = new Map(
    (
      await db.query<BaselineRow>(
        "SELECT kind,object_id,version::text AS version,from_version::text AS from_version FROM test_baselines WHERE workspace_id=$1 AND test_workspace=$2",
        [production, test],
      )
    ).rows.map((b) => [`${b.kind}:${b.object_id}`, { version: Number(b.version), from: Number(b.from_version) }]),
  );
  const workflows = new Map(
    (await db.query<{ id: string; version: string }>("SELECT id,version::text AS version FROM workflows WHERE workspace_id=$1", [production])).rows.map((r) => [
      r.id,
      Number(r.version),
    ]),
  );
  const agents = new Map(
    (await db.query<{ id: string; guidance_version: number }>("SELECT id,guidance_version FROM ai_agents WHERE workspace_id=$1", [production])).rows.map((r) => [
      r.id,
      r.guidance_version,
    ]),
  );
  const out: Candidate[] = [];
  for (const side of sides) {
    const baseline = baselines.get(`${side.kind}:${side.id}`) ?? null;
    const there = side.kind === "workflow" ? workflows.get(side.id) ?? null : agents.get(side.id) ?? null;
    const c: Candidate = { kind: side.kind, id: side.id, name: side.name, here: side.version, there, baseline, status: "ready", why: "", missing: [] };
    const say = (status: Status, why: string, missing: string[] = []) => out.push({ ...c, status, why, missing });
    if (side.kind === "workflow" && !side.definition) {
      say("unchanged", "Publish it in the test workspace first, so what is promoted is what you tried.");
      continue;
    }
    if (side.kind === "zoe_guidance" && side.id !== DEFAULT_AGENT && there === null) {
      say("needs", "Production is missing something this needs.", ["Zoe isn't set up in production with this agent."]);
      continue;
    }
    if (side.kind === "zoe_guidance" && side.version === 0) {
      say("unchanged", "Her guidance hasn't been saved in this test workspace yet.");
      continue;
    }
    if (baseline && there !== null && there > baseline.version) {
      say("changed_in_production", "It changed in production since the two were last in step, so promoting it would overwrite that change.");
      continue;
    }
    if (baseline && side.version <= baseline.from) {
      say("unchanged", "Nothing has changed here since the two were last in step.");
      continue;
    }
    const missing = await missingIn(db, production, side);
    if (missing.length) {
      say("needs", "Production is missing something this needs.", missing);
      continue;
    }
    if (side.kind === "workflow") {
      const clash = (
        await db.query<{ name: string }>("SELECT name FROM workflows WHERE workspace_id=$1 AND lower(name)=lower($2) AND NOT archived AND id<>$3", [
          production,
          side.name,
          side.id,
        ])
      ).rows[0];
      if (clash) {
        say("name_taken", `Another workflow in production is already called ${clash.name}.`);
        continue;
      }
    }
    say("ready", there === null ? "New here: production doesn't have it yet." : "Changed here, and untouched in production since.");
  }
  return out;
}

/** What this test workspace could promote, and what stands in the way of each. */
export async function readPromotable(connect: Connect, test: string, principal: string) {
  const production = await pairFor(connect, test, principal);
  const sides = await readSides(connect, test);
  return tenant(connect, production, async (db) => {
    await authorize(db, production, principal, "workspace.manage");
    const name = (await db.query<{ brand: string }>("SELECT brand FROM workspace WHERE id=$1", [production])).rows[0]?.brand ?? "";
    return { into: { id: production, name }, candidates: await judge(db, production, test, sides) };
  });
}

/** Promotes one object into production. Refused unless it is ready, in its own words. */
export async function promote(connect: Connect, test: string, principal: string, p: Record<string, unknown>) {
  const kind = String(p.kind ?? "");
  const id = String(p.id ?? "");
  assert(
    (PROMOTABLE as string[]).includes(kind),
    "INVALID_FIELD",
    "A test workspace promotes a workflow or Zoe's guidance. The messenger and your help centre come next.",
    400,
  );
  const production = await pairFor(connect, test, principal);
  const sides = await readSides(connect, test);
  const side = sides.find((s) => s.kind === kind && s.id === id);
  assert(side, "NOT_FOUND", "That isn't in this test workspace.", 404);

  return tenant(connect, production, async (db) => {
    const me = await authorize(db, production, principal, "workspace.manage");
    // Judged here, in the transaction that writes: what the page showed cannot have gone stale.
    const candidate = (await judge(db, production, test, [side])).find((x) => x.id === id);
    assert(candidate, "NOT_FOUND", "That isn't in this test workspace.", 404);
    if (candidate.status !== "ready")
      throw new DomainError(candidate.status === "needs" ? "PROMOTION_NEEDS" : "NOT_PROMOTABLE", candidate.why, 409, {
        status: candidate.status,
        missing: candidate.missing,
      });

    let published: number;
    let previous: unknown = null;
    if (side.kind === "workflow") {
      const definition = side.definition as Definition;
      const existing = (await db.query("SELECT 1 FROM workflows WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [production, id])).rows[0];
      if (!existing) {
        const last = (
          await db.query<{ n: number | null }>("SELECT max(priority) AS n FROM workflows WHERE workspace_id=$1 AND trigger=$2 AND NOT archived", [
            production,
            definition.trigger.type,
          ])
        ).rows[0].n;
        await db.query("INSERT INTO workflows(workspace_id,id,name,trigger,priority,draft,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7)", [
          production,
          id,
          side.name,
          definition.trigger.type,
          (last ?? -1) + 1,
          JSON.stringify(definition),
          me.id,
        ]);
      }
      published =
        ((await db.query<{ v: number | null }>("SELECT max(version) AS v FROM workflow_versions WHERE workspace_id=$1 AND workflow_id=$2", [production, id])).rows[0].v ?? 0) + 1;
      await db.query("INSERT INTO workflow_versions(workspace_id,workflow_id,version,definition,published_by) VALUES($1,$2,$3,$4,$5)", [
        production,
        id,
        published,
        JSON.stringify(definition),
        me.id,
      ]);
      // Live, with the draft matching what is live, as publishing there leaves it.
      await db.query(
        `UPDATE workflows SET name=$4,draft=$5,trigger=$6,live_version=$7,state='live',version=version+1,updated_by=$3,updated_at=now()
         WHERE workspace_id=$1 AND id=$2`,
        [production, id, me.id, side.name, JSON.stringify(definition), definition.trigger.type, published],
      );
    } else {
      // Her guidance, checked against production's brands and specialists as a save there would be.
      const voice = validVoice({ tone: side.voice.tone, length: side.voice.length, formality: side.voice.formality });
      const brands = (await db.query<{ id: string }>("SELECT id FROM brands WHERE workspace_id=$1", [production])).rows.map((r) => r.id);
      const specialists = (await db.query<{ id: string }>("SELECT id FROM ai_specialists WHERE workspace_id=$1", [production])).rows.map((r) => r.id);
      const guidance = validGuidelines(side.guidance, brands, specialists);
      // Her row in production is made on demand, exactly as opening her Guidance page makes it.
      if (id === DEFAULT_AGENT) await agentRow(db, production);
      const was = (
        await db.query<{ guidance_version: number; tone: string; answer_length: string; formality: string }>(
          "SELECT guidance_version,tone,answer_length,formality FROM ai_agents WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [production, id],
        )
      ).rows[0];
      assert(was, "NOT_FOUND", "That agent isn't in the production workspace.", 404);
      previous = { version: was.guidance_version, tone: was.tone, answer_length: was.answer_length, formality: was.formality };
      published = was.guidance_version + 1;
      await db.query(
        "UPDATE ai_agents SET tone=$3,answer_length=$4,formality=$5,answer_guidance=$6,guidance_version=$7,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [production, id, voice.tone, voice.length, voice.formality, JSON.stringify(guidance), published],
      );
      await db.query(
        `INSERT INTO ai_guidance_versions(workspace_id,agent_id,version,tone,answer_length,formality,guidance,saved_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [production, id, published, voice.tone, voice.length, voice.formality, JSON.stringify(guidance), me.id],
      );
    }

    // The two are in step again, at the versions they now hold — the mark moved by the same
    // transaction as the change, so a promotion is never mistaken for an edit made here.
    const now =
      side.kind === "workflow"
        ? Number((await db.query<{ version: string }>("SELECT version::text AS version FROM workflows WHERE workspace_id=$1 AND id=$2", [production, id])).rows[0].version)
        : published;
    await db.query(
      `INSERT INTO test_baselines(workspace_id,test_workspace,kind,object_id,version,from_version) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(workspace_id,test_workspace,kind,object_id) DO UPDATE SET version=$5,from_version=$6,synced_at=now()`,
      [production, test, side.kind, id, now, side.version],
    );
    const promotionId = crypto.randomUUID();
    await db.query(
      `INSERT INTO promotions(workspace_id,id,from_workspace,kind,object_id,object_name,from_version,to_version,previous,actor_id,actor_name)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [production, promotionId, test, side.kind, id, side.name, side.version, published, previous === null ? null : JSON.stringify(previous), me.id, me.name],
    );
    await recordAudit(db, production, "workspace.promoted", { type: "workspace", id, name: side.name }, { kind: side.kind, from: test, version: published });
    return { promoted: { id: promotionId, kind: side.kind, objectId: id, name: side.name, version: published } };
  });
}

/** What has been promoted into this workspace, newest first: its own record of where it came from. */
export async function readPromotions(db: Sql, w: string, principal: string, limit = 50) {
  await authorize(db, w, principal, "workspace.manage");
  const rows = (
    await db.query<{
      id: string;
      kind: string;
      object_id: string;
      object_name: string;
      from_workspace: string;
      from_version: string | null;
      to_version: string | null;
      at: string;
      actor_name: string | null;
    }>(
      `SELECT id,kind,object_id,object_name,from_workspace,from_version::text AS from_version,to_version::text AS to_version,at,actor_name
       FROM promotions WHERE workspace_id=$1 ORDER BY at DESC,seq DESC LIMIT $2`,
      [w, Math.min(Math.max(limit, 1), 200)],
    )
  ).rows;
  return {
    promotions: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      objectId: r.object_id,
      name: r.object_name,
      from: r.from_workspace,
      fromVersion: r.from_version === null ? null : Number(r.from_version),
      version: r.to_version === null ? null : Number(r.to_version),
      at: new Date(r.at).toISOString(),
      by: r.actor_name,
    })),
  };
}

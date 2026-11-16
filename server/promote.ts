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
import { assetsIn, checkAssets, mapAssets } from "./brand-assets";
import { messengerV3, validConfig, withLook, type MessengerConfig } from "./messenger-config";
import { checkLook } from "./help-centers";
import { enabled as helpCentersEnabled } from "./help-content";
import { mapThemeFiles, themeFiles, themeOf, type HelpTheme, type LayoutBlock } from "../lib/help-theme";
import { cleanKeyIn, copyBytes, readUploads, writeUpload, type Upload } from "./uploads";
import type { AttachmentStorage } from "./attachments";

/**
 * Promoting a change from a test workspace to production (docs/TEST_WORKSPACE_PLAN.md, T2;
 * docs/TEST_WORKSPACE_STEP3.md and docs/TEST_WORKSPACE_STEP4.md).
 *
 * A team tries a workflow, Zoe's guidance, the messenger or a help centre's look against their own
 * setup in the test workspace, and then promotes it deliberately. What promotion means here:
 *
 * - **Production keeps what it had.** A promoted workflow is a new published version, promoted
 *   guidance a new saved version, a promoted messenger the brand's next published version. A help
 *   centre's look has no versions of its own, so the ledger row holds the look it replaced and
 *   production can put that back (T2b).
 * - **It refuses rather than overwrites.** `test_baselines` holds the two version numbers the pair
 *   was last in step at. If production's copy has moved since, the promotion stops and says so:
 *   Relay cannot know which of the two is the one they meant to keep.
 * - **It refuses rather than inventing.** A workflow that assigns to a team production doesn't
 *   have is refused with that reason, by the same check publishing makes — one definition of what
 *   a workflow needs — and so are guidance for a specialist production hasn't got, a messenger for
 *   a brand it hasn't got, and a look featuring an article it hasn't got.
 * - **An image comes with the change** (T2b). An image the test workspace got from production
 *   keeps its id on both sides and is left alone; one uploaded in the test workspace is copied in
 *   as production's own upload, with a new id, and the promoted configuration is rewritten to name
 *   it. `server/uploads.ts` does the moving.
 * - **Every promotion is recorded** where it landed: an append-only `promotions` row and an audit
 *   event in the production workspace, written in the same transaction as the change.
 *
 * The pair's two version counters run on independently once either side is edited, so a promotion
 * also moves the baseline forward — in that same transaction, which is why baselines live in the
 * production workspace rather than the test one.
 */
export type PromotableKind = "workflow" | "zoe_guidance" | "messenger" | "help_center";
export const PROMOTABLE: PromotableKind[] = ["workflow", "zoe_guidance", "messenger", "help_center"];

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
  /** Images that would come with it: production hasn't got these yet (T2b). */
  brings: { what: string; name: string }[];
};

/** The test workspace's side of a candidate: enough to judge it and to promote it. */
type Side = { id: string; name: string; version: number; uploads: Upload[] } &
  (
    | { kind: "workflow"; definition: Definition | null }
    | { kind: "zoe_guidance"; voice: { tone: string; length: string; formality: string }; guidance: Guideline[] }
    | { kind: "messenger"; config: MessengerConfig | null }
    | { kind: "help_center"; theme: HelpTheme; layout: LayoutBlock[]; featured: { id: string; title: string }[] }
  );

/** What an image is for, in the ledger's own words. */
const WHAT_IMAGE: Record<string, string> = {
  home_logo: "Home screen logo",
  launcher_logo: "launcher logo",
  home_background: "Home background",
  agent_avatar: "Zoe's avatar",
  agent_avatar_dark: "Zoe's dark-theme avatar",
  theme_logo: "logo",
  theme_favicon: "favicon",
  social_image: "social image",
  theme_image: "image",
  article_image: "article image",
};
const describe = (u: Upload) => ({ what: WHAT_IMAGE[u.purpose] ?? "image", name: u.name });

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
        sides.push({ kind: "workflow", id: wf.id, name: wf.name, version: Number(wf.version), definition, uploads: [] });
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
          uploads: [],
        });
    // T2b: the messenger, per brand, as it is published here — with the images it uses.
    if (await messengerV3(db, test))
      for (const b of (await db.query<{ id: string; name: string }>("SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY lower(name),id", [test])).rows) {
        const v = (
          await db.query<{ version: number; config: MessengerConfig }>(
            "SELECT version,config FROM messenger_versions WHERE workspace_id=$1 AND brand_id=$2 ORDER BY version DESC LIMIT 1",
            [test, b.id],
          )
        ).rows[0];
        const config = v ? withLook(v.config) : null;
        sides.push({
          kind: "messenger",
          id: b.id,
          name: b.name,
          version: v?.version ?? 0,
          config,
          uploads: config ? await readUploads(db, test, "brand_assets", assetsIn(config)) : [],
        });
      }
    // T2b: a help centre's look — its theme and homepage, with their images.
    if (await helpCentersEnabled(db, test))
      for (const c of (
        await db.query<{ id: string; name: string; theme: Record<string, unknown>; layout: LayoutBlock[]; version: string }>(
          "SELECT id,name,theme,layout,version::text AS version FROM help_centers WHERE workspace_id=$1 ORDER BY lower(name),id",
          [test],
        )
      ).rows) {
        const theme = themeOf(c.theme);
        const layout = c.layout ?? [];
        const ids = layout.flatMap((b) => (b.type === "featured" ? b.recordIds : []));
        const featured = ids.length
          ? (
              await db.query<{ record_id: string; title: string }>(
                `SELECT DISTINCT ON (record_id) record_id,COALESCE(published_title,draft_title) AS title FROM knowledge_locales
                 WHERE workspace_id=$1 AND record_id=ANY($2::text[]) ORDER BY record_id,(published_title IS NULL)`,
                [test, ids],
              )
            ).rows.map((r) => ({ id: r.record_id, title: r.title }))
          : [];
        sides.push({
          kind: "help_center",
          id: c.id,
          name: c.name,
          version: Number(c.version),
          theme,
          layout,
          featured: ids.map((id) => featured.find((f) => f.id === id) ?? { id, title: "an article" }),
          uploads: await readUploads(db, test, "knowledge_files", themeFiles(theme, layout).map((f) => f.id)),
        });
      }
    return sides;
  });
}

/**
 * The images this change uses that production hasn't got: the ones that would have to be copied
 * in with it. An image the copy brought keeps its id on both sides, so it is not among them.
 */
async function imagesNeeded(db: Sql, production: string, side: Side) {
  if (!side.uploads.length) return [];
  const ids = side.uploads.map((u) => u.id);
  const table = side.uploads[0].table;
  const there =
    table === "brand_assets"
      ? (
          await db.query<{ id: string; owner: string; purpose: string }>(
            "SELECT id,brand_id AS owner,purpose FROM brand_assets WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='ready'",
            [production, ids],
          )
        ).rows
      : (
          await db.query<{ id: string; owner: string; purpose: string }>(
            "SELECT id,COALESCE(center_id,record_id) AS owner,purpose FROM knowledge_files WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='ready'",
            [production, ids],
          )
        ).rows;
  const owner = (u: Upload) => (u.table === "brand_assets" ? u.brandId : u.centerId ?? u.recordId);
  return side.uploads.filter((u) => !there.some((t) => t.id === u.id && t.owner === owner(u) && t.purpose === u.purpose));
}

/** What production is missing for this change: the same checks its own editors make. */
async function missingIn(db: Sql, production: string, side: Side) {
  if (side.kind === "workflow") {
    if (!side.definition) return [];
    return [...problems(side.definition), ...(await workflowReferences(db, production, side.definition, side.id))];
  }
  if (side.kind === "zoe_guidance") {
    const brands = new Set((await db.query<{ id: string }>("SELECT id FROM brands WHERE workspace_id=$1", [production])).rows.map((r) => r.id));
    const specialists = new Set((await db.query<{ id: string }>("SELECT id FROM ai_specialists WHERE workspace_id=$1", [production])).rows.map((r) => r.id));
    const out: string[] = [];
    for (const g of side.guidance) {
      if (g.brandId && !brands.has(g.brandId)) out.push(`“${g.title}” is for a brand production doesn't have.`);
      if (g.specialistId && !specialists.has(g.specialistId)) out.push(`“${g.title}” is for a specialist production doesn't have.`);
    }
    return out;
  }
  if (side.kind === "messenger") {
    const brand = (await db.query("SELECT 1 FROM brands WHERE workspace_id=$1 AND id=$2", [production, side.id])).rows.length;
    return brand ? [] : [`${side.name} isn't a brand production has.`];
  }
  const center = (await db.query("SELECT 1 FROM help_centers WHERE workspace_id=$1 AND id=$2", [production, side.id])).rows.length;
  if (!center) return [`Production doesn't have this help centre.`];
  // The homepage's articles, by the same rule the help centre's own editor applies.
  const out: string[] = [];
  for (const a of side.featured) {
    const r = (
      await db.query<{ source: string; audience: string; for_help_center: boolean }>(
        "SELECT source,audience,for_help_center FROM knowledge_records WHERE workspace_id=$1 AND id=$2",
        [production, a.id],
      )
    ).rows[0];
    if (!r) out.push(`The homepage features “${a.title}”, which production doesn't have.`);
    else if (r.source !== "article" || r.audience === "internal" || !r.for_help_center)
      out.push(`The homepage features “${a.title}”, which production doesn't show in its help centre.`);
  }
  return out;
}

/**
 * Judges candidates against production, in a transaction there: so the answer the page shows and
 * the answer a promotion acts on are the same answer, made the same way.
 */
async function judge(db: Sql, production: string, test: string, sides: Side[], canCopyImages: boolean) {
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
  const brands = new Set((await db.query<{ id: string }>("SELECT id FROM brands WHERE workspace_id=$1", [production])).rows.map((r) => r.id));
  const messengers = new Map(
    (
      await db.query<{ brand_id: string; version: number }>(
        "SELECT brand_id,max(version) AS version FROM messenger_versions WHERE workspace_id=$1 GROUP BY brand_id",
        [production],
      )
    ).rows.map((r) => [r.brand_id, r.version]),
  );
  const centers = new Map(
    (await db.query<{ id: string; version: string }>("SELECT id,version::text AS version FROM help_centers WHERE workspace_id=$1", [production])).rows.map((r) => [
      r.id,
      Number(r.version),
    ]),
  );
  const at = (side: Side) => {
    if (side.kind === "workflow") return workflows.get(side.id) ?? null;
    if (side.kind === "zoe_guidance") return agents.get(side.id) ?? null;
    // A brand production hasn't got has no messenger to compare with; one it has but has never
    // published is at nought, which is a number, not an absence.
    if (side.kind === "messenger") return brands.has(side.id) ? messengers.get(side.id) ?? 0 : null;
    return centers.get(side.id) ?? null;
  };
  const out: Candidate[] = [];
  for (const side of sides) {
    const baseline = baselines.get(`${side.kind}:${side.id}`) ?? null;
    const there = at(side);
    const c: Candidate = { kind: side.kind, id: side.id, name: side.name, here: side.version, there, baseline, status: "ready", why: "", missing: [], brings: [] };
    const say = (status: Status, why: string, missing: string[] = []) => out.push({ ...c, status, why, missing });
    if (side.kind === "workflow" && !side.definition) {
      say("unchanged", "Publish it in the test workspace first, so what is promoted is what you tried.");
      continue;
    }
    if (side.kind === "messenger" && !side.config) {
      say("unchanged", "Publish the messenger in the test workspace first, so what is promoted is what you tried.");
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
    // The images production hasn't got would be copied in with it, so it needs somewhere to copy
    // them from and to: a deployment without stored objects can promote everything else.
    const needed = await imagesNeeded(db, production, side);
    if (needed.length && !canCopyImages) {
      say("needs", "Production is missing something this needs.", ["Images can't be copied in this deployment, so this one can't come with it."]);
      continue;
    }
    out.push({
      ...c,
      status: "ready",
      why: there === null ? "New here: production doesn't have it yet." : "Changed here, and untouched in production since.",
      brings: needed.map(describe),
    });
  }
  return out;
}

/** What this test workspace could promote, and what stands in the way of each. */
export async function readPromotable(connect: Connect, test: string, principal: string, storage?: AttachmentStorage) {
  const production = await pairFor(connect, test, principal);
  const sides = await readSides(connect, test);
  return tenant(connect, production, async (db) => {
    await authorize(db, production, principal, "workspace.manage");
    const name = (await db.query<{ brand: string }>("SELECT brand FROM workspace WHERE id=$1", [production])).rows[0]?.brand ?? "";
    return { into: { id: production, name }, candidates: await judge(db, production, test, sides, !!storage?.readClean) };
  });
}

/** Promotes one object into production. Refused unless it is ready, in its own words. */
export async function promote(connect: Connect, test: string, principal: string, p: Record<string, unknown>, storage?: AttachmentStorage) {
  const kind = String(p.kind ?? "");
  const id = String(p.id ?? "");
  assert(
    (PROMOTABLE as string[]).includes(kind),
    "INVALID_FIELD",
    "A test workspace promotes a workflow, Zoe's guidance, the messenger or a help centre's look.",
    400,
  );
  const production = await pairFor(connect, test, principal);
  const sides = await readSides(connect, test);
  const side = sides.find((s) => s.kind === kind && s.id === id);
  assert(side, "NOT_FOUND", "That isn't in this test workspace.", 404);

  // The images production hasn't got, and their bytes, before the writing transaction opens: the
  // keys are known in advance, and a stored object nothing points at is harmless, while a row
  // pointing at bytes that aren't there is not.
  const needed = await tenant(connect, production, (db) => imagesNeeded(db, production, side));
  const bringing: { upload: Upload; id: string; cleanKey: string }[] = [];
  const map = new Map<string, string>();
  for (const u of needed) {
    const fresh = crypto.randomUUID();
    const cleanKey = cleanKeyIn(u.table, production, fresh, u.checksum);
    if (!(await copyBytes(storage, u, cleanKey)))
      throw new DomainError("PROMOTION_NEEDS", "Production is missing something this needs.", 409, {
        status: "needs",
        missing: [`The ${WHAT_IMAGE[u.purpose] ?? "image"} can't be copied into production, so this can't come with it.`],
      });
    map.set(u.id, fresh);
    bringing.push({ upload: u, id: fresh, cleanKey });
  }

  return tenant(connect, production, async (db) => {
    const me = await authorize(db, production, principal, "workspace.manage");
    // Judged here, in the transaction that writes: what the page showed cannot have gone stale.
    const candidate = (await judge(db, production, test, [side], !!storage?.readClean)).find((x) => x.id === id);
    assert(candidate, "NOT_FOUND", "That isn't in this test workspace.", 404);
    if (candidate.status !== "ready")
      throw new DomainError(candidate.status === "needs" ? "PROMOTION_NEEDS" : "NOT_PROMOTABLE", candidate.why, 409, {
        status: candidate.status,
        missing: candidate.missing,
      });
    // The images arrive first, as production's own uploads, so the configuration that names them
    // is valid by the time it is checked.
    for (const b of bringing) await writeUpload(db, production, b.upload, { id: b.id, cleanKey: b.cleanKey, by: me.id });

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
    } else if (side.kind === "zoe_guidance") {
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
    } else if (side.kind === "messenger") {
      // The brand's next published version, written exactly as publishing it there writes it:
      // the version, the live settings the messenger itself reads, and the draft left matching.
      const config = validConfig(mapAssets(side.config as MessengerConfig, map));
      await checkAssets(db, production, id, config);
      published = ((await db.query<{ v: number | null }>("SELECT max(version) AS v FROM messenger_versions WHERE workspace_id=$1 AND brand_id=$2", [production, id])).rows[0].v ?? 0) + 1;
      await db.query("INSERT INTO messenger_versions(workspace_id,brand_id,version,config,published_by) VALUES($1,$2,$3,$4,$5)", [
        production,
        id,
        published,
        JSON.stringify(config),
        me.id,
      ]);
      const { audiences, home, welcome, notice, look, general, ...base } = config;
      await db.query("UPDATE brands SET settings=settings||$3::jsonb WHERE workspace_id=$1 AND id=$2", [
        production,
        id,
        JSON.stringify({ ...base, messenger3: { audiences, home, welcome, notice, look, general } }),
      ]);
      await db.query(
        `INSERT INTO messenger_drafts(workspace_id,brand_id,config,updated_by) VALUES($1,$2,$3,$4)
         ON CONFLICT(workspace_id,brand_id) DO UPDATE SET config=excluded.config,version=messenger_drafts.version+1,updated_at=now(),updated_by=excluded.updated_by`,
        [production, id, JSON.stringify(config), me.id],
      );
    } else {
      // A help centre's look: its theme and homepage, checked as its own editor checks them. The
      // name, address, languages and articles are production's and are left alone.
      const mapped = mapThemeFiles(side.theme, side.layout, map);
      const look = await checkLook(db, production, id, mapped.theme, mapped.layout);
      const was = (
        await db.query<{ theme: Record<string, unknown>; layout: LayoutBlock[]; version: string }>(
          "SELECT theme,layout,version::text AS version FROM help_centers WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [production, id],
        )
      ).rows[0];
      assert(was, "NOT_FOUND", "That help centre isn't in the production workspace.", 404);
      // The look it replaced, and the mark the pair was at: a look has no versions of its own, so
      // this row is how production puts back what it had.
      previous = { theme: was.theme, layout: was.layout, version: Number(was.version), baseline: candidate.baseline };
      published = Number(was.version) + 1;
      await db.query("UPDATE help_centers SET theme=$3,layout=$4,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2", [
        production,
        id,
        JSON.stringify(look.theme),
        JSON.stringify(look.layout),
      ]);
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
    const brought = bringing.map((b) => describe(b.upload));
    await db.query(
      `INSERT INTO promotions(workspace_id,id,from_workspace,kind,object_id,object_name,from_version,to_version,previous,brought,actor_id,actor_name)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        production,
        promotionId,
        test,
        side.kind,
        id,
        side.name,
        side.version,
        published,
        previous === null ? null : JSON.stringify(previous),
        JSON.stringify(brought),
        me.id,
        me.name,
      ],
    );
    await recordAudit(db, production, "workspace.promoted", { type: "workspace", id, name: side.name }, { kind: side.kind, from: test, version: published, images: brought.length });
    return { promoted: { id: promotionId, kind: side.kind, objectId: id, name: side.name, version: published, brought } };
  });
}

type PromotionRow = {
  id: string;
  action: string;
  kind: string;
  object_id: string;
  object_name: string;
  from_workspace: string;
  from_version: string | null;
  to_version: string | null;
  previous: Record<string, unknown> | null;
  brought: { what: string; name: string }[];
  at: string;
  actor_name: string | null;
  seq: string;
};
const PROMOTION_COLUMNS = `SELECT id,action,kind,object_id,object_name,from_workspace,from_version::text AS from_version,
  to_version::text AS to_version,previous,brought,at,actor_name,seq::text AS seq FROM promotions`;

/** What has been promoted into this workspace, newest first: its own record of where it came from. */
export async function readPromotions(db: Sql, w: string, principal: string, limit = 50) {
  await authorize(db, w, principal, "workspace.manage");
  const rows = (await db.query<PromotionRow>(`${PROMOTION_COLUMNS} WHERE workspace_id=$1 ORDER BY at DESC,seq DESC LIMIT $2`, [w, Math.min(Math.max(limit, 1), 200)])).rows;
  // A help centre's look can be put back while it is still the look that promotion wrote and
  // nothing newer has happened to it: anything else would overwrite somebody's work.
  const centers = new Map(
    (await db.query<{ id: string; version: string }>("SELECT id,version::text AS version FROM help_centers WHERE workspace_id=$1", [w])).rows.map((r) => [r.id, r.version]),
  );
  const newest = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.kind}:${r.object_id}`;
    if (!newest.has(key)) newest.set(key, r.seq);
  }
  return {
    promotions: rows.map((r) => ({
      id: r.id,
      action: r.action,
      kind: r.kind,
      objectId: r.object_id,
      name: r.object_name,
      from: r.from_workspace,
      fromVersion: r.from_version === null ? null : Number(r.from_version),
      version: r.to_version === null ? null : Number(r.to_version),
      at: new Date(r.at).toISOString(),
      by: r.actor_name,
      brought: r.brought ?? [],
      canPutBack:
        r.kind === "help_center" &&
        r.action === "promoted" &&
        !!r.previous &&
        newest.get(`${r.kind}:${r.object_id}`) === r.seq &&
        centers.get(r.object_id) === r.to_version,
    })),
  };
}

/**
 * Puts a promoted help centre look back: the look the promotion replaced, written as a save of its
 * own, with the pair's mark returned to where it was so the test workspace's look can be promoted
 * again. Refused when the look has changed since, because that change is somebody's work.
 */
export async function undoPromotion(connect: Connect, w: string, principal: string, p: Record<string, unknown>) {
  const id = String(p.id ?? "");
  return tenant(connect, w, async (db) => {
    const me = await authorize(db, w, principal, "workspace.manage");
    const row = (await db.query<PromotionRow>(`${PROMOTION_COLUMNS} WHERE workspace_id=$1 AND id=$2`, [w, id])).rows[0];
    assert(row, "NOT_FOUND", "That promotion is unavailable.", 404);
    assert(
      row.kind === "help_center" && row.action === "promoted" && row.previous,
      "NOT_REVERTABLE",
      "Only a promoted help centre look can be put back; everything else promoted is a published version, which you restore where you publish it.",
      409,
    );
    const newer = (await db.query("SELECT 1 FROM promotions WHERE workspace_id=$1 AND kind=$2 AND object_id=$3 AND seq>$4", [w, row.kind, row.object_id, row.seq])).rows
      .length;
    assert(!newer, "NOT_REVERTABLE", "Something newer has happened to this help centre's look since, so this isn't the one to put back.", 409);
    const center = (
      await db.query<{ version: string }>("SELECT version::text AS version FROM help_centers WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [w, row.object_id])
    ).rows[0];
    assert(center, "NOT_FOUND", "That help centre is unavailable.", 404);
    assert(
      center.version === row.to_version,
      "HELP_CENTER_CONFLICT",
      "The look has changed here since it was promoted, so putting the old one back would overwrite that change.",
      409,
    );
    const previous = row.previous as { theme: unknown; layout: unknown; baseline: { version: number; from: number } | null };
    const look = await checkLook(db, w, row.object_id, previous.theme, previous.layout);
    const was = (await db.query<{ theme: Record<string, unknown>; layout: LayoutBlock[] }>("SELECT theme,layout FROM help_centers WHERE workspace_id=$1 AND id=$2", [w, row.object_id])).rows[0];
    const now = Number(center.version) + 1;
    await db.query("UPDATE help_centers SET theme=$3,layout=$4,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2", [
      w,
      row.object_id,
      JSON.stringify(look.theme),
      JSON.stringify(look.layout),
    ]);
    // The mark goes back to where the promotion found it, at production's new version: the test
    // workspace's look counts as changed here again, so it can be promoted a second time.
    if (previous.baseline)
      await db.query(
        `INSERT INTO test_baselines(workspace_id,test_workspace,kind,object_id,version,from_version) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(workspace_id,test_workspace,kind,object_id) DO UPDATE SET version=$5,from_version=$6,synced_at=now()`,
        [w, row.from_workspace, row.kind, row.object_id, now, previous.baseline.from],
      );
    else
      await db.query("DELETE FROM test_baselines WHERE workspace_id=$1 AND test_workspace=$2 AND kind=$3 AND object_id=$4", [
        w,
        row.from_workspace,
        row.kind,
        row.object_id,
      ]);
    // Appended, never altered: the ledger is the whole history of what arrived and what was undone.
    const undoneId = crypto.randomUUID();
    await db.query(
      `INSERT INTO promotions(workspace_id,id,from_workspace,kind,object_id,object_name,action,from_version,to_version,previous,actor_id,actor_name)
       VALUES($1,$2,$3,$4,$5,$6,'reverted',$7,$8,$9,$10,$11)`,
      [w, undoneId, row.from_workspace, row.kind, row.object_id, row.object_name, row.to_version, now, JSON.stringify({ theme: was?.theme, layout: was?.layout }), me.id, me.name],
    );
    await recordAudit(db, w, "workspace.promotion_reverted", { type: "workspace", id: row.object_id, name: row.object_name }, { kind: row.kind, promotion: row.id, version: now });
    return { reverted: { id: undoneId, kind: row.kind, objectId: row.object_id, name: row.object_name, version: now } };
  });
}

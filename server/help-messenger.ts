import { assert, type Sql } from "./db";
import {
  centerBy,
  chainOf,
  enabled,
  first,
  loadCenter,
  type Center,
  type CenterData,
  type Node,
} from "./help-content";
import { resolveLocale } from "../lib/help-paths";
import {
  issueReceipt,
  logSearch,
  openedResult,
  recordFeedback,
  searchHelp,
} from "./help-search";
import { imageIds, type RichDoc } from "../lib/rich-doc";
import { readyImages, signFileUrl } from "./knowledge-files";

/**
 * The messenger's Help space (phase 07, step B2): the brand's help center inside the messenger.
 * Browse collections, read articles, search (each search also returns a signed receipt, which
 * "search before contacting" needs), and say whether an article helped. A verified customer is
 * signed in, so articles for signed-in customers are included for them.
 */
export type MessengerScope = {
  workspace: string;
  brand: string;
  identity: string;
  verified: boolean;
  locale: string;
};

async function open(db: Sql, s: MessengerScope) {
  if (!(await enabled(db, s.workspace))) return null;
  const center = await centerBy(db, s.workspace, "brand_id", s.brand);
  if (!center) return null;
  const { locale } = resolveLocale(s.locale, {
    defaultLocale: center.default_locale,
    locales: center.locales,
  });
  const data = await loadCenter(db, s.workspace, center);
  return { center, locale, chain: chainOf(center, locale), data };
}
type Opened = {
  center: Center;
  locale: string;
  chain: string[];
  data: CenterData;
};
const unavailable = { available: false as const };

/** Whether an article is readable by this customer, and in which language. */
function shown(o: Opened, s: MessengerScope, id: string) {
  const a = o.data.articles.get(id);
  if (!a || (a.audience === "signed_in" && !s.verified)) return null;
  // Only articles placed somewhere live (featured-only ones are dropped by loadCenter).
  if (!o.data.nodes.some((n) => n.articles.includes(id))) return null;
  return first(o.chain, (l) => a.locales[l]);
}
const nodeName = (o: Opened, n: Node) => first(o.chain, (l) => n.names[l]);
const restricted = (o: Opened, s: MessengerScope) =>
  o.center.access === "signed_in" && !s.verified;

/** Whether the brand has a help center to show in the messenger. */
export async function helpAvailable(db: Sql, w: string, brand: string) {
  return (await enabled(db, w)) && !!(await centerBy(db, w, "brand_id", brand));
}

/** The Help space's front page: the help center's name and its collections. */
export async function messengerHelp(db: Sql, s: MessengerScope) {
  const o = await open(db, s);
  if (!o) return unavailable;
  if (restricted(o, s))
    return { available: true as const, signInRequired: true, collections: [] };
  const count = (n: Node) => {
    const ids = new Set<string>();
    for (const x of [n, ...o.data.nodes.filter((c) => c.parent_id === n.id)])
      for (const id of x.articles) if (shown(o, s, id)) ids.add(id);
    return ids.size;
  };
  return {
    available: true as const,
    signInRequired: false,
    name: o.center.name,
    locale: o.locale,
    collections: o.data.nodes
      .filter((n) => n.kind === "collection" && nodeName(o, n) && count(n) > 0)
      .map((n) => ({
        id: n.id,
        name: nodeName(o, n)!.value.name,
        description: nodeName(o, n)!.value.description,
        articles: count(n),
      })),
  };
}

/** A collection: its own articles and its sections' articles, titles only. */
export async function messengerCollection(
  db: Sql,
  s: MessengerScope,
  id: string,
) {
  const o = await open(db, s);
  const n = o?.data.nodes.find((x) => x.id === id && x.kind === "collection");
  assert(
    o && n && !restricted(o, s) && nodeName(o, n),
    "HELP_NOT_FOUND",
    "This page is unavailable.",
    404,
  );
  const list = (x: Node) =>
    x.articles.flatMap((a) => {
      const v = shown(o!, s, a);
      return v ? [{ id: a, title: v.value.title }] : [];
    });
  return {
    id: n.id,
    name: nodeName(o, n)!.value.name,
    description: nodeName(o, n)!.value.description,
    articles: list(n),
    sections: o.data.nodes
      .filter((x) => x.parent_id === n.id && nodeName(o, x))
      .map((x) => ({
        id: x.id,
        name: nodeName(o, x)!.value.name,
        articles: list(x),
      }))
      .filter((x) => x.articles.length),
  };
}

/** One article's published version in the customer's language (or the next one along). */
export async function messengerArticle(
  db: Sql,
  s: MessengerScope,
  id: string,
  queryId: string | null | undefined,
  fileSecret: string,
) {
  const o = await open(db, s);
  const v = o && !restricted(o, s) ? shown(o, s, id) : null;
  assert(o && v, "HELP_NOT_FOUND", "This article is unavailable.", 404);
  const row = (
    await db.query<{ published_body: RichDoc; published_text: string }>(
      "SELECT published_body,published_text FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 AND locale=$3",
      [s.workspace, id, v.locale],
    )
  ).rows[0];
  if (queryId) await openedResult(db, s.workspace, queryId, id);
  // Images: short-lived signed addresses, for ready images of this article only (phase 07 C1a).
  const ids = row.published_body ? imageIds(row.published_body) : [];
  const ready = await readyImages(db, s.workspace, id, ids);
  const images: Record<string, string> = {};
  for (const image of ids)
    if (ready.has(image))
      images[image] = await signFileUrl(fileSecret, s.workspace, image);
  return {
    id,
    locale: v.locale,
    title: v.value.title,
    doc: row.published_body,
    images,
    text: row.published_text,
    updatedAt: v.value.publishedAt,
  };
}

/** Searches the help center, logs the search, and returns a receipt for "search before contacting". */
export async function messengerSearch(
  db: Sql,
  s: MessengerScope,
  query: string,
  receiptSecret: string,
) {
  const q = query.trim().slice(0, 200);
  const o = await open(db, s);
  if (!o || restricted(o, s) || !q)
    return { results: [], queryId: null, receipt: null };
  const results = await searchHelp(
    db,
    s.workspace,
    o.center.id,
    o.chain,
    q,
    s.verified,
    10,
  );
  const queryId = await logSearch(db, s.workspace, {
    centerId: o.center.id,
    locale: o.locale,
    surface: "messenger",
    query: q,
    results: results.length,
  });
  return {
    results,
    queryId,
    receipt: await issueReceipt(receiptSecret, {
      workspace: s.workspace,
      brand: s.brand,
      identity: s.identity,
      query: q,
    }),
  };
}

/** "Was this helpful?" from the messenger, and the comment after a "No". */
export async function messengerFeedback(
  db: Sql,
  s: MessengerScope,
  p: {
    articleId?: unknown;
    helpful?: unknown;
    comment?: unknown;
    feedbackId?: unknown;
  },
) {
  const o = await open(db, s);
  const id = String(p.articleId ?? "");
  const v = o && !restricted(o, s) ? shown(o, s, id) : null;
  assert(o && v, "HELP_NOT_FOUND", "This article is unavailable.", 404);
  return recordFeedback(db, s.workspace, {
    recordId: id,
    locale: v.locale,
    surface: "messenger",
    helpful: typeof p.helpful === "boolean" ? p.helpful : undefined,
    comment: typeof p.comment === "string" ? p.comment : undefined,
    feedbackId: typeof p.feedbackId === "string" ? p.feedbackId : undefined,
    identityId: s.identity,
  });
}

/**
 * The help context a new conversation carries for the teammate, from what the customer did in
 * the Help space: what they searched (a verified receipt) and the article that didn't help.
 */
export async function helpContextArticle(
  db: Sql,
  s: MessengerScope,
  articleId: unknown,
) {
  if (typeof articleId !== "string") return null;
  const o = await open(db, s);
  const v = o && !restricted(o, s) ? shown(o, s, articleId) : null;
  return v ? { id: articleId, title: v.value.title } : null;
}

// JavaScript Relay API client, generated from lib/api-spec.ts by `npm run api:doc` (API version 2026-10-20). Don't edit by hand.
const e = (v) => encodeURIComponent(String(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An error from the API: its HTTP status, stable code, message, the field at fault, and request id. */
export class RelayError extends Error {
  constructor(status, body) {
    const first = (body && body.errors && body.errors[0]) || {};
    super(first.message || `Relay API error ${status}`);
    this.name = "RelayError";
    this.status = status;
    this.code = first.code || "unknown";
    this.field = first.field;
    this.requestId = body && body.request_id;
    this.errors = (body && body.errors) || [];
  }
}

/**
 * Verifies a webhook delivery (phase 15 D3): `Relay-Signature` against the raw body, under your
 * secret, within `toleranceSeconds`. Returns the parsed event, or throws.
 */
export async function verifyWebhook(secret, rawBody, signatureHeader, toleranceSeconds = 300, now = Date.now() / 1000) {
  const items = String(signatureHeader || "").split(",").map((p) => p.split("="));
  const t = Number((items.find(([k]) => k === "t") || [])[1]);
  if (!t || Math.abs(now - t) > toleranceSeconds) throw new Error("Relay webhook: the signature's time is missing or too old.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + rawBody)));
  const want = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const same = (a, b) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
  if (!items.some(([k, v]) => k === "v1" && same(String(v), want))) throw new Error("Relay webhook: the signature doesn't match.");
  return JSON.parse(rawBody);
}

export class Relay {
  /**
   * @param {{ token: string, baseUrl: string, version?: string, maxRetries?: number, fetch?: typeof fetch }} options
   */
  constructor({ token, baseUrl, version = "2026-10-20", maxRetries = 3, fetch: f = globalThis.fetch }) {
    if (!token) throw new Error("Relay: a token is required.");
    if (!baseUrl) throw new Error("Relay: baseUrl is required (https://api.<your domain>/rest).");
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.version = version;
    this.maxRetries = maxRetries;
    this.fetch = f;
  }

  /** One call: the token, the version, an idempotency key on POST, and a wait on 429. */
  async request(method, path, { query, body, idempotencyKey } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { authorization: "Bearer " + this.token, "relay-version": this.version, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") headers["idempotency-key"] = idempotencyKey || crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 429 && attempt < this.maxRetries) {
        await sleep(Math.max(0, Number(res.headers.get("retry-after") || 1)) * 1000);
        continue;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new RelayError(res.status, data);
      return data;
    }
  }

  /** Who the token is. The workspace, the teammate the token acts as, its scopes and its version. */
  getMe(options = {}) {
    return this.request("GET", "/me", { ...options });
  }

  /** List conversations. Customer-facing conversations, most recently updated first. */
  listConversations(options = {}) {
    return this.request("GET", "/conversations", { ...options });
  }

  /** Every page of listConversations, item by item. */
  async *listConversationsAll(options = {}) {
    let after;
    do {
      const page = await this.listConversations({ ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Start a conversation for a contact. A new conversation, started by the contact with their message (as if they'd written in). Send `Idempotency-Key` to make retries safe. */
  createConversation(body, options = {}) {
    return this.request("POST", "/conversations", { ...options, body });
  }

  /** Retrieve a conversation. One conversation. Its messages and notes are its parts. */
  getConversation(id, options = {}) {
    return this.request("GET", `/conversations/${e(id)}`, { ...options });
  }

  /** List a conversation's parts. Its messages, replies, notes and events, oldest first. Internal notes are marked `internal`; they're never shown to the customer. */
  listConversationParts(id, options = {}) {
    return this.request("GET", `/conversations/${e(id)}/parts`, { ...options });
  }

  /** Every page of listConversationParts, item by item. */
  async *listConversationPartsAll(id, options = {}) {
    let after;
    do {
      const page = await this.listConversationParts(id, { ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Reply. A reply to the customer, as the token's teammate. Send `Idempotency-Key` to make retries safe. */
  replyToConversation(id, body, options = {}) {
    return this.request("POST", `/conversations/${e(id)}/reply`, { ...options, body });
  }

  /** Add an internal note. A note only teammates see. */
  addConversationNote(id, body, options = {}) {
    return this.request("POST", `/conversations/${e(id)}/notes`, { ...options, body });
  }

  /** Assign. Assign to a teammate and/or a team; `null` clears either. */
  assignConversation(id, body, options = {}) {
    return this.request("POST", `/conversations/${e(id)}/assign`, { ...options, body });
  }

  /** Snooze. Snooze until a time (with its offset). */
  snoozeConversation(id, body, options = {}) {
    return this.request("POST", `/conversations/${e(id)}/snooze`, { ...options, body });
  }

  /** Close. Close the conversation. */
  closeConversation(id, options = {}) {
    return this.request("POST", `/conversations/${e(id)}/close`, { ...options });
  }

  /** Reopen. Reopen a closed or snoozed conversation. */
  openConversation(id, options = {}) {
    return this.request("POST", `/conversations/${e(id)}/open`, { ...options });
  }

  /** Tag. Add a tag to the conversation. */
  tagConversation(id, body, options = {}) {
    return this.request("POST", `/conversations/${e(id)}/tags`, { ...options, body });
  }

  /** Remove a tag. Remove a tag from the conversation. */
  untagConversation(id, tagId, options = {}) {
    return this.request("DELETE", `/conversations/${e(id)}/tags/${e(tagId)}`, { ...options });
  }

  /** List contacts. Contacts (not merged away), by id. */
  listContacts(options = {}) {
    return this.request("GET", "/contacts", { ...options });
  }

  /** Every page of listContacts, item by item. */
  async *listContactsAll(options = {}) {
    let after;
    do {
      const page = await this.listContacts({ ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Create a contact. A user (with your `external_id` for them) or a lead (with an email). Creating one that exists (the same `external_id`) returns it, so retries are safe. */
  createContact(body, options = {}) {
    return this.request("POST", "/contacts", { ...options, body });
  }

  /** Retrieve a contact. One contact. A merged contact's id leads to the contact it joined. */
  getContact(id, options = {}) {
    return this.request("GET", `/contacts/${e(id)}`, { ...options });
  }

  /** Update a contact. Change the name, or set custom attributes (`null` removes one). Others are left as they are. */
  updateContact(id, body, options = {}) {
    return this.request("PATCH", `/contacts/${e(id)}`, { ...options, body });
  }

  /** List tags. The workspace's tags (archived ones are left out). */
  listTags(options = {}) {
    return this.request("GET", "/tags", { ...options });
  }

  /** Create a tag. A new tag. A name that's taken returns the existing tag. */
  createTag(body, options = {}) {
    return this.request("POST", "/tags", { ...options, body });
  }

  /** List teammates. Everyone in the workspace. */
  listTeammates(options = {}) {
    return this.request("GET", "/teammates", { ...options });
  }

  /** Retrieve a teammate. One teammate. */
  getTeammate(id, options = {}) {
    return this.request("GET", `/teammates/${e(id)}`, { ...options });
  }

  /** List teams. The workspace's teams and their members. */
  listTeams(options = {}) {
    return this.request("GET", "/teams", { ...options });
  }

  /** Retrieve a team. One team and its members. */
  getTeam(id, options = {}) {
    return this.request("GET", `/teams/${e(id)}`, { ...options });
  }

  /** Search conversations. Conversations matching a query, sorted and cursor-paged. Fields: id, status, channel, brand_id, assignee_id, team_id, contact_id, tag_id, priority, created_at, updated_at, waiting_since. */
  searchConversations(body, options = {}) {
    return this.request("POST", "/conversations/search", { ...options, body });
  }

  /** Every page of searchConversations, item by item. */
  async *searchConversationsAll(body, options = {}) {
    let after;
    do {
      const page = await this.searchConversations({ ...body, ...(after ? { starting_after: after } : {}) }, options);
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Search contacts. Contacts matching a query, sorted and cursor-paged. Fields: id, role, name, email, external_id, first_seen_at, last_seen_at, signed_up_at, and custom_attributes.<name>. */
  searchContacts(body, options = {}) {
    return this.request("POST", "/contacts/search", { ...options, body });
  }

  /** Every page of searchContacts, item by item. */
  async *searchContactsAll(body, options = {}) {
    let after;
    do {
      const page = await this.searchContacts({ ...body, ...(after ? { starting_after: after } : {}) }, options);
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** List a contact's events. What they did, newest first (from your server, or the messenger while they're signed in). */
  listContactEvents(id, options = {}) {
    return this.request("GET", `/contacts/${e(id)}/events`, { ...options });
  }

  /** Every page of listContactEvents, item by item. */
  async *listContactEventsAll(id, options = {}) {
    let after;
    do {
      const page = await this.listContactEvents(id, { ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Record an event. Something the contact did. `id` is yours: an event with an id that's been seen is ignored, so retries are safe. */
  createContactEvent(id, body, options = {}) {
    return this.request("POST", `/contacts/${e(id)}/events`, { ...options, body });
  }

  /** List tickets. Tickets, newest first, by type or state. */
  listTickets(options = {}) {
    return this.request("GET", "/tickets", { ...options });
  }

  /** Every page of listTickets, item by item. */
  async *listTicketsAll(options = {}) {
    let after;
    do {
      const page = await this.listTickets({ ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Make a conversation a ticket. Turn a conversation into a ticket of a type (in its first state, or the one given). */
  createTicket(body, options = {}) {
    return this.request("POST", "/tickets", { ...options, body });
  }

  /** Retrieve a ticket. One ticket (its id is its conversation's). */
  getTicket(id, options = {}) {
    return this.request("GET", `/tickets/${e(id)}`, { ...options });
  }

  /** Change a ticket's state. Move a ticket to another of its type's states. */
  setTicketState(id, body, options = {}) {
    return this.request("POST", `/tickets/${e(id)}/state`, { ...options, body });
  }

  /** List ticket types. The workspace's ticket types and their states (archived ones left out). */
  listTicketTypes(options = {}) {
    return this.request("GET", "/ticket_types", { ...options });
  }

  /** Retrieve a ticket type. One ticket type and its states. */
  getTicketType(id, options = {}) {
    return this.request("GET", `/ticket_types/${e(id)}`, { ...options });
  }

  /** List help centers. Each brand's help center and its collections. */
  listHelpCenters(options = {}) {
    return this.request("GET", "/help_centers", { ...options });
  }

  /** Retrieve a help center. One help center and its collections. */
  getHelpCenter(id, options = {}) {
    return this.request("GET", `/help_centers/${e(id)}`, { ...options });
  }

  /** List articles. Articles, most recently updated first. */
  listArticles(options = {}) {
    return this.request("GET", "/articles", { ...options });
  }

  /** Every page of listArticles, item by item. */
  async *listArticlesAll(options = {}) {
    let after;
    do {
      const page = await this.listArticles({ ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Create an article. A new article, as a draft. Paragraphs are separated by a blank line. Publish it to put it live. */
  createArticle(body, options = {}) {
    return this.request("POST", "/articles", { ...options, body });
  }

  /** Retrieve an article. One article: its draft and, if published, what's live. */
  getArticle(id, options = {}) {
    return this.request("GET", `/articles/${e(id)}`, { ...options });
  }

  /** Update an article's draft. Change the draft's title or text. What's live doesn't change until it's published again. */
  updateArticle(id, body, options = {}) {
    return this.request("PATCH", `/articles/${e(id)}`, { ...options, body });
  }

  /** Publish an article. Put the draft live (wherever it's placed: help centers, Zoe, the inbox). */
  publishArticle(id, options = {}) {
    return this.request("POST", `/articles/${e(id)}/publish`, { ...options });
  }

  /** List knowledge. Everything Zoe and the inbox may draw on: articles, internal articles, snippets, files and synced pages. */
  listKnowledgeRecords(options = {}) {
    return this.request("GET", "/knowledge_records", { ...options });
  }

  /** Every page of listKnowledgeRecords, item by item. */
  async *listKnowledgeRecordsAll(options = {}) {
    let after;
    do {
      const page = await this.listKnowledgeRecords({ ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Retrieve knowledge. One knowledge record. */
  getKnowledgeRecord(id, options = {}) {
    return this.request("GET", `/knowledge_records/${e(id)}`, { ...options });
  }

  /** List macros. Shared macros, and the token's teammate's own. */
  listMacros(options = {}) {
    return this.request("GET", "/macros", { ...options });
  }

  /** Retrieve a macro. One macro: its text and its actions. */
  getMacro(id, options = {}) {
    return this.request("GET", `/macros/${e(id)}`, { ...options });
  }

  /** Apply a macro. Apply a macro to a conversation: its reply or note, and its actions. Send `Idempotency-Key` to make retries safe. */
  applyMacro(id, body, options = {}) {
    return this.request("POST", `/conversations/${e(id)}/macros`, { ...options, body });
  }

  /** List workflows. The workspace's workflows (archived ones left out). */
  listWorkflows(options = {}) {
    return this.request("GET", "/workflows", { ...options });
  }

  /** Retrieve a workflow. One workflow. */
  getWorkflow(id, options = {}) {
    return this.request("GET", `/workflows/${e(id)}`, { ...options });
  }

  /** List a workflow's runs. Its runs, newest first. */
  listWorkflowRuns(id, options = {}) {
    return this.request("GET", `/workflows/${e(id)}/runs`, { ...options });
  }

  /** Every page of listWorkflowRuns, item by item. */
  async *listWorkflowRunsAll(id, options = {}) {
    let after;
    do {
      const page = await this.listWorkflowRuns(id, { ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Run a workflow. Run a live, manually triggered workflow on a conversation. It runs in the background. */
  triggerWorkflow(id, body, options = {}) {
    return this.request("POST", `/workflows/${e(id)}/trigger`, { ...options, body });
  }

  /** List outbound messages. Chats and banners, with what they reached. */
  listOutboundMessages(options = {}) {
    return this.request("GET", "/outbound_messages", { ...options });
  }

  /** Retrieve an outbound message. One outbound message and its numbers. */
  getOutboundMessage(id, options = {}) {
    return this.request("GET", `/outbound_messages/${e(id)}`, { ...options });
  }

  /** List data attributes. The workspace's attributes for conversations and contacts. */
  listDataAttributes(options = {}) {
    return this.request("GET", "/data_attributes", { ...options });
  }

  /** Create a conversation attribute. A new attribute teammates fill in on conversations. */
  createDataAttribute(body, options = {}) {
    return this.request("POST", "/data_attributes", { ...options, body });
  }

  /** List segments. Saved and built-in segments of contacts. */
  listSegments(options = {}) {
    return this.request("GET", "/segments", { ...options });
  }

  /** List a segment's contacts. Who's in a segment now. */
  listSegmentContacts(id, options = {}) {
    return this.request("GET", `/segments/${e(id)}/contacts`, { ...options });
  }

  /** Every page of listSegmentContacts, item by item. */
  async *listSegmentContactsAll(id, options = {}) {
    let after;
    do {
      const page = await this.listSegmentContacts(id, { ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Export data. Start an export of conversations, contacts and/or tickets (as newline-delimited JSON). It runs in the background; fetch it to see when it's ready. */
  createExport(body, options = {}) {
    return this.request("POST", "/exports", { ...options, body });
  }

  /** Retrieve an export. Its progress, and when it's done, links to its files (each valid for an hour). */
  getExport(id, options = {}) {
    return this.request("GET", `/exports/${e(id)}`, { ...options });
  }

  /** List webhooks. The workspace's webhook subscriptions. */
  listWebhooks(options = {}) {
    return this.request("GET", "/webhooks", { ...options });
  }

  /** Create a webhook. Subscribe a public https address to topics. The response carries its signing `secret`, this once. */
  createWebhook(body, options = {}) {
    return this.request("POST", "/webhooks", { ...options, body });
  }

  /** Retrieve a webhook. One webhook subscription and its state. */
  getWebhook(id, options = {}) {
    return this.request("GET", `/webhooks/${e(id)}`, { ...options });
  }

  /** Update a webhook. Change its address, topics or alert email, or turn it off or back on (back on forgives its failures). */
  updateWebhook(id, body, options = {}) {
    return this.request("PATCH", `/webhooks/${e(id)}`, { ...options, body });
  }

  /** Delete a webhook. Stop sending to it; deliveries still waiting are abandoned. */
  deleteWebhook(id, options = {}) {
    return this.request("DELETE", `/webhooks/${e(id)}`, { ...options });
  }

  /** Rotate a webhook's secret. A new signing secret (returned this once). For 24 hours, deliveries are signed with both, so you can switch without missing any. */
  rotateWebhookSecret(id, options = {}) {
    return this.request("POST", `/webhooks/${e(id)}/rotate_secret`, { ...options });
  }

  /** Send a test delivery. A `ping` delivery, to check the address and your signature check. */
  testWebhook(id, options = {}) {
    return this.request("POST", `/webhooks/${e(id)}/test`, { ...options });
  }

  /** List deliveries. What was sent to it, newest first (kept 30 days). */
  listWebhookDeliveries(id, options = {}) {
    return this.request("GET", `/webhooks/${e(id)}/deliveries`, { ...options });
  }

  /** Every page of listWebhookDeliveries, item by item. */
  async *listWebhookDeliveriesAll(id, options = {}) {
    let after;
    do {
      const page = await this.listWebhookDeliveries(id, { ...options, query: { ...options.query, ...(after ? { starting_after: after } : {}) } });
      yield* page.data;
      after = page.pages.next;
    } while (after);
  }

  /** Retrieve a delivery. One delivery: its body, and every attempt with what came back. */
  getWebhookDelivery(id, deliveryId, options = {}) {
    return this.request("GET", `/webhooks/${e(id)}/deliveries/${e(deliveryId)}`, { ...options });
  }

  /** Replay a delivery. Send the same event and body again, as a new delivery. */
  replayWebhookDelivery(id, deliveryId, options = {}) {
    return this.request("POST", `/webhooks/${e(id)}/deliveries/${e(deliveryId)}/replay`, { ...options });
  }
}

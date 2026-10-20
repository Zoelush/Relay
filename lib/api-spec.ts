/**
 * Relay's public REST API, as an OpenAPI 3.1 document (phase 15; docs/DEVELOPER_PLATFORM_PLAN.md).
 * This is the source: each operation is written here before it's built. Request validation
 * (`lib/api-validate.ts`), the router (`server/rest.ts`), the reference (`docs/API.md` and
 * `/developers`, from `lib/api-reference.ts`) and the SDKs are derived from it; never the other way.
 *
 * Each operation carries `x-relay-scope`: the capability (`server/policy.ts`) a token needs for it,
 * checked against the token's scopes and its teammate's role. Operations a token can call without
 * a scope (who am I) have none.
 */
export type Schema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: readonly (string | number)[];
  format?: "date-time" | "email";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  maxProperties?: number;
  default?: unknown;
  $ref?: string;
  example?: unknown;
};
export type Parameter = { name: string; in: "path" | "query" | "header"; required?: boolean; description: string; schema: Schema };
export type Operation = {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  "x-relay-scope": string | null;
  parameters?: Parameter[];
  requestBody?: { required: boolean; content: { "application/json": { schema: Schema } } };
  responses: Record<string, { description: string; content?: { "application/json": { schema: Schema } } }>;
};
export type Spec = {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  security: { bearer: [] }[];
  paths: Record<string, Partial<Record<"get" | "post" | "patch" | "delete", Operation>>>;
  components: { schemas: Record<string, Schema>; securitySchemes: Record<string, unknown> };
};

/**
 * The versions, newest first. A version is a date; a request names one in `Relay-Version`, or gets
 * the token's own (fixed when it was made). The newest is what's built; each older one is a
 * transform onto it (`server/rest.ts`, `VERSION_CHANGES`). A version is supported for at least 12
 * months after its successor ships, so two are supported at any time once there are two.
 */
export const API_VERSIONS = ["2026-10-20"] as const;
export const LATEST_VERSION = API_VERSIONS[0];

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const id = (what: string): Schema => ({ type: "string", minLength: 1, maxLength: 100, description: `The ${what}'s id.` });
const time: Schema = { type: "string", format: "date-time" };
const maybe = (s: Schema): Schema => ({ ...s, type: [s.type as string, "null"] });
const text = (max: number, description: string): Schema => ({ type: "string", minLength: 1, maxLength: max, description });
const list = (item: string): Schema => ({
  type: "object",
  required: ["type", "data", "pages"],
  properties: { type: { type: "string", enum: ["list"] }, data: { type: "array", items: ref(item) }, pages: ref("Pages") },
});
const ok = (schema: Schema, description = "OK") => ({ description, content: { "application/json": { schema } } });
const errors = {
  "400": ok(ref("Error"), "The request isn't valid: the error names the field."),
  "401": ok(ref("Error"), "No token, or one that's been revoked."),
  "403": ok(ref("Error"), "The token's scopes, or its teammate's role, don't allow it."),
  "429": ok(ref("Error"), "Too many requests: wait `Retry-After` seconds."),
};
const notFound = { "404": ok(ref("Error"), "Not found in this workspace.") };
const body = (schema: Schema) => ({ required: true, content: { "application/json": { schema } } });
const pathId = (name: string, what: string): Parameter => ({ name, in: "path", required: true, description: `The ${what}'s id.`, schema: id(what) });
const page: Parameter[] = [
  { name: "per_page", in: "query", description: "How many to return, 1 to 100.", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
  { name: "starting_after", in: "query", description: "The cursor from the previous page's `pages.next`.", schema: { type: "string", maxLength: 400 } },
];
const op = (o: Omit<Operation, "responses"> & { ok: ReturnType<typeof ok>; status?: string; missing?: boolean }): Operation => {
  const { ok: success, status = "200", missing = true, ...rest } = o;
  return { ...rest, responses: { [status]: success, ...errors, ...(missing ? notFound : {}) } };
};
const action = (operationId: string, summary: string, description: string, scope: string, schema?: Schema): Operation =>
  op({
    operationId,
    summary,
    description,
    tags: ["Conversations"],
    "x-relay-scope": scope,
    parameters: [pathId("id", "conversation")],
    ...(schema ? { requestBody: body(schema) } : {}),
    ok: ok(ref("Conversation")),
  });

export const SPEC: Spec = {
  openapi: "3.1.0",
  info: {
    title: "Relay API",
    version: LATEST_VERSION,
    description:
      "Relay's REST API: conversations, contacts, tickets, articles and knowledge, macros, workflows, outbound, events, attributes, segments, search and export. Authenticate with a personal access token (Settings › Developers) as `Authorization: Bearer <token>`. Name a version with `Relay-Version`; without one, the token's own version is used.",
  },
  servers: [{ url: "/rest", description: "This Relay (deployed: https://api.<your domain>)." }],
  security: [{ bearer: [] }],
  paths: {
    "/me": {
      get: op({
        operationId: "getMe",
        summary: "Who the token is",
        description: "The workspace, the teammate the token acts as, its scopes and its version.",
        tags: ["Tokens"],
        "x-relay-scope": null,
        ok: ok(ref("Me")),
        missing: false,
      }),
    },
    "/conversations": {
      get: op({
        operationId: "listConversations",
        summary: "List conversations",
        description: "Customer-facing conversations, most recently updated first.",
        tags: ["Conversations"],
        "x-relay-scope": "conversations.read",
        parameters: [
          { name: "status", in: "query", description: "Only conversations in this state.", schema: { type: "string", enum: ["open", "snoozed", "closed"] } },
          { name: "assignee_id", in: "query", description: "Only those assigned to this teammate (`none` for unassigned).", schema: { type: "string", maxLength: 100 } },
          { name: "team_id", in: "query", description: "Only those with this team.", schema: { type: "string", maxLength: 100 } },
          ...page,
        ],
        ok: ok(list("Conversation")),
        missing: false,
      }),
      post: op({
        operationId: "createConversation",
        summary: "Start a conversation for a contact",
        description: "A new conversation, started by the contact with their message (as if they'd written in). Send `Idempotency-Key` to make retries safe.",
        tags: ["Conversations"],
        "x-relay-scope": "conversations.reply",
        requestBody: body({
          type: "object",
          additionalProperties: false,
          required: ["contact_id", "body"],
          properties: { contact_id: id("contact"), body: text(10_000, "The contact's first message, as plain text.") },
        }),
        ok: ok(ref("Conversation"), "Created."),
        status: "201",
      }),
    },
    "/conversations/{id}": {
      get: op({
        operationId: "getConversation",
        summary: "Retrieve a conversation",
        description: "One conversation. Its messages and notes are its parts.",
        tags: ["Conversations"],
        "x-relay-scope": "conversations.read",
        parameters: [pathId("id", "conversation")],
        ok: ok(ref("Conversation")),
      }),
    },
    "/conversations/{id}/parts": {
      get: op({
        operationId: "listConversationParts",
        summary: "List a conversation's parts",
        description: "Its messages, replies, notes and events, oldest first. Internal notes are marked `internal`; they're never shown to the customer.",
        tags: ["Conversations"],
        "x-relay-scope": "conversations.read",
        parameters: [pathId("id", "conversation"), ...page],
        ok: ok(list("Part")),
      }),
    },
    "/conversations/{id}/reply": {
      post: action("replyToConversation", "Reply", "A reply to the customer, as the token's teammate. Send `Idempotency-Key` to make retries safe.", "conversations.reply", {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: { body: text(10_000, "The reply, as plain text.") },
      }),
    },
    "/conversations/{id}/notes": {
      post: action("addConversationNote", "Add an internal note", "A note only teammates see.", "conversations.note", {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: { body: text(10_000, "The note, as plain text.") },
      }),
    },
    "/conversations/{id}/assign": {
      post: action("assignConversation", "Assign", "Assign to a teammate and/or a team; `null` clears either.", "conversations.assign", {
        type: "object",
        additionalProperties: false,
        properties: { assignee_id: maybe(id("teammate")), team_id: maybe(id("team")) },
      }),
    },
    "/conversations/{id}/snooze": {
      post: action("snoozeConversation", "Snooze", "Snooze until a time (with its offset).", "conversations.manage", {
        type: "object",
        additionalProperties: false,
        required: ["until"],
        properties: { until: { ...time, description: "When it wakes, with an offset (2026-10-21T09:00:00+01:00)." } },
      }),
    },
    "/conversations/{id}/close": { post: action("closeConversation", "Close", "Close the conversation.", "conversations.manage") },
    "/conversations/{id}/open": { post: action("openConversation", "Reopen", "Reopen a closed or snoozed conversation.", "conversations.manage") },
    "/conversations/{id}/tags": {
      post: action("tagConversation", "Tag", "Add a tag to the conversation.", "conversations.manage", {
        type: "object",
        additionalProperties: false,
        required: ["tag_id"],
        properties: { tag_id: id("tag") },
      }),
    },
    "/conversations/{id}/tags/{tag_id}": {
      delete: op({
        operationId: "untagConversation",
        summary: "Remove a tag",
        description: "Remove a tag from the conversation.",
        tags: ["Conversations"],
        "x-relay-scope": "conversations.manage",
        parameters: [pathId("id", "conversation"), pathId("tag_id", "tag")],
        ok: ok(ref("Conversation")),
      }),
    },
    "/contacts": {
      get: op({
        operationId: "listContacts",
        summary: "List contacts",
        description: "Contacts (not merged away), by id.",
        tags: ["Contacts"],
        "x-relay-scope": "contacts.personal_data",
        parameters: [
          { name: "email", in: "query", description: "Only the contact with this email.", schema: { type: "string", format: "email", maxLength: 320 } },
          { name: "external_id", in: "query", description: "Only the contact with your id for them.", schema: { type: "string", maxLength: 200 } },
          ...page,
        ],
        ok: ok(list("Contact")),
        missing: false,
      }),
      post: op({
        operationId: "createContact",
        summary: "Create a contact",
        description:
          "A user (with your `external_id` for them) or a lead (with an email). Creating one that exists (the same `external_id`) returns it, so retries are safe.",
        tags: ["Contacts"],
        "x-relay-scope": "contacts.personal_data",
        requestBody: body({
          type: "object",
          additionalProperties: false,
          properties: {
            external_id: { type: "string", minLength: 1, maxLength: 200, description: "Your id for them: makes them a user." },
            email: { type: "string", format: "email", maxLength: 320 },
            name: { type: "string", maxLength: 200 },
            custom_attributes: ref("CustomAttributes"),
          },
        }),
        ok: ok(ref("Contact"), "Created (or found)."),
        status: "201",
        missing: false,
      }),
    },
    "/contacts/{id}": {
      get: op({
        operationId: "getContact",
        summary: "Retrieve a contact",
        description: "One contact. A merged contact's id leads to the contact it joined.",
        tags: ["Contacts"],
        "x-relay-scope": "contacts.personal_data",
        parameters: [pathId("id", "contact")],
        ok: ok(ref("Contact")),
      }),
      patch: op({
        operationId: "updateContact",
        summary: "Update a contact",
        description: "Change the name, or set custom attributes (`null` removes one). Others are left as they are.",
        tags: ["Contacts"],
        "x-relay-scope": "contacts.personal_data",
        parameters: [pathId("id", "contact")],
        requestBody: body({
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string", maxLength: 200 }, custom_attributes: ref("CustomAttributes") },
        }),
        ok: ok(ref("Contact")),
      }),
    },
    "/tags": {
      get: op({ operationId: "listTags", summary: "List tags", description: "The workspace's tags (archived ones are left out).", tags: ["Tags"], "x-relay-scope": "conversations.read", ok: ok(list("Tag")), missing: false }),
      post: op({
        operationId: "createTag",
        summary: "Create a tag",
        description: "A new tag. A name that's taken returns the existing tag.",
        tags: ["Tags"],
        "x-relay-scope": "workspace.manage",
        requestBody: body({ type: "object", additionalProperties: false, required: ["name"], properties: { name: text(60, "The tag's name.") } }),
        ok: ok(ref("Tag"), "Created (or found)."),
        status: "201",
        missing: false,
      }),
    },
    "/teammates": {
      get: op({ operationId: "listTeammates", summary: "List teammates", description: "Everyone in the workspace.", tags: ["Teammates and teams"], "x-relay-scope": "conversations.read", ok: ok(list("Teammate")), missing: false }),
    },
    "/teammates/{id}": {
      get: op({
        operationId: "getTeammate",
        summary: "Retrieve a teammate",
        description: "One teammate.",
        tags: ["Teammates and teams"],
        "x-relay-scope": "conversations.read",
        parameters: [pathId("id", "teammate")],
        ok: ok(ref("Teammate")),
      }),
    },
    "/teams": {
      get: op({ operationId: "listTeams", summary: "List teams", description: "The workspace's teams and their members.", tags: ["Teammates and teams"], "x-relay-scope": "conversations.read", ok: ok(list("Team")), missing: false }),
    },
    "/teams/{id}": {
      get: op({
        operationId: "getTeam",
        summary: "Retrieve a team",
        description: "One team and its members.",
        tags: ["Teammates and teams"],
        "x-relay-scope": "conversations.read",
        parameters: [pathId("id", "team")],
        ok: ok(ref("Team")),
      }),
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A personal access token from Settings › Developers." } },
    schemas: {
      Pages: { type: "object", required: ["next"], properties: { next: { type: ["string", "null"], description: "Pass as `starting_after` for the next page; null on the last." } } },
      Error: {
        type: "object",
        required: ["type", "request_id", "errors"],
        properties: {
          type: { type: "string", enum: ["error"] },
          request_id: { type: "string", description: "Quote it if you contact us." },
          errors: {
            type: "array",
            items: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", description: "Stable and machine-readable (`invalid_field`, `not_found`, `rate_limited`…)." },
                message: { type: "string", description: "For a person." },
                field: { type: "string", description: "The field at fault, when there is one (`body`, `contact_id`…)." },
              },
            },
          },
        },
      },
      CustomAttributes: {
        type: "object",
        maxProperties: 50,
        description: "Your own facts about them: up to 50, each a string (up to 255), a number, a boolean or null.",
        additionalProperties: { type: ["string", "number", "boolean", "null"], maxLength: 255 },
      },
      Me: {
        type: "object",
        required: ["type", "workspace_id", "teammate", "scopes", "version"],
        properties: {
          type: { type: "string", enum: ["token"] },
          workspace_id: { type: "string" },
          teammate: ref("Teammate"),
          scopes: { type: "array", items: { type: "string" } },
          version: { type: "string" },
        },
      },
      Conversation: {
        type: "object",
        required: ["type", "id", "status", "channel", "created_at", "updated_at"],
        properties: {
          type: { type: "string", enum: ["conversation"] },
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["open", "snoozed", "closed"] },
          channel: { type: "string", description: "messenger, email, whatsapp, sms, …" },
          brand_id: { type: ["string", "null"] },
          contact_id: { type: ["string", "null"] },
          assignee_id: { type: ["string", "null"] },
          team_id: { type: ["string", "null"] },
          priority: { type: "boolean" },
          tags: { type: "array", items: ref("Tag") },
          snoozed_until: { type: ["string", "null"], format: "date-time" },
          waiting_since: { type: ["string", "null"], format: "date-time", description: "When the customer's unanswered message came in; null when they aren't waiting." },
          created_at: time,
          updated_at: time,
        },
      },
      Part: {
        type: "object",
        required: ["type", "id", "seq", "kind", "audience", "created_at"],
        properties: {
          type: { type: "string", enum: ["conversation_part"] },
          id: { type: "string" },
          seq: { type: "integer" },
          kind: { type: "string", description: "customer_message, teammate_reply, internal_note, ai_reply, state_change, assignment_change, …" },
          audience: { type: "string", enum: ["public", "internal"] },
          author: { type: "object", properties: { type: { type: "string" }, id: { type: ["string", "null"] } } },
          body: { type: "string" },
          created_at: time,
        },
      },
      Contact: {
        type: "object",
        required: ["type", "id", "role"],
        properties: {
          type: { type: "string", enum: ["contact"] },
          id: { type: "string" },
          role: { type: "string", enum: ["visitor", "lead", "user"] },
          name: { type: "string" },
          email: { type: ["string", "null"] },
          external_id: { type: ["string", "null"] },
          custom_attributes: ref("CustomAttributes"),
          first_seen_at: time,
          last_seen_at: time,
          signed_up_at: { type: ["string", "null"], format: "date-time" },
        },
      },
      Tag: { type: "object", required: ["type", "id", "name"], properties: { type: { type: "string", enum: ["tag"] }, id: { type: "string" }, name: { type: "string" } } },
      Teammate: {
        type: "object",
        required: ["type", "id", "name"],
        properties: { type: { type: "string", enum: ["teammate"] }, id: { type: "string" }, name: { type: "string" }, presence: { type: "string", enum: ["active", "away", "away_reassigning"] } },
      },
      Team: {
        type: "object",
        required: ["type", "id", "name", "member_ids"],
        properties: { type: { type: "string", enum: ["team"] }, id: { type: "string" }, name: { type: "string" }, member_ids: { type: "array", items: { type: "string" } } },
      },
    },
  },
};


/* ------------------------------------------------------------------------------------------ */
/* Phase 15 D2: the rest of the coverage, search and export.                                    */
/* ------------------------------------------------------------------------------------------ */
const read = (operationId: string, summary: string, description: string, tag: string, scope: string, schema: string, params: Parameter[] = [], missing = true): Operation =>
  op({ operationId, summary, description, tags: [tag], "x-relay-scope": scope, parameters: params, ok: ok(ref(schema)), missing });
const listing = (operationId: string, summary: string, description: string, tag: string, scope: string, item: string, params: Parameter[] = [], paged = true): Operation =>
  op({ operationId, summary, description, tags: [tag], "x-relay-scope": scope, parameters: [...params, ...(paged ? page : [])], ok: ok(list(item)), missing: false });
const write = (operationId: string, summary: string, description: string, tag: string, scope: string, schema: string, request: Schema, params: Parameter[] = [], status = "200"): Operation =>
  op({ operationId, summary, description, tags: [tag], "x-relay-scope": scope, parameters: params, requestBody: body(request), ok: ok(ref(schema), status === "201" ? "Created." : "OK"), status, missing: params.length > 0 });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", additionalProperties: false, required, properties });
const typed = (name: string, properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  required: ["type", "id", ...required],
  properties: { type: { type: "string", enum: [name] }, id: { type: "string" }, ...properties },
});
/** A search: a query (one condition, or AND/OR of up to 20, 3 deep), a sort, and a page. */
const search = (resource: string): Schema =>
  object(
    {
      query: { type: "object", description: `A condition \`{"field","operator","value"}\` or a group \`{"operator":"AND"|"OR","value":[…]}\`. See Search for the ${resource} fields and operators.` },
      sort: object({ field: { type: "string", maxLength: 60 }, order: { type: "string", enum: ["asc", "desc"] } }, ["field"]),
      per_page: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      starting_after: { type: "string", maxLength: 400 },
    },
    ["query"],
  );

Object.assign(SPEC.paths, {
  "/conversations/search": {
    post: op({
      operationId: "searchConversations",
      summary: "Search conversations",
      description: "Conversations matching a query, sorted and cursor-paged. Fields: id, status, channel, brand_id, assignee_id, team_id, contact_id, tag_id, priority, created_at, updated_at, waiting_since.",
      tags: ["Search"],
      "x-relay-scope": "conversations.read",
      requestBody: body(search("conversation")),
      ok: ok(list("Conversation")),
      missing: false,
    }),
  },
  "/contacts/search": {
    post: op({
      operationId: "searchContacts",
      summary: "Search contacts",
      description: "Contacts matching a query, sorted and cursor-paged. Fields: id, role, name, email, external_id, first_seen_at, last_seen_at, signed_up_at, and custom_attributes.<name>.",
      tags: ["Search"],
      "x-relay-scope": "contacts.personal_data",
      requestBody: body(search("contact")),
      ok: ok(list("Contact")),
      missing: false,
    }),
  },
  "/contacts/{id}/events": {
    get: listing("listContactEvents", "List a contact's events", "What they did, newest first (from your server, or the messenger while they're signed in).", "Events", "contacts.personal_data", "Event", [pathId("id", "contact")]),
    post: write(
      "createContactEvent",
      "Record an event",
      "Something the contact did. `id` is yours: an event with an id that's been seen is ignored, so retries are safe.",
      "Events",
      "contacts.personal_data",
      "Event",
      object(
        {
          id: { type: "string", minLength: 1, maxLength: 200, description: "Your id for this event (dedupes)." },
          name: text(100, "What happened (`upgraded plan`)."),
          metadata: { type: "object", maxProperties: 10, additionalProperties: { type: ["string", "number", "boolean", "null"], maxLength: 255 }, description: "Up to 10 facts about it." },
          occurred_at: { ...time, description: "When it happened (now if left out)." },
        },
        ["id", "name"],
      ),
      [pathId("id", "contact")],
      "201",
    ),
  },
  "/tickets": {
    get: listing("listTickets", "List tickets", "Tickets, newest first, by type or state.", "Tickets", "conversations.read", "Ticket", [
      { name: "ticket_type_id", in: "query", description: "Only this type.", schema: { type: "string", maxLength: 100 } },
      { name: "state", in: "query", description: "Only tickets in a state of this kind.", schema: { type: "string", enum: ["submitted", "in_progress", "waiting_on_customer", "resolved"] } },
    ]),
    post: write(
      "createTicket",
      "Make a conversation a ticket",
      "Turn a conversation into a ticket of a type (in its first state, or the one given).",
      "Tickets",
      "conversations.manage",
      "Ticket",
      object({ conversation_id: id("conversation"), ticket_type_id: id("ticket type"), state_id: id("ticket state") }, ["conversation_id", "ticket_type_id"]),
      [],
      "201",
    ),
  },
  "/tickets/{id}": { get: read("getTicket", "Retrieve a ticket", "One ticket (its id is its conversation's).", "Tickets", "conversations.read", "Ticket", [pathId("id", "ticket")]) },
  "/tickets/{id}/state": {
    post: write("setTicketState", "Change a ticket's state", "Move a ticket to another of its type's states.", "Tickets", "conversations.manage", "Ticket", object({ state_id: id("ticket state") }, ["state_id"]), [pathId("id", "ticket")]),
  },
  "/ticket_types": { get: listing("listTicketTypes", "List ticket types", "The workspace's ticket types and their states (archived ones left out).", "Tickets", "conversations.read", "TicketType", [], false) },
  "/ticket_types/{id}": { get: read("getTicketType", "Retrieve a ticket type", "One ticket type and its states.", "Tickets", "conversations.read", "TicketType", [pathId("id", "ticket type")]) },
  "/help_centers": { get: listing("listHelpCenters", "List help centers", "Each brand's help center and its collections.", "Help centers and articles", "knowledge.manage", "HelpCenter", [], false) },
  "/help_centers/{id}": { get: read("getHelpCenter", "Retrieve a help center", "One help center and its collections.", "Help centers and articles", "knowledge.manage", "HelpCenter", [pathId("id", "help center")]) },
  "/articles": {
    get: listing("listArticles", "List articles", "Articles, most recently updated first.", "Help centers and articles", "conversations.read", "Article", [
      { name: "state", in: "query", description: "Only published ones, or drafts never published.", schema: { type: "string", enum: ["published", "draft"] } },
    ]),
    post: write(
      "createArticle",
      "Create an article",
      "A new article, as a draft. Paragraphs are separated by a blank line. Publish it to put it live.",
      "Help centers and articles",
      "knowledge.manage",
      "Article",
      object({ title: text(200, "Its title."), body: { type: "string", maxLength: 100_000, description: "Its text; a blank line starts a paragraph." }, locale: { type: "string", minLength: 2, maxLength: 35, default: "en" } }, ["title"]),
      [],
      "201",
    ),
  },
  "/articles/{id}": {
    get: read("getArticle", "Retrieve an article", "One article: its draft and, if published, what's live.", "Help centers and articles", "conversations.read", "Article", [pathId("id", "article")]),
    patch: write(
      "updateArticle",
      "Update an article's draft",
      "Change the draft's title or text. What's live doesn't change until it's published again.",
      "Help centers and articles",
      "knowledge.manage",
      "Article",
      object({ title: text(200, "Its title."), body: { type: "string", maxLength: 100_000 } }),
      [pathId("id", "article")],
    ),
  },
  "/articles/{id}/publish": {
    post: op({
      operationId: "publishArticle",
      summary: "Publish an article",
      description: "Put the draft live (wherever it's placed: help centers, Zoe, the inbox).",
      tags: ["Help centers and articles"],
      "x-relay-scope": "knowledge.manage",
      parameters: [pathId("id", "article")],
      ok: ok(ref("Article")),
    }),
  },
  "/knowledge_records": {
    get: listing("listKnowledgeRecords", "List knowledge", "Everything Zoe and the inbox may draw on: articles, internal articles, snippets, files and synced pages.", "Knowledge", "conversations.read", "KnowledgeRecord", [
      { name: "source", in: "query", description: "Only this kind.", schema: { type: "string", enum: ["article", "internal_article", "snippet", "file", "external_page"] } },
    ]),
  },
  "/knowledge_records/{id}": { get: read("getKnowledgeRecord", "Retrieve knowledge", "One knowledge record.", "Knowledge", "conversations.read", "KnowledgeRecord", [pathId("id", "knowledge record")]) },
  "/macros": { get: listing("listMacros", "List macros", "Shared macros, and the token's teammate's own.", "Macros", "macros.use", "Macro", [], false) },
  "/macros/{id}": { get: read("getMacro", "Retrieve a macro", "One macro: its text and its actions.", "Macros", "macros.use", "Macro", [pathId("id", "macro")]) },
  "/conversations/{id}/macros": {
    post: write("applyMacro", "Apply a macro", "Apply a macro to a conversation: its reply or note, and its actions. Send `Idempotency-Key` to make retries safe.", "Macros", "macros.use", "Conversation", object({ macro_id: id("macro") }, ["macro_id"]), [pathId("id", "conversation")]),
  },
  "/workflows": { get: listing("listWorkflows", "List workflows", "The workspace's workflows (archived ones left out).", "Workflows", "workspace.manage", "Workflow", [], false) },
  "/workflows/{id}": { get: read("getWorkflow", "Retrieve a workflow", "One workflow.", "Workflows", "workspace.manage", "Workflow", [pathId("id", "workflow")]) },
  "/workflows/{id}/runs": { get: listing("listWorkflowRuns", "List a workflow's runs", "Its runs, newest first.", "Workflows", "workspace.manage", "WorkflowRun", [pathId("id", "workflow")]) },
  "/workflows/{id}/trigger": {
    post: write("triggerWorkflow", "Run a workflow", "Run a live, manually triggered workflow on a conversation. It runs in the background.", "Workflows", "conversations.manage", "WorkflowRunQueued", object({ conversation_id: id("conversation") }, ["conversation_id"]), [pathId("id", "workflow")], "202"),
  },
  "/outbound_messages": { get: listing("listOutboundMessages", "List outbound messages", "Chats and banners, with what they reached.", "Outbound", "workspace.manage", "OutboundMessage", [], false) },
  "/outbound_messages/{id}": { get: read("getOutboundMessage", "Retrieve an outbound message", "One outbound message and its numbers.", "Outbound", "workspace.manage", "OutboundMessage", [pathId("id", "outbound message")]) },
  "/data_attributes": {
    get: listing("listDataAttributes", "List data attributes", "The workspace's attributes for conversations and contacts.", "Data attributes", "conversations.read", "DataAttribute", [
      { name: "model", in: "query", description: "Only conversation or contact attributes.", schema: { type: "string", enum: ["conversation", "contact"] } },
    ], false),
    post: write(
      "createDataAttribute",
      "Create a conversation attribute",
      "A new attribute teammates fill in on conversations.",
      "Data attributes",
      "workspace.manage",
      "DataAttribute",
      object({ name: text(60, "Its name."), value_type: { type: "string", enum: ["string", "integer", "float", "boolean", "date", "options"] }, options: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 100 } } }, ["name", "value_type"]),
      [],
      "201",
    ),
  },
  "/segments": { get: listing("listSegments", "List segments", "Saved and built-in segments of contacts.", "Segments", "contacts.personal_data", "Segment", [], false) },
  "/segments/{id}/contacts": { get: listing("listSegmentContacts", "List a segment's contacts", "Who's in a segment now.", "Segments", "contacts.personal_data", "Contact", [pathId("id", "segment")]) },
  "/exports": {
    post: write(
      "createExport",
      "Export data",
      "Start an export of conversations, contacts and/or tickets (as newline-delimited JSON). It runs in the background; fetch it to see when it's ready.",
      "Data export",
      "data.export",
      "Export",
      object(
        {
          resources: { type: "array", maxItems: 3, items: { type: "string", enum: ["conversations", "contacts", "tickets"] } },
          created_after: { ...time, description: "Only what was created at or after this." },
          created_before: { ...time, description: "Only what was created before this." },
        },
        ["resources"],
      ),
      [],
      "202",
    ),
  },
  "/exports/{id}": { get: read("getExport", "Retrieve an export", "Its progress, and when it's done, links to its files (each valid for an hour).", "Data export", "data.export", "Export", [pathId("id", "export")]) },
});

Object.assign(SPEC.components.schemas, {
  Event: typed("event", { contact_id: { type: "string" }, name: { type: "string" }, metadata: { type: "object" }, source: { type: "string", enum: ["api", "messenger"] }, occurred_at: time }, ["name", "occurred_at"]),
  Ticket: typed(
    "ticket",
    {
      number: { type: "integer", description: "Its number in this workspace (#123)." },
      title: { type: "string" },
      ticket_type_id: { type: "string" },
      state: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, kind: { type: "string" } } },
      conversation_id: { type: "string" },
      created_at: time,
      updated_at: time,
    },
    ["number", "ticket_type_id", "state"],
  ),
  TicketType: typed(
    "ticket_type",
    {
      name: { type: "string" },
      category: { type: "string", enum: ["customer", "back_office", "tracker"] },
      description: { type: "string" },
      states: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, customer_label: { type: "string" }, kind: { type: "string" } } } },
    },
    ["name", "category", "states"],
  ),
  HelpCenter: typed(
    "help_center",
    {
      name: { type: "string" },
      brand_id: { type: "string" },
      slug: { type: "string" },
      access: { type: "string", enum: ["public", "signed_in"] },
      default_locale: { type: "string" },
      locales: { type: "array", items: { type: "string" } },
      collections: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } } } },
    },
    ["name", "collections"],
  ),
  Article: typed(
    "article",
    {
      title: { type: "string", description: "The draft's title." },
      body: { type: "string", description: "The draft's text." },
      state: { type: "string", enum: ["draft", "published"] },
      published_title: { type: ["string", "null"] },
      published_body: { type: ["string", "null"] },
      locale: { type: "string" },
      audience: { type: "string", enum: ["public", "signed_in", "internal"] },
      updated_at: time,
      published_at: { type: ["string", "null"], format: "date-time" },
    },
    ["title", "state"],
  ),
  KnowledgeRecord: typed(
    "knowledge_record",
    {
      source: { type: "string", enum: ["article", "internal_article", "snippet", "file", "external_page"] },
      title: { type: "string" },
      audience: { type: "string" },
      for_ai: { type: "boolean" },
      for_help_center: { type: "boolean" },
      for_inbox: { type: "boolean" },
      published: { type: "boolean" },
      updated_at: time,
    },
    ["source", "title"],
  ),
  Macro: typed(
    "macro",
    { name: { type: "string" }, mode: { type: "string", enum: ["reply", "note"] }, shared: { type: "boolean" }, body: { type: "string" }, actions: { type: "array", items: { type: "object" } } },
    ["name", "mode"],
  ),
  Workflow: typed("workflow", { name: { type: "string" }, trigger: { type: "string" }, state: { type: "string", enum: ["draft", "live", "paused"] }, updated_at: time }, ["name", "trigger", "state"]),
  WorkflowRun: typed("workflow_run", { workflow_id: { type: "string" }, conversation_id: { type: ["string", "null"] }, status: { type: "string" }, started_at: time, finished_at: { type: ["string", "null"], format: "date-time" } }, ["status"]),
  WorkflowRunQueued: { type: "object", required: ["type", "queued"], properties: { type: { type: "string", enum: ["workflow_run"] }, queued: { type: "boolean" } } },
  OutboundMessage: typed(
    "outbound_message",
    {
      title: { type: "string" },
      kind: { type: "string", enum: ["chat", "banner"] },
      state: { type: "string", enum: ["draft", "live", "paused", "archived"] },
      live_version: { type: ["integer", "null"] },
      stats: { type: "object", properties: { sent: { type: "integer" }, seen: { type: "integer" }, replied: { type: "integer" }, clicked: { type: "integer" }, dismissed: { type: "integer" } } },
      updated_at: time,
    },
    ["title", "kind", "state"],
  ),
  DataAttribute: typed(
    "data_attribute",
    { name: { type: "string" }, model: { type: "string", enum: ["conversation", "contact"] }, value_type: { type: "string" }, options: { type: "array", items: { type: "string" } }, archived: { type: "boolean" } },
    ["name", "model", "value_type"],
  ),
  Segment: typed("segment", { name: { type: "string" }, predefined: { type: "boolean" } }, ["name"]),
  Export: typed(
    "export",
    {
      status: { type: "string", enum: ["queued", "running", "done", "failed"] },
      resources: { type: "array", items: { type: "string" } },
      rows: { type: "integer" },
      files: { type: "array", items: { type: "object", properties: { resource: { type: "string" }, url: { type: "string" }, expires_at: time, rows: { type: "integer" } } } },
      created_at: time,
    },
    ["status", "resources"],
  ),
});

/** Every operation with its method and path, in the document's order. */
export function operations(spec: Spec = SPEC) {
  return Object.entries(spec.paths).flatMap(([path, methods]) =>
    (Object.entries(methods) as [string, Operation][]).map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })),
  );
}

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
      "Relay's REST API: conversations, contacts, tags, teammates and teams. Authenticate with a personal access token (Settings › Developers) as `Authorization: Bearer <token>`. Name a version with `Relay-Version`; without one, the token's own version is used.",
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

/** Every operation with its method and path, in the document's order. */
export function operations(spec: Spec = SPEC) {
  return Object.entries(spec.paths).flatMap(([path, methods]) =>
    (Object.entries(methods) as [string, Operation][]).map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })),
  );
}

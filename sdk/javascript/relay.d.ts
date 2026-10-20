// TypeScript types for the Relay API client, generated from lib/api-spec.ts by `npm run api:doc` (API version 2026-10-20). Don't edit by hand.
export type Pages = {
  next: string | null;
};
export type Error = {
  type: "error";
  request_id: string;
  errors: {
      code: string;
      message: string;
      field?: string;
    }[];
};
export type CustomAttributes = {
  [key: string]: string | number | boolean | null;
};
export type Me = {
  type: "token";
  workspace_id: string;
  teammate: Teammate;
  scopes: string[];
  version: string;
};
export type Conversation = {
  type: "conversation";
  id: string;
  title?: string;
  status: "open" | "snoozed" | "closed";
  channel: string;
  brand_id?: string | null;
  contact_id?: string | null;
  assignee_id?: string | null;
  team_id?: string | null;
  priority?: boolean;
  tags?: Tag[];
  snoozed_until?: string | null;
  waiting_since?: string | null;
  created_at: string;
  updated_at: string;
};
export type Part = {
  type: "conversation_part";
  id: string;
  seq: number;
  kind: string;
  audience: "public" | "internal";
  author?: {
    type?: string;
    id?: string | null;
  };
  body?: string;
  created_at: string;
};
export type Contact = {
  type: "contact";
  id: string;
  role: "visitor" | "lead" | "user";
  name?: string;
  email?: string | null;
  external_id?: string | null;
  custom_attributes?: CustomAttributes;
  first_seen_at?: string;
  last_seen_at?: string;
  signed_up_at?: string | null;
};
export type Tag = {
  type: "tag";
  id: string;
  name: string;
};
export type Teammate = {
  type: "teammate";
  id: string;
  name: string;
  presence?: "active" | "away" | "away_reassigning";
};
export type Team = {
  type: "team";
  id: string;
  name: string;
  member_ids: string[];
};
export type Event = {
  type: "event";
  id: string;
  contact_id?: string;
  name: string;
  metadata?: {
    [key: string]: unknown;
  };
  source?: "api" | "messenger";
  occurred_at: string;
};
export type Ticket = {
  type: "ticket";
  id: string;
  number: number;
  title?: string;
  ticket_type_id: string;
  state: {
    id?: string;
    name?: string;
    kind?: string;
  };
  conversation_id?: string;
  created_at?: string;
  updated_at?: string;
};
export type TicketType = {
  type: "ticket_type";
  id: string;
  name: string;
  category: "customer" | "back_office" | "tracker";
  description?: string;
  states: {
      id?: string;
      name?: string;
      customer_label?: string;
      kind?: string;
    }[];
};
export type HelpCenter = {
  type: "help_center";
  id: string;
  name: string;
  brand_id?: string;
  slug?: string;
  access?: "public" | "signed_in";
  default_locale?: string;
  locales?: string[];
  collections: {
      id?: string;
      name?: string;
      description?: string;
    }[];
};
export type Article = {
  type: "article";
  id: string;
  title: string;
  body?: string;
  state: "draft" | "published";
  published_title?: string | null;
  published_body?: string | null;
  locale?: string;
  audience?: "public" | "signed_in" | "internal";
  updated_at?: string;
  published_at?: string | null;
};
export type KnowledgeRecord = {
  type: "knowledge_record";
  id: string;
  source: "article" | "internal_article" | "snippet" | "file" | "external_page";
  title: string;
  audience?: string;
  for_ai?: boolean;
  for_help_center?: boolean;
  for_inbox?: boolean;
  published?: boolean;
  updated_at?: string;
};
export type Macro = {
  type: "macro";
  id: string;
  name: string;
  mode: "reply" | "note";
  shared?: boolean;
  body?: string;
  actions?: {
      [key: string]: unknown;
    }[];
};
export type Workflow = {
  type: "workflow";
  id: string;
  name: string;
  trigger: string;
  state: "draft" | "live" | "paused";
  updated_at?: string;
};
export type WorkflowRun = {
  type: "workflow_run";
  id: string;
  workflow_id?: string;
  conversation_id?: string | null;
  status: string;
  started_at?: string;
  finished_at?: string | null;
};
export type WorkflowRunQueued = {
  type: "workflow_run";
  queued: boolean;
};
export type OutboundMessage = {
  type: "outbound_message";
  id: string;
  title: string;
  kind: "chat" | "banner";
  state: "draft" | "live" | "paused" | "archived";
  live_version?: number | null;
  stats?: {
    sent?: number;
    seen?: number;
    replied?: number;
    clicked?: number;
    dismissed?: number;
  };
  updated_at?: string;
};
export type DataAttribute = {
  type: "data_attribute";
  id: string;
  name: string;
  model: "conversation" | "contact";
  value_type: string;
  options?: string[];
  archived?: boolean;
};
export type Segment = {
  type: "segment";
  id: string;
  name: string;
  predefined?: boolean;
};
export type Export = {
  type: "export";
  id: string;
  status: "queued" | "running" | "done" | "failed";
  resources: string[];
  rows?: number;
  files?: {
      resource?: string;
      url?: string;
      expires_at?: string;
      rows?: number;
    }[];
  created_at?: string;
};
export type RequestOptions<Q> = { query?: Q; idempotencyKey?: string };
export declare class RelayError extends Error {
  status: number;
  code: string;
  field?: string;
  requestId?: string;
  errors: { code: string; message: string; field?: string }[];
}
export declare class Relay {
  constructor(options: { token: string; baseUrl: string; version?: string; maxRetries?: number; fetch?: typeof fetch });
  request(method: string, path: string, options?: { query?: Record<string, unknown>; body?: unknown; idempotencyKey?: string }): Promise<unknown>;
  /** Who the token is. */
  getMe(options?: RequestOptions<never>): Promise<Me>;
  /** List conversations. */
  listConversations(options?: RequestOptions<{ status?: "open" | "snoozed" | "closed"; assignee_id?: string; team_id?: string; per_page?: number; starting_after?: string }>): Promise<{
    type: "list";
    data: Conversation[];
    pages: Pages;
  }>;
  listConversationsAll(options?: RequestOptions<{ status?: "open" | "snoozed" | "closed"; assignee_id?: string; team_id?: string; per_page?: number; starting_after?: string }>): AsyncGenerator<Conversation>;
  /** Start a conversation for a contact. */
  createConversation(body: {
    contact_id: string;
    body: string;
  }, options?: RequestOptions<never>): Promise<Conversation>;
  /** Retrieve a conversation. */
  getConversation(id: string, options?: RequestOptions<never>): Promise<Conversation>;
  /** List a conversation's parts. */
  listConversationParts(id: string, options?: RequestOptions<{ per_page?: number; starting_after?: string }>): Promise<{
    type: "list";
    data: Part[];
    pages: Pages;
  }>;
  listConversationPartsAll(id: string, options?: RequestOptions<{ per_page?: number; starting_after?: string }>): AsyncGenerator<Part>;
  /** Reply. */
  replyToConversation(id: string, body: {
    body: string;
  }, options?: RequestOptions<never>): Promise<Conversation>;
  /** Add an internal note. */
  addConversationNote(id: string, body: {
    body: string;
  }, options?: RequestOptions<never>): Promise<Conversation>;
  /** Assign. */
  assignConversation(id: string, body: {
    assignee_id?: string | null;
    team_id?: string | null;
  }, options?: RequestOptions<never>): Promise<Conversation>;
  /** Snooze. */
  snoozeConversation(id: string, body: {
    until: string;
  }, options?: RequestOptions<never>): Promise<Conversation>;
  /** Close. */
  closeConversation(id: string, options?: RequestOptions<never>): Promise<Conversation>;
  /** Reopen. */
  openConversation(id: string, options?: RequestOptions<never>): Promise<Conversation>;
  /** Tag. */
  tagConversation(id: string, body: {
    tag_id: string;
  }, options?: RequestOptions<never>): Promise<Conversation>;
  /** Remove a tag. */
  untagConversation(id: string, tagId: string, options?: RequestOptions<never>): Promise<Conversation>;
  /** List contacts. */
  listContacts(options?: RequestOptions<{ email?: string; external_id?: string; per_page?: number; starting_after?: string }>): Promise<{
    type: "list";
    data: Contact[];
    pages: Pages;
  }>;
  listContactsAll(options?: RequestOptions<{ email?: string; external_id?: string; per_page?: number; starting_after?: string }>): AsyncGenerator<Contact>;
  /** Create a contact. */
  createContact(body: {
    external_id?: string;
    email?: string;
    name?: string;
    custom_attributes?: CustomAttributes;
  }, options?: RequestOptions<never>): Promise<Contact>;
  /** Retrieve a contact. */
  getContact(id: string, options?: RequestOptions<never>): Promise<Contact>;
  /** Update a contact. */
  updateContact(id: string, body: {
    name?: string;
    custom_attributes?: CustomAttributes;
  }, options?: RequestOptions<never>): Promise<Contact>;
  /** List tags. */
  listTags(options?: RequestOptions<never>): Promise<{
    type: "list";
    data: Tag[];
    pages: Pages;
  }>;
  /** Create a tag. */
  createTag(body: {
    name: string;
  }, options?: RequestOptions<never>): Promise<Tag>;
  /** List teammates. */
  listTeammates(options?: RequestOptions<never>): Promise<{
    type: "list";
    data: Teammate[];
    pages: Pages;
  }>;
  /** Retrieve a teammate. */
  getTeammate(id: string, options?: RequestOptions<never>): Promise<Teammate>;
  /** List teams. */
  listTeams(options?: RequestOptions<never>): Promise<{
    type: "list";
    data: Team[];
    pages: Pages;
  }>;
  /** Retrieve a team. */
  getTeam(id: string, options?: RequestOptions<never>): Promise<Team>;
  /** Search conversations. */
  searchConversations(body: {
    query: {
      [key: string]: unknown;
    };
    sort?: {
      field: string;
      order?: "asc" | "desc";
    };
    per_page?: number;
    starting_after?: string;
  }, options?: RequestOptions<never>): Promise<{
    type: "list";
    data: Conversation[];
    pages: Pages;
  }>;
  searchConversationsAll(body: {
    query: {
      [key: string]: unknown;
    };
    sort?: {
      field: string;
      order?: "asc" | "desc";
    };
    per_page?: number;
    starting_after?: string;
  }, options?: RequestOptions<never>): AsyncGenerator<Conversation>;
  /** Search contacts. */
  searchContacts(body: {
    query: {
      [key: string]: unknown;
    };
    sort?: {
      field: string;
      order?: "asc" | "desc";
    };
    per_page?: number;
    starting_after?: string;
  }, options?: RequestOptions<never>): Promise<{
    type: "list";
    data: Contact[];
    pages: Pages;
  }>;
  searchContactsAll(body: {
    query: {
      [key: string]: unknown;
    };
    sort?: {
      field: string;
      order?: "asc" | "desc";
    };
    per_page?: number;
    starting_after?: string;
  }, options?: RequestOptions<never>): AsyncGenerator<Contact>;
  /** List a contact's events. */
  listContactEvents(id: string, options?: RequestOptions<{ per_page?: number; starting_after?: string }>): Promise<{
    type: "list";
    data: Event[];
    pages: Pages;
  }>;
  listContactEventsAll(id: string, options?: RequestOptions<{ per_page?: number; starting_after?: string }>): AsyncGenerator<Event>;
  /** Record an event. */
  createContactEvent(id: string, body: {
    id: string;
    name: string;
    metadata?: {
      [key: string]: string | number | boolean | null;
    };
    occurred_at?: string;
  }, options?: RequestOptions<never>): Promise<Event>;
  /** List tickets. */
  listTickets(options?: RequestOptions<{ ticket_type_id?: string; state?: "submitted" | "in_progress" | "waiting_on_customer" | "resolved"; per_page?: number; starting_after?: string }>): Promise<{
    type: "list";
    data: Ticket[];
    pages: Pages;
  }>;
  listTicketsAll(options?: RequestOptions<{ ticket_type_id?: string; state?: "submitted" | "in_progress" | "waiting_on_customer" | "resolved"; per_page?: number; starting_after?: string }>): AsyncGenerator<Ticket>;
  /** Make a conversation a ticket. */
  createTicket(body: {
    conversation_id: string;
    ticket_type_id: string;
    state_id?: string;
  }, options?: RequestOptions<never>): Promise<Ticket>;
  /** Retrieve a ticket. */
  getTicket(id: string, options?: RequestOptions<never>): Promise<Ticket>;
  /** Change a ticket's state. */
  setTicketState(id: string, body: {
    state_id: string;
  }, options?: RequestOptions<never>): Promise<Ticket>;
  /** List ticket types. */
  listTicketTypes(options?: RequestOptions<never>): Promise<{
    type: "list";
    data: TicketType[];
    pages: Pages;
  }>;
  /** Retrieve a ticket type. */
  getTicketType(id: string, options?: RequestOptions<never>): Promise<TicketType>;
  /** List help centers. */
  listHelpCenters(options?: RequestOptions<never>): Promise<{
    type: "list";
    data: HelpCenter[];
    pages: Pages;
  }>;
  /** Retrieve a help center. */
  getHelpCenter(id: string, options?: RequestOptions<never>): Promise<HelpCenter>;
  /** List articles. */
  listArticles(options?: RequestOptions<{ state?: "published" | "draft"; per_page?: number; starting_after?: string }>): Promise<{
    type: "list";
    data: Article[];
    pages: Pages;
  }>;
  listArticlesAll(options?: RequestOptions<{ state?: "published" | "draft"; per_page?: number; starting_after?: string }>): AsyncGenerator<Article>;
  /** Create an article. */
  createArticle(body: {
    title: string;
    body?: string;
    locale?: string;
  }, options?: RequestOptions<never>): Promise<Article>;
  /** Retrieve an article. */
  getArticle(id: string, options?: RequestOptions<never>): Promise<Article>;
  /** Update an article's draft. */
  updateArticle(id: string, body: {
    title?: string;
    body?: string;
  }, options?: RequestOptions<never>): Promise<Article>;
  /** Publish an article. */
  publishArticle(id: string, options?: RequestOptions<never>): Promise<Article>;
  /** List knowledge. */
  listKnowledgeRecords(options?: RequestOptions<{ source?: "article" | "internal_article" | "snippet" | "file" | "external_page"; per_page?: number; starting_after?: string }>): Promise<{
    type: "list";
    data: KnowledgeRecord[];
    pages: Pages;
  }>;
  listKnowledgeRecordsAll(options?: RequestOptions<{ source?: "article" | "internal_article" | "snippet" | "file" | "external_page"; per_page?: number; starting_after?: string }>): AsyncGenerator<KnowledgeRecord>;
  /** Retrieve knowledge. */
  getKnowledgeRecord(id: string, options?: RequestOptions<never>): Promise<KnowledgeRecord>;
  /** List macros. */
  listMacros(options?: RequestOptions<never>): Promise<{
    type: "list";
    data: Macro[];
    pages: Pages;
  }>;
  /** Retrieve a macro. */
  getMacro(id: string, options?: RequestOptions<never>): Promise<Macro>;
  /** Apply a macro. */
  applyMacro(id: string, body: {
    macro_id: string;
  }, options?: RequestOptions<never>): Promise<Conversation>;
  /** List workflows. */
  listWorkflows(options?: RequestOptions<never>): Promise<{
    type: "list";
    data: Workflow[];
    pages: Pages;
  }>;
  /** Retrieve a workflow. */
  getWorkflow(id: string, options?: RequestOptions<never>): Promise<Workflow>;
  /** List a workflow's runs. */
  listWorkflowRuns(id: string, options?: RequestOptions<{ per_page?: number; starting_after?: string }>): Promise<{
    type: "list";
    data: WorkflowRun[];
    pages: Pages;
  }>;
  listWorkflowRunsAll(id: string, options?: RequestOptions<{ per_page?: number; starting_after?: string }>): AsyncGenerator<WorkflowRun>;
  /** Run a workflow. */
  triggerWorkflow(id: string, body: {
    conversation_id: string;
  }, options?: RequestOptions<never>): Promise<WorkflowRunQueued>;
  /** List outbound messages. */
  listOutboundMessages(options?: RequestOptions<never>): Promise<{
    type: "list";
    data: OutboundMessage[];
    pages: Pages;
  }>;
  /** Retrieve an outbound message. */
  getOutboundMessage(id: string, options?: RequestOptions<never>): Promise<OutboundMessage>;
  /** List data attributes. */
  listDataAttributes(options?: RequestOptions<{ model?: "conversation" | "contact" }>): Promise<{
    type: "list";
    data: DataAttribute[];
    pages: Pages;
  }>;
  /** Create a conversation attribute. */
  createDataAttribute(body: {
    name: string;
    value_type: "string" | "integer" | "float" | "boolean" | "date" | "options";
    options?: string[];
  }, options?: RequestOptions<never>): Promise<DataAttribute>;
  /** List segments. */
  listSegments(options?: RequestOptions<never>): Promise<{
    type: "list";
    data: Segment[];
    pages: Pages;
  }>;
  /** List a segment's contacts. */
  listSegmentContacts(id: string, options?: RequestOptions<{ per_page?: number; starting_after?: string }>): Promise<{
    type: "list";
    data: Contact[];
    pages: Pages;
  }>;
  listSegmentContactsAll(id: string, options?: RequestOptions<{ per_page?: number; starting_after?: string }>): AsyncGenerator<Contact>;
  /** Export data. */
  createExport(body: {
    resources: ("conversations" | "contacts" | "tickets")[];
    created_after?: string;
    created_before?: string;
  }, options?: RequestOptions<never>): Promise<Export>;
  /** Retrieve an export. */
  getExport(id: string, options?: RequestOptions<never>): Promise<Export>;
}

/**
 * The app-slot contract (version 1) for cards that phase 15 apps will render in the
 * conversation sidebar. Phase 4 defines the contract only: no app code is loaded, and the
 * sidebar renders app cards only when the server returns some (it returns none until phase 15).
 *
 * An app never touches Relay directly. It receives a context scoped to one workspace,
 * conversation and customer, and asks the host to act for it; the host refuses any capability
 * the app did not declare and any conversation other than the one in its context.
 */
export const APP_SLOT_VERSION = 1;
export type AppSlotName = "conversation.sidebar";
export type AppCapability =
  "conversation.read" | "conversation.note" | "conversation.attributes.write";

export type AppSlotContext = {
  version: typeof APP_SLOT_VERSION;
  slot: AppSlotName;
  workspaceId: string;
  conversationId: string;
  /** Absent when the teammate may not see personal data or there is no customer. */
  contactId?: string;
};

/** What an app asks the host to do. Each type needs the matching declared capability. */
export type AppRequest =
  | { type: "conversation.read"; conversationId: string }
  | { type: "conversation.note"; conversationId: string; text: string }
  | {
      type: "conversation.attributes.write";
      conversationId: string;
      attributeId: string;
      value: unknown;
    };

/** A card as the server describes it: which app, what it declares, and its current state. */
export type AppCard = {
  appId: string;
  title: string;
  capabilities: AppCapability[];
  state:
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; blocks: { type: "text" | "heading"; text: string }[] };
};

export class AppRequestRefused extends Error {
  constructor(
    public code:
      "CAPABILITY_NOT_DECLARED" | "OUT_OF_CONTEXT" | "UNSUPPORTED_VERSION",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The host side of the contract: gives an app its scoped context and passes on only requests
 * it declared a capability for, about its own conversation. `perform` does the work (with the
 * signed-in teammate's own permissions, which still apply).
 */
export function createAppHost(
  card: Pick<AppCard, "appId" | "capabilities">,
  context: AppSlotContext,
  perform: (request: AppRequest) => Promise<unknown>,
) {
  if (context.version !== APP_SLOT_VERSION)
    throw new AppRequestRefused(
      "UNSUPPORTED_VERSION",
      "This app slot version is not supported.",
    );
  const declared = new Set(card.capabilities);
  return {
    context: Object.freeze({ ...context }),
    async request(request: AppRequest) {
      if (!declared.has(request.type))
        throw new AppRequestRefused(
          "CAPABILITY_NOT_DECLARED",
          `${card.appId} did not declare ${request.type}.`,
        );
      if (request.conversationId !== context.conversationId)
        throw new AppRequestRefused(
          "OUT_OF_CONTEXT",
          `${card.appId} can only act on the conversation it is shown in.`,
        );
      return perform(request);
    },
  };
}

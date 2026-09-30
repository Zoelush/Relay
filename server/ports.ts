/** Contracts only. Providers are intentionally absent until their owning phase ships. */
export interface HelpCenterPort {
  // TODO: Help-center phase (number not assigned) owns publishing, search and signed search receipts.
  search(
    scope: { workspaceId: string; brandId: string; locale: string },
    query: string,
  ): Promise<{ id: string; title: string; excerpt: string }[]>;
  read(
    scope: { workspaceId: string; brandId: string; locale: string },
    articleId: string,
  ): Promise<{
    id: string;
    title: string;
    sanitizedHtml: string;
    version: string;
  }>;
  verifySearchReceipt(
    scope: { workspaceId: string; identityId: string; brandId: string },
    receipt: string,
  ): Promise<boolean>;
}
export interface TicketPort {
  // TODO: Phase 5 owns ticket types, fields, lifecycle and conversion transactions.
  history(scope: {
    workspaceId: string;
    identityId: string;
    brandId: string;
  }): Promise<{ id: string; title: string; state: string }[]>;
  convert(
    scope: { workspaceId: string; conversationId: string; teammateId: string },
    typeId: string,
    idempotencyKey: string,
  ): Promise<{ ticketId: string }>;
}
export interface RoutingPort {
  // Implemented by routingPort in server/routing.ts (phase 06): the server's own queue order.
  queuePosition(scope: {
    workspaceId: string;
    brandId: string;
    conversationId: string;
  }): Promise<{ position: number; asOf: string } | null>;
}
export interface EventStorePort {
  // TODO: Full people/events phase owns Pipelines/Iceberg ingestion, exact occurrence queries and retention writer.
  append(
    event: {
      workspaceId: string;
      eventId: string;
      identityId: string;
      name: string;
      occurredAt: string;
      originTimezone: string | null;
      metadata: Record<string, unknown>;
    },
    idempotencyKey: string,
  ): Promise<{ receiptId: string; watermark: string }>;
  exactCounts(
    scope: { workspaceId: string; identityIds: string[] },
    filter: { name: string; from: string; to: string },
    watermark: string,
  ): Promise<Map<string, number>>;
}

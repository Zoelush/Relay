/** System events a customer may see; every other system event stays with teammates. */
const CUSTOMER_EVENTS = new Set(["human_joined", "ticket_status"]);
/** All customer delivery adapters must use this boundary before enqueue/send. */
export function customerVisiblePart(part: {
  kind: string;
  audience: string;
  attachment_audience?: unknown;
  data?: unknown;
}) {
  return (
    part.audience === "public" &&
    part.kind !== "internal_note" &&
    (part.kind !== "system_event" ||
      CUSTOMER_EVENTS.has(
        String((part.data as { event?: unknown } | undefined)?.event),
      )) &&
    (part.kind !== "attachment" ||
      part.attachment_audience === "customer_visible")
  );
}

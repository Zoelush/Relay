/** All customer delivery adapters must use this boundary before enqueue/send. */
export function customerVisiblePart(part: {
  kind: string;
  audience: string;
  attachment_audience?: unknown;
}) {
  return (
    part.audience === "public" &&
    part.kind !== "internal_note" &&
    (part.kind !== "attachment" ||
      part.attachment_audience === "customer_visible")
  );
}

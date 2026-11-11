import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { money, STATUS_WORDS, unitPrice, type InvoiceStatus } from "../lib/invoices";
import type { readInvoice } from "./invoices";

/**
 * An invoice as a PDF (phase 16, step C10a; docs/SECURITY_STEP20.md), generated on the server from
 * the issued invoice (never from anything the browser sends), with pdf-lib (plain JavaScript, so it
 * runs on Workers). Its lines are the invoice's; their units are on the invoice's page in Relay.
 */
type Invoice = Awaited<ReturnType<typeof readInvoice>>;

/** The standard fonts' encoding (WinAnsi) has no "›", "−" or "…": replaced, never dropped silently. */
export const pdfText = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[−–—]/g, "-")
    .replace(/›/g, ">")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const quantity = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { maximumFractionDigits: 4 }));

export async function invoicePdf(data: Invoice): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfText(`Relay invoice ${data.invoice.number}`));
  doc.setAuthor("Relay");
  doc.setCreator("Relay");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595.28, 841.89]); // A4
  const ink = rgb(0.1, 0.12, 0.14);
  const muted = rgb(0.42, 0.45, 0.48);
  let y = 790;
  const text = (p: PDFPage, s: string, x: number, at: number, o: { size?: number; font?: PDFFont; color?: typeof ink; right?: boolean } = {}) => {
    const f = o.font ?? font;
    const size = o.size ?? 10;
    const t = pdfText(s);
    p.drawText(t, { x: o.right ? x - f.widthOfTextAtSize(t, size) : x, y: at, size, font: f, color: o.color ?? ink });
  };
  const inv = data.invoice;
  text(page, "Relay", 50, y, { size: 22, font: bold });
  text(page, `Invoice ${inv.number}`, 545, y, { size: 14, font: bold, right: true });
  y -= 22;
  text(page, `Issued ${day(inv.issuedAt)}`, 545, y, { color: muted, right: true });
  y -= 14;
  text(page, `Period ${day(inv.period.start)} to ${day(inv.period.end)}`, 545, y, { color: muted, right: true });
  y -= 14;
  text(page, `Status: ${STATUS_WORDS[inv.status as InvoiceStatus]}${inv.paidAt ? ` (${day(inv.paidAt)})` : ""}`, 545, y, { color: muted, right: true });

  // Bill to.
  let by = 768;
  text(page, "Bill to", 50, by, { font: bold });
  const b = data.billTo;
  for (const line of [b.name, b.addressLine1, b.addressLine2, [b.postalCode, b.city].filter(Boolean).join(" "), b.country, b.email, b.taxId ? `Tax ID ${b.taxId}` : ""].filter(Boolean)) {
    by -= 14;
    text(page, line, 50, by);
  }
  y = Math.min(y, by) - 36;

  // Lines.
  const header = (p: PDFPage, at: number) => {
    text(p, "Description", 50, at, { font: bold });
    text(p, "Quantity", 350, at, { font: bold, right: true });
    text(p, "Unit price", 450, at, { font: bold, right: true });
    text(p, "Amount", 545, at, { font: bold, right: true });
    p.drawLine({ start: { x: 50, y: at - 6 }, end: { x: 545, y: at - 6 }, thickness: 0.5, color: muted });
  };
  header(page, y);
  y -= 24;
  for (const l of data.lines) {
    if (y < 120) {
      page = doc.addPage([595.28, 841.89]);
      y = 790;
      header(page, y);
      y -= 24;
    }
    const words = pdfText(l.description);
    text(page, words.length > 52 ? words.slice(0, 51) + "..." : words, 50, y);
    if (l.kind !== "tax") text(page, quantity(l.quantity), 350, y, { right: true });
    if (l.kind !== "tax") text(page, l.unitCents === null ? "-" : unitPrice(l.unitCents), 450, y, { right: true });
    text(page, l.amountCents === null ? "-" : money(l.amountCents, inv.currency), 545, y, { right: true });
    y -= 18;
  }
  page.drawLine({ start: { x: 300, y: y + 8 }, end: { x: 545, y: y + 8 }, thickness: 0.5, color: muted });
  y -= 6;
  for (const [label, cents, f] of [
    ["Subtotal", inv.subtotalCents, font],
    ["Tax", inv.taxCents, font],
    ["Total", inv.totalCents, bold],
  ] as const) {
    text(page, label, 450, y, { font: f, right: true });
    text(page, cents === null ? "-" : money(cents, inv.currency), 545, y, { font: f, right: true });
    y -= 16;
  }
  y -= 18;
  const notes = [
    inv.status === "unpriced" ? "Prices aren't set yet, so this invoice has quantities but no amounts, and nothing is charged." : "",
    "Each line's units (every message, call, resolution or seat it counts) are listed on this invoice's page in Relay.",
    inv.failure ? `Last payment attempt: ${inv.failure}` : "",
  ].filter(Boolean);
  for (const n of notes) {
    text(page, n, 50, y, { size: 9, color: muted });
    y -= 13;
  }
  return doc.save();
}

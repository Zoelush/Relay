import { METERS, type MeterId } from "./meters";
import type { PlanId } from "./plans";

/**
 * Invoices (phase 16, step C10a; docs/SECURITY_STEP20.md), shared by the server, the PDF and
 * Settings › Billing › Invoices. One invoice per billing period, issued at its start:
 *
 * - **seats:** the plan's full seats for the new period, in advance (each a whole period);
 * - **proration:** full seats added during the last period, each its share of it (from `seatBill`);
 * - **usage:** the last period's metered units, one line per meter, each unit frozen with its record;
 * - **plan_change:** C10b — an upgrade's difference for the rest of the period it happened in;
 * - **tax:** zero for now. TODO(before launch): a tax provider behind `TaxPort` (`server/invoices.ts`).
 *
 * While any price it needs is a placeholder, an invoice is issued `unpriced`: quantities and units,
 * no amounts, never charged.
 */
export type InvoiceStatus = "unpriced" | "open" | "paid" | "failed" | "void";
export type LineKind = "seats" | "proration" | "usage" | "tax" | "plan_change";

/** What things cost, in cents (fractions allowed per unit); `null` is a placeholder. The plan policy's is `priceBook()` (`server/plans.ts`); tests pass their own. */
export type PriceBook = { seat: Record<PlanId, number | null>; units: Record<MeterId, number | null> };

/** RLY-2026-000123: one sequence for all of Relay's invoices, with the year it was issued. */
export const invoiceNumber = (year: number, n: number) => `RLY-${year}-${String(n).padStart(6, "0")}`;

/** A line's amount: its quantity at its unit price, rounded to the cent (null while unpriced). */
export const lineAmount = (quantity: number, unitCents: number | null) => (unitCents === null ? null : Math.round(quantity * unitCents));

export const money = (cents: number | null, currency = "usd") =>
  cents === null ? "Price not set" : (cents < 0 ? "−" : "") + (currency === "usd" ? "$" : currency.toUpperCase() + " ") + (Math.abs(cents) / 100).toFixed(2);

/** A unit price: whole cents as money, a fraction of a cent to 4 places ($0.0075). */
export const unitPrice = (cents: number | null) => (cents === null ? "Price not set" : Number.isInteger(cents) ? money(cents) : `$${(cents / 100).toFixed(4)}`);

/** A usage line's words: the meter's label. */
export const usageDescription = (meter: MeterId) => METERS[meter].label;

export const STATUS_WORDS: Record<InvoiceStatus, string> = {
  unpriced: "Not priced yet",
  open: "Due",
  paid: "Paid",
  failed: "Payment failed",
  void: "Void",
};

import { placeholders } from "../lib/plans";

/**
 * Phase 16 C8a: with billing live (RELAY_BILLING_LIVE=true), every price in the plan policy must be
 * set. Run before going live (C10); `tests/plans.test.ts` checks the same.
 */
const missing = placeholders();
if (process.env.RELAY_BILLING_LIVE === "true" && missing.length) {
  console.error(`Prices still to set in lib/plans.ts: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(missing.length ? `Prices not set yet (billing isn't live): ${missing.length}` : "Every price is set.");

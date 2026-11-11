import { expect, type Page } from "@playwright/test";

/**
 * Settings' menu, with every group unfolded (its groups start folded, except the shown page's).
 * Tests that look for an entry, or check one is absent for a teammate, open them all first, so an
 * absent entry means it isn't allowed, never just folded away.
 */
export async function settingsMenu(page: Page) {
  const nav = page.getByRole("navigation", { name: "Settings pages" });
  await expect(nav).toBeVisible({ timeout: 15000 });
  await expect(nav.locator("h2 button").first()).toBeVisible({ timeout: 15000 });
  // One at a time: each click changes which groups are folded.
  const folded = nav.locator("h2 button[aria-expanded='false']");
  for (let n = await folded.count(); n > 0; n = await folded.count()) await folded.first().click();
  await expect(nav.locator("h2 button[aria-expanded='false']")).toHaveCount(0);
  return nav;
}

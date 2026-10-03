import type { Page } from "@playwright/test";

/**
 * Settings › Messenger is laid out as Intercom's is (messenger settings M4): tabs, Content and
 * Appearance under Widget, and sections that open one at a time. Opens `title` under `tab`.
 */
export async function section(
  page: Page,
  tab: "Widget" | "Conversations" | "General",
  title: string,
  widget?: "Content" | "Appearance",
) {
  await page
    .getByRole("tablist", { name: "Messenger settings" })
    .getByRole("tab", { name: tab, exact: true })
    .click();
  if (widget)
    await page
      .getByRole("radiogroup", { name: "Widget settings" })
      .getByRole("radio", { name: widget, exact: true })
      .click();
  const button = page.locator(".pg-accordion h3 button").filter({
    has: page.locator("strong", { hasText: new RegExp(`^${title}$`) }),
  });
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
}
/** Opens a whole tab (Install, Security). */
export const tab = (page: Page, name: "Install" | "Security") =>
  page
    .getByRole("tablist", { name: "Messenger settings" })
    .getByRole("tab", { name, exact: true })
    .click();
/** The Visitors/Users switch inside the open section. */
export const audience = (page: Page, who: "Visitors" | "Users") =>
  page
    .getByRole("radiogroup", { name: "Audience", exact: true })
    .getByRole("radio", { name: who, exact: true })
    .click();
export const setLive = (page: Page) =>
  page.getByRole("button", { name: "Save and set live" }).click();

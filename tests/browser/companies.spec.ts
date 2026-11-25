import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tab } from "./messenger-sections";

/**
 * Companies (docs/PEOPLE_STEP2.md, phase 01 P1b), end to end in the inbox. Happy path: a customer
 * the API put in a company shows it in the sidebar with its plan, seats, spend and custom data; a
 * teammate adds them to a new company, changes their role and takes them out of one. Failure path:
 * a company deleted while the picker was open is refused in words, and the sidebar keeps what was
 * there. And the messenger setting is off by default and switched on in Settings.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9232, hostPort: 9233, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});

const ask = <T,>(page: Page, path: string, body: Record<string, unknown>) =>
  page.evaluate(
    async ([path, body]) =>
      (await (
        await fetch("/api/agent/" + path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) })
      ).json()) as T,
    [path, body] as const,
  );

test("a customer's companies show in the sidebar, and a teammate adds, changes and removes them", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/developers");
  await expect(page.locator("main")).toBeVisible({ timeout: 20000 });
  const { token } = await ask<{ token: string }>(page, "developer-token", { action: "create", name: "e2e", scopes: ["contacts.personal_data", "conversations.reply"] });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(relay.apiOrigin + "/rest" + path, {
      method,
      headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const umbrella = await call("POST", "/companies", { company_id: "umbrella", name: "Umbrella Corp", plan: "Enterprise", seats: 300, monthly_spend: 9900, custom_attributes: { industry: "Pharma" } });
  expect(umbrella.status).toBe(200);
  const doomed = await call("POST", "/companies", { company_id: "doomed", name: "Doomed Ventures" });
  const contact = await call("POST", "/contacts", { email: "jill@example.test", name: "Jill Valentine" });
  expect((await call("POST", `/contacts/${contact.body.id}/companies`, { company_id: umbrella.body.id, role: "Security lead" })).status).toBe(200);
  await call("POST", "/conversations", { contact_id: contact.body.id, body: "Our seats ran out" });

  // Shown: the company with its plan, seats and spend, the customer's role, and its custom data.
  await page.goto(relay.hostOrigin + "/agent");
  await page.getByRole("button", { name: /Our seats ran out/ }).first().click();
  const companies = page.getByRole("region", { name: "Companies" });
  const umbrellaCard = companies.locator(".pg-company", { hasText: "Umbrella Corp" });
  await expect(umbrellaCard).toContainText("Enterprise · 300 seats · 9,900 a month", { timeout: 20000 });
  await expect(umbrellaCard.locator(".pg-ctx-row", { hasText: "Role" })).toContainText("Security lead");
  await expect(umbrellaCard.locator(".pg-ctx-row", { hasText: "industry" })).toContainText("Pharma");
  await expect(umbrellaCard).toContainText("Added through the API");

  // Added to a new company, made from the picker, with a role.
  await companies.getByRole("button", { name: "Add to a company" }).click();
  await companies.getByLabel("Company").fill("Raccoon Labs");
  await companies.getByLabel("Their role (optional)").fill("Consultant");
  await companies.getByRole("button", { name: "Create “Raccoon Labs”" }).click();
  const raccoon = companies.locator(".pg-company", { hasText: "Raccoon Labs" });
  await expect(raccoon.locator(".pg-ctx-row", { hasText: "Role" })).toContainText("Consultant");
  await expect(raccoon).toContainText("Added by a teammate");

  // Their role changed, then they're taken out of Raccoon Labs.
  await companies.getByRole("button", { name: "Change Jill Valentine's role at Umbrella Corp" }).click();
  await companies.getByLabel("Role at Umbrella Corp").fill("Chief of security");
  await companies.getByRole("button", { name: "Save" }).click();
  await expect(umbrellaCard.locator(".pg-ctx-row", { hasText: "Role" })).toContainText("Chief of security");
  await companies.getByRole("button", { name: "Remove Jill Valentine from Raccoon Labs" }).click();
  await expect(raccoon).toHaveCount(0);
  const memberships = (await call("GET", `/contacts/${contact.body.id}/companies`)).body.data.map((m: any) => [m.name, m.role, m.source]);
  expect(memberships).toEqual([["Umbrella Corp", "Chief of security", "api"]]);

  // A company deleted while the picker shows it: refused in words, and nothing changes.
  await companies.getByRole("button", { name: "Add to a company" }).click();
  await companies.getByLabel("Company").fill("Doomed");
  const choice = companies.getByRole("button", { name: /Doomed Ventures/ });
  await expect(choice).toBeVisible();
  expect((await call("DELETE", `/companies/${doomed.body.id}`)).body.deleted).toBe(true);
  await choice.click();
  await expect(companies.getByRole("alert")).toContainText("No such company.");
  await expect(companies.locator(".pg-company")).toHaveCount(1);
});

test("the messenger may set companies only once the workspace turns it on", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/messenger");
  await expect(page.locator("main")).toBeVisible({ timeout: 20000 });
  await tab(page, "Security");
  const toggle = page.getByRole("checkbox", { name: /Accept companies from signed identity tokens/ });
  await expect(toggle).not.toBeChecked({ timeout: 20000 });
  await toggle.check();
  await expect(page.getByText("The messenger can now set companies.")).toBeVisible();
  await page.reload();
  await tab(page, "Security");
  await expect(page.getByRole("checkbox", { name: /Accept companies from signed identity tokens/ })).toBeChecked({ timeout: 20000 });
});

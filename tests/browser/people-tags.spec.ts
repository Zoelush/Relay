import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * Tags on people (docs/PEOPLE_STEP3.md, phase 01 P1c), end to end in the inbox. Happy path: a
 * customer tagged through the API shows the tag; a teammate tags the customer and their company
 * from the sidebar and takes a tag off. Failure path: a tag archived while the picker shows it is
 * refused in words, and nothing changes.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9234, hostPort: 9235, aiAgent: false });
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

test("a teammate tags a customer and their company from the sidebar; an archived tag is refused", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/developers");
  await expect(page.locator("main")).toBeVisible({ timeout: 20000 });
  const { token } = await ask<{ token: string }>(page, "developer-token", { action: "create", name: "e2e", scopes: ["contacts.personal_data", "conversations.reply", "workspace.manage"] });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(relay.apiOrigin + "/rest" + path, {
      method,
      headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const beta = (await call("POST", "/tags", { name: "Beta tester" })).body;
  const sunset = (await call("POST", "/tags", { name: "Sunset plan" })).body;
  const company = await call("POST", "/companies", { company_id: "stark", name: "Stark Industries" });
  const contact = await call("POST", "/contacts", { email: "pepper@example.test", name: "Pepper Potts" });
  await call("POST", `/contacts/${contact.body.id}/companies`, { company_id: company.body.id });
  expect((await call("POST", `/contacts/${contact.body.id}/tags`, { tag_id: beta.id })).body.tags.map((t: any) => t.name)).toEqual(["Beta tester"]);
  await call("POST", "/conversations", { contact_id: contact.body.id, body: "Can I try the new reports?" });

  await page.goto(relay.hostOrigin + "/agent");
  await page.getByRole("button", { name: /Can I try the new reports\?/ }).first().click();
  const details = page.getByRole("complementary", { name: "Conversation details" });
  const personTags = details.getByRole("group", { name: "Tags on Pepper Potts" });
  const chips = personTags.locator(".pg-tag-chip");
  await expect(chips).toHaveText(["Beta tester×"], { timeout: 20000 });

  // Tagged from the picker, then a tag taken off.
  await personTags.getByRole("button", { name: "+ Tag" }).click();
  await personTags.getByRole("combobox", { name: "Add a tag to Pepper Potts" }).selectOption({ label: "VIP" });
  await expect(chips).toHaveText(["Beta tester×", "VIP×"]);
  await personTags.getByRole("button", { name: "Remove tag Beta tester from Pepper Potts" }).click();
  await expect(chips).toHaveText(["VIP×"]);

  // Their company tagged too.
  const companyTags = details.getByRole("group", { name: "Tags on Stark Industries" });
  await companyTags.getByRole("button", { name: "+ Tag" }).click();
  await companyTags.getByRole("combobox", { name: "Add a tag to Stark Industries" }).selectOption({ label: "Beta tester" });
  await expect(companyTags.locator(".pg-tag-chip")).toHaveText(["Beta tester×"]);
  expect((await call("GET", `/contacts/${contact.body.id}`)).body.tags.map((t: any) => t.name)).toEqual(["VIP"]);
  expect((await call("GET", `/companies/${company.body.id}`)).body.tags.map((t: any) => t.name)).toEqual(["Beta tester"]);

  // A tag archived while the picker shows it: refused in words, and nothing changes.
  await personTags.getByRole("button", { name: "+ Tag" }).click();
  const picker = personTags.getByRole("combobox", { name: "Add a tag to Pepper Potts" });
  await expect(picker.locator("option", { hasText: "Sunset plan" })).toHaveCount(1);
  await ask(page, "tags", { action: "archive", id: sunset.id });
  await picker.selectOption({ label: "Sunset plan" });
  await expect(personTags.getByRole("alert")).toContainText("archived");
  await expect(chips).toHaveText(["VIP×"]);
  expect((await call("GET", `/contacts/${contact.body.id}`)).body.tags.map((t: any) => t.name)).toEqual(["VIP"]);
});

import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";
import { projectJob } from "../../server/analytics";

/**
 * Data requests (phase 16, C5a; docs/SECURITY_STEP7.md), end to end. Happy path: a customer, Ada,
 * asks for her data and then to be forgotten. A manager finds her in Settings › Data requests by
 * email, exports everything (and downloads the zip: person.json with her messages), then deletes
 * her after typing her email, and downloads the signed certificate; searching again finds nobody.
 * Failure path: a wrong confirmation is refused and nothing is deleted; a teammate without
 * security.manage can't reach the page or the API. C5b: the page lists where customer data goes,
 * and the certificate covers every store, every processor and the backup date.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const ADA = { email: "ada.vexley@customer.example", name: "Ada Vexley", text: "Where is my order kumquat-7731?" };
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9164, hostPort: 9165, aiAgent: false });
  const ada = await tenant(relay.db.connect, "demo", (x) => getIdentity(x, "demo", "user", "ada-ext-7731", { name: ADA.name, email: ADA.email }));
  await tenant(relay.db.connect, "demo", (x) =>
    command(x, "demo", { type: "contact", identityId: ada.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: ADA.text } as unknown as Parameters<typeof command>[4]),
  );
  // Her conversation in the reports' store too, so the deletion has it to unlink.
  await projectJob(relay.db.connect, relay.env.analytics!, { workspace_id: "demo", payload: {}, result: null } as never);
});
test.afterAll(async () => {
  await relay?.close();
});

test("a manager exports a customer's data, then deletes her and keeps the certificate", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/data-requests");
  // C5b: where customer data goes outside Relay, and what a deletion does there.
  const processors = page.getByRole("table", { name: "Where customer data goes" });
  await expect(processors.getByRole("row", { name: /^Twilio/ })).toContainText("Deleted by Relay");
  await expect(processors.getByRole("row", { name: /^Anthropic/ })).toContainText("Kept by the provider under its own terms");
  const find = page.getByRole("form", { name: "Find a person" });
  await find.getByLabel("Email, phone, external ID or contact ID").fill(ADA.email);
  await find.getByRole("button", { name: "Find" }).click();
  const person = page.getByRole("region", { name: "Person found" });
  await expect(person).toContainText(ADA.name);
  await expect(person).toContainText("1 conversation");

  // The export: ready to download, a zip with person.json.
  await person.getByRole("button", { name: "Export their data" }).click();
  const requests = page.getByRole("table", { name: "Data requests" });
  const exportRow = requests.getByRole("row", { name: /^Export/ });
  await expect(exportRow).toContainText("Done", { timeout: 20000 });
  const [download] = await Promise.all([page.waitForEvent("download"), exportRow.getByRole("button", { name: "Download export" }).click()]);
  const zip = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  const json = JSON.parse(strFromU8(zip["person.json"])) as { emails: string[]; conversations: { messages: { text: string }[] }[] };
  expect(json.emails).toEqual([ADA.email]);
  expect(json.conversations[0].messages.map((m) => m.text)).toContain(ADA.text);

  // The deletion: confirmed with her email; then the certificate, and she's gone.
  await find.getByLabel("Email, phone, external ID or contact ID").fill(ADA.email);
  await find.getByRole("button", { name: "Find" }).click();
  await person.getByRole("button", { name: "Delete everything about them…" }).click();
  const confirm = page.getByRole("form", { name: "Confirm deletion" });
  await confirm.getByLabel("To confirm, type their email address, or the word delete").fill(ADA.email);
  await confirm.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Deletion started." })).toBeVisible();
  const deletion = requests.getByRole("row", { name: /^Deletion/ });
  await expect(deletion).toContainText("Done", { timeout: 20000 });
  await expect(deletion).toContainText("Deleted person");
  await expect(exportRow).toContainText("No longer named");
  await expect(exportRow.getByRole("button", { name: "Download export" })).toHaveCount(0);
  const [cert] = await Promise.all([page.waitForEvent("download"), deletion.getByRole("button", { name: "Download certificate" }).click()]);
  const certificate = JSON.parse(await readFile((await cert.path())!, "utf8")) as {
    kind: string;
    signature: { algorithm: string; value: string };
    stores: { postgresql: Record<string, number>; analyticalStore: Record<string, number>; embeddings: string };
    processors: { id: string }[];
    backups: { windowDays: number; clearBy: string };
    notYetCovered?: unknown;
  };
  expect(certificate.stores.analyticalStore.a_conversations).toBe(1);
  expect(certificate.stores.embeddings).toContain("no customer data");
  expect(certificate.processors.map((p) => p.id)).toContain("twilio");
  expect(certificate.backups.windowDays).toBe(7);
  expect(certificate.notYetCovered).toBeUndefined();
  expect(certificate.kind).toBe("relay-deletion-certificate/1");
  expect(certificate.signature.algorithm).toBe("HMAC-SHA-256");
  expect(certificate.stores.postgresql.conversations).toBe(1);
  expect(JSON.stringify(certificate)).not.toContain(ADA.email);
  await find.getByLabel("Email, phone, external ID or contact ID").fill(ADA.email);
  await find.getByRole("button", { name: "Find" }).click();
  await expect(page.getByRole("alert")).toHaveText("Nobody here matches that.");
});

test("a wrong confirmation deletes nothing; a teammate without the permission can't reach data requests", async ({ page, browser, request }) => {
  const bob = await tenant(relay.db.connect, "demo", (x) => getIdentity(x, "demo", "user", "bob-ext-1", { name: "Bob Keeps", email: "bob@customer.example" }));
  expect(bob.identityId).toBeTruthy();
  await page.goto(relay.hostOrigin + "/agent#settings/data-requests");
  const find = page.getByRole("form", { name: "Find a person" });
  await find.getByLabel("Email, phone, external ID or contact ID").fill("bob@customer.example");
  await find.getByRole("button", { name: "Find" }).click();
  await page.getByRole("region", { name: "Person found" }).getByRole("button", { name: "Delete everything about them…" }).click();
  const confirm = page.getByRole("form", { name: "Confirm deletion" });
  await confirm.getByLabel("To confirm, type their email address, or the word delete").fill("someone@else.example");
  await confirm.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("alert")).toHaveText("Type their email address, or the word delete, to confirm.");
  await find.getByLabel("Email, phone, external ID or contact ID").fill("bob@customer.example");
  await find.getByRole("button", { name: "Find" }).click();
  await expect(page.getByRole("region", { name: "Person found" })).toContainText("Bob Keeps");

  // Grace (an agent) doesn't see the page, and the API refuses her.
  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 15000 });
  await expect(grace.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Data requests" })).toHaveCount(0);
  const refused = await grace.evaluate(async () => (await fetch("/api/agent/data-requests", { credentials: "same-origin" })).status);
  expect(refused).toBe(403);
  expect(request).toBeTruthy();
});

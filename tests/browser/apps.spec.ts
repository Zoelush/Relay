import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * OAuth apps (phase 15, D4; docs/DEVELOPER_PLATFORM_STEP4.md), end to end, with an "app" on this
 * machine receiving the redirect: an app registered in Settings › Developers › Apps; its consent
 * screen names it and says in plain words what it asks; allowed, its code becomes tokens that call
 * the API; removed in Settings, its token stops. Cancelled, the app is told `access_denied`; an
 * unregistered redirect is refused on the page, never followed.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let callback: Server;
let port = 0;
const arrived: URL[] = [];
test.use({ viewport: { width: 1280, height: 1000 } });
test.beforeAll(async () => {
  callback = createServer((req, res) => {
    arrived.push(new URL(req.url!, `http://127.0.0.1:${port}`));
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Back at the app.");
  });
  await new Promise<void>((r) => callback.listen(0, "127.0.0.1", r));
  port = (callback.address() as { port: number }).port;
  relay = await startLocalRelay({ apiPort: 9070, hostPort: 9071, inboxViews: true, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
  callback?.close();
});

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
let credentials: { clientId: string; clientSecret: string } | null = null;
async function register(page: Page) {
  if (credentials) return credentials;
  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  const form = page.locator("section", { hasText: "Register an app" }).last();
  await form.getByLabel("Name").fill("Order Sync");
  await form.getByLabel("Description").fill("Shows orders beside conversations.");
  await form.getByLabel("Redirect addresses (one per line)").fill(`http://127.0.0.1:${port}/cb`);
  await form.getByRole("checkbox", { name: "conversations.read" }).check();
  await form.getByRole("button", { name: "Register app" }).click();
  await expect(page.getByLabel("Client secret")).toContainText("relay_cs_", { timeout: 15000 });
  credentials = { clientId: (await page.getByLabel("Client id").textContent())!.trim(), clientSecret: (await page.getByLabel("Client secret").textContent())!.trim() };
  return credentials;
}
async function authorizeUrl(clientId: string, redirect = `http://127.0.0.1:${port}/cb`) {
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "conversations.read", state: "s-123", code_challenge: challenge, code_challenge_method: "S256" });
  return relay.hostOrigin + "/oauth/authorize?" + q.toString();
}

test("an app registered in Settings is allowed in, calls the API, and stops when removed", async ({ page, request }) => {
  const app = await register(page);
  await page.goto(await authorizeUrl(app.clientId));
  const card = page.getByRole("region", { name: "Install an app" });
  await expect(card.getByRole("heading", { level: 1 })).toContainText("Order Sync wants to connect to");
  await expect(card).toContainText("See conversations");
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("Back at the app.")).toBeVisible({ timeout: 15000 });
  const back = arrived.at(-1)!;
  expect(back.searchParams.get("state")).toBe("s-123");
  const code = back.searchParams.get("code")!;
  expect(code).toMatch(/^relay_code_/);

  const exchanged = await request.post(relay.apiOrigin + "/oauth/token", {
    form: { grant_type: "authorization_code", code, redirect_uri: `http://127.0.0.1:${port}/cb`, code_verifier: verifier, client_id: app.clientId, client_secret: app.clientSecret },
  });
  expect(exchanged.status()).toBe(200);
  const tokens = await exchanged.json();
  expect(tokens.scope).toBe("conversations.read");
  const me = await request.get(relay.apiOrigin + "/rest/me", { headers: { authorization: "Bearer " + tokens.access_token } });
  expect(me.status()).toBe(200);
  expect((await me.json()).scopes).toEqual(["conversations.read"]);

  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  const installed = page.getByRole("table", { name: "Installed apps" }).getByRole("row", { name: /Order Sync/ });
  await expect(installed).toContainText("See conversations");
  await installed.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No apps are installed.")).toBeVisible();
  expect((await request.get(relay.apiOrigin + "/rest/me", { headers: { authorization: "Bearer " + tokens.access_token } })).status()).toBe(401);
});

test("cancelled, the app is told access_denied; an unregistered redirect is refused on the page", async ({ page }) => {
  const app = await register(page);
  await page.goto(await authorizeUrl(app.clientId));
  await page.getByRole("region", { name: "Install an app" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Back at the app.")).toBeVisible({ timeout: 15000 });
  expect(arrived.at(-1)!.searchParams.get("error")).toBe("access_denied");

  const before = arrived.length;
  await page.goto(await authorizeUrl(app.clientId, "https://evil.example/steal"));
  const card = page.getByRole("region", { name: "Install an app" });
  await expect(card).toContainText("This app can’t be connected");
  await expect(card.getByRole("alert")).toContainText("didn't register that redirect");
  await expect(card.getByRole("button", { name: "Allow" })).toHaveCount(0);
  expect(arrived.length).toBe(before);
  expect(page.url()).toContain(relay.hostOrigin);
});

/**
 * T3a (docs/TEST_WORKSPACE_STEP5.md): an app's versions. Failure path: a redirect added to the
 * draft isn't one anybody may use until the draft is published. Happy path: published as version
 * 2, a version that asks for more waits on the installation, named, until a manager approves it.
 */
test("a draft changes nothing until published; a version that asks for more waits for approval", async ({ page, request }) => {
  // Registered from the page's own session, so it's this workspace's app: version 1, in development.
  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  await expect(page.getByRole("heading", { name: "Your apps" })).toBeVisible({ timeout: 20000 });
  const made = await page.evaluate(
    async (cb) =>
      (await (
        await fetch("/api/agent/developer-app", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ action: "create", name: "Ticket Mirror", redirectUris: [cb], scopes: ["conversations.read"] }),
        })
      ).json()) as { id: string; clientId: string; clientSecret: string },
    `http://127.0.0.1:${port}/cb`,
  );
  await page.reload();
  const mine = page.getByRole("listitem", { name: "Ticket Mirror" });
  await expect(mine).toContainText("In development", { timeout: 20000 });
  await expect(mine.getByRole("list", { name: "Ticket Mirror versions" })).toContainText("Version 1");

  // Installed here (the developer's own workspace is its sandbox), as version 1.
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const consent = (redirect: string) =>
    relay.hostOrigin +
    "/oauth/authorize?" +
    new URLSearchParams({ response_type: "code", client_id: made.clientId, redirect_uri: redirect, state: "v", code_challenge: challenge, code_challenge_method: "S256" }).toString();
  await page.goto(consent(`http://127.0.0.1:${port}/cb`));
  await page.getByRole("region", { name: "Install an app" }).getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("Back at the app.")).toBeVisible({ timeout: 15000 });
  const code = arrived.at(-1)!.searchParams.get("code")!;
  expect(
    (
      await request.post(relay.apiOrigin + "/oauth/token", {
        form: { grant_type: "authorization_code", code, redirect_uri: `http://127.0.0.1:${port}/cb`, code_verifier: verifier, client_id: made.clientId, client_secret: made.clientSecret },
      })
    ).status(),
  ).toBe(200);

  // The draft gains a redirect and a permission: nobody runs a draft, so the new redirect is refused.
  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  await page.evaluate(
    async ([id, cb]) =>
      fetch("/api/agent/developer-app", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ action: "update", id, redirectUris: [cb, cb + "/two"], scopes: ["conversations.read", "conversations.reply"] }),
      }),
    [made.id, `http://127.0.0.1:${port}/cb`],
  );
  await page.goto(consent(`http://127.0.0.1:${port}/cb/two`));
  await expect(page.getByRole("region", { name: "Install an app" }).getByRole("alert")).toContainText("didn't register that redirect");

  // Published from the page: version 2 asks for more, so the installation waits, the new permission named.
  await page.goto(relay.hostOrigin + "/agent#settings/apps");
  const app = page.getByRole("listitem", { name: "Ticket Mirror" });
  await app.getByRole("textbox", { name: "What changed in Ticket Mirror" }).fill("Replies too.");
  await app.getByRole("button", { name: "Publish the draft as version 2" }).click();
  await expect(app.getByRole("list", { name: "Ticket Mirror versions" })).toContainText("Replies too.", { timeout: 15000 });
  const row = page.getByRole("table", { name: "Installed apps" }).getByRole("row", { name: /Ticket Mirror/ });
  await expect(row).toContainText("Version 1");
  await expect(row.getByRole("note")).toContainText("Version 2 also asks to");
  await row.getByRole("button", { name: "Approve version 2" }).click();
  await expect(row).toContainText("Version 2", { timeout: 15000 });
  await expect(row.getByRole("note")).toHaveCount(0);
});

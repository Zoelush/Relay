import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";
import { mkdir } from "node:fs/promises";
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8898, hostPort: 8899 });
});
test.afterAll(async () => {
  await relay?.close();
});

test("agent inbox receives live customer messages, replays after disconnect, and keeps notes private", async ({
  browser,
}) => {
  const agentContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const agent = await agentContext.newPage();
  const customer = await customerContext.newPage();
  const agentRequests: string[] = [];
  const agentFrames: string[] = [];
  agent.on("request", (r) => agentRequests.push(r.url()));
  agent.on("websocket", (ws) =>
    ws.on("framereceived", (e) => agentFrames.push(String(e.payload))),
  );
  try {
    await agent.goto(relay.hostOrigin + "/agent");
    await expect(agent.getByRole("status")).toHaveText("● Live");
    await expect(agent.getByTestId("storage-source")).toHaveText(
      "PostgreSQL · local",
    );
    await customer.goto(relay.hostOrigin);
    await expect(customer.locator("relay-launcher")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await customer
      .getByRole("button", { name: "Open support", exact: true })
      .click();
    await expect
      .poll(
        () =>
          !!customer
            .frames()
            .find((f) => f.url().includes("/messenger/frame.html")),
      )
      .toBe(true);
    const widget = customer
      .frames()
      .find((f) => f.url().includes("/messenger/frame.html"))!;
    await widget.getByRole("button", { name: "Start a conversation" }).click();
    await widget
      .getByRole("textbox", { name: "Write your message" })
      .fill("Live from the customer widget");
    await widget.getByRole("button", { name: "Send message" }).click();
    await expect(
      agent.getByRole("button", { name: /Live from the customer widget/ }),
    ).toBeVisible();
    await agent
      .getByRole("button", { name: /Live from the customer widget/ })
      .click();
    await expect(
      agent
        .locator("[data-part-id]")
        .filter({ hasText: "Live from the customer widget" }),
    ).toHaveCount(1);
    await agent
      .getByRole("textbox", { name: "Reply message" })
      .fill("A live teammate reply");
    await agent
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await expect(
      widget.locator(".message").filter({ hasText: "A live teammate reply" }),
    ).toHaveCount(1);
    await agent
      .getByRole("button", { name: "Internal note", exact: true })
      .click();
    await agent
      .getByRole("textbox", { name: "Internal note", exact: true })
      .fill("Private account-review note");
    await agent.getByRole("button", { name: "Add internal note" }).click();
    await expect(
      agent
        .locator("[data-part-id].pg-note")
        .filter({ hasText: "Private account-review note" }),
    ).toHaveCount(1);
    const data = await tenant(
      relay.db.connect,
      "demo",
      async (db) =>
        (
          await db.query<{ id: string }>(
            "SELECT id FROM conversations WHERE workspace_id=$1 AND title=$2",
            ["demo", "Live from the customer widget"],
          )
        ).rows[0],
    );
    const id = data.id;
    relay.disconnect(id);
    await relay.agent({
      action: "reply",
      conversationId: id,
      text: "Reply committed during reconnect",
    });
    await expect(
      agent
        .locator("[data-part-id]")
        .filter({ hasText: "Reply committed during reconnect" }),
    ).toHaveCount(1);
    await expect(
      widget
        .locator(".message")
        .filter({ hasText: "Reply committed during reconnect" }),
    ).toHaveCount(1);
    await expect(
      widget.getByText("Private account-review note", { exact: true }),
    ).toHaveCount(0);
    expect(agentFrames.some((raw) => raw.includes('"cursor"'))).toBe(true);
    const response = await agentContext.request.get(
      relay.hostOrigin + "/api/agent/inbox",
    );
    expect(response.headers()["x-relay-storage"]).toBe("postgresql");
    expect(response.headers()["x-relay-transport"]).toBe("local-pglite");
    expect(
      agentRequests.some((url) => new URL(url).pathname === "/api/inbox"),
    ).toBe(false);
    expect(
      (
        await customerContext.request.get(relay.hostOrigin + "/api/agent/inbox")
      ).status(),
    ).toBe(401);
    // No recurring HTTP list polling while idle; WebSocket heartbeat is permitted.
    const count = agentRequests.filter(
      (url) => new URL(url).pathname === "/api/agent/inbox",
    ).length;
    await agent.waitForTimeout(2400);
    const settled = agentRequests.filter(
      (url) => new URL(url).pathname === "/api/agent/inbox",
    ).length;
    await agent.waitForTimeout(2400);
    expect(
      agentRequests.filter(
        (url) => new URL(url).pathname === "/api/agent/inbox",
      ).length,
    ).toBe(settled);
    expect(settled - count).toBeLessThanOrEqual(1);
    await mkdir("work/screenshots", { recursive: true });
    await agent.screenshot({
      path: "work/screenshots/agent-inbox.png",
      fullPage: true,
    });
  } finally {
    await agentContext.close();
    await customerContext.close();
  }
});

test("rejected optimistic note restores the draft and removes its pending row", async ({
  page,
}) => {
  // Own fixture: this test must also pass alone or after a worker restart.
  await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(
      db,
      "demo",
      "anonymous",
      "rejection-test-device",
    );
    await command(
      db,
      "demo",
      {
        type: "contact",
        identityId: identity.identityId,
        brandId: "default",
      },
      "rejection-test-start",
      { action: "start", text: "Optimistic rejection fixture" },
    );
  });
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status")).toHaveText("● Live");
  await page
    .getByRole("button", { name: /Optimistic rejection fixture/ })
    .click();
  await page
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  await page.route("**/api/agent/command", async (route) => {
    if (route.request().postDataJSON().action === "note") {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "CONFLICT",
            message: "The note was rejected for this test.",
          },
        }),
      });
    } else await route.continue();
  });
  await page
    .getByRole("textbox", { name: "Internal note", exact: true })
    .fill("Keep this unsent draft");
  await page.getByRole("button", { name: "Add internal note" }).click();
  await expect(page.locator(".pg-pending")).toContainText(
    "Keep this unsent draft",
  );
  await expect(page.getByRole("alert")).toContainText("The note was rejected");
  await expect(page.locator(".pg-pending")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Internal note", exact: true }),
  ).toHaveText("Keep this unsent draft"); // a rich editor, so text rather than value
  const rows = await tenant(relay.db.connect, "demo", (db) =>
    db.query(
      "SELECT id FROM conversation_parts WHERE workspace_id=$1 AND body=$2",
      ["demo", "Keep this unsent draft"],
    ),
  );
  expect(rows.rows).toHaveLength(0);
});

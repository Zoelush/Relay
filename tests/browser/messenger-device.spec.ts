import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * A shared browser: Ada is signed in on the site, then Grace signs in on the same browser without
 * Ada logging out. The messenger boots for Grace (it used to fail with a 409) and shows none of
 * Ada's conversations.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9060, hostPort: 9061, inboxViews: true, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});

test("a browser that switches signed-in customers boots the messenger for the new one, apart from the old", async ({ page }) => {
  const frame = async () => {
    await expect.poll(() => page.frames().some((f) => f.url().includes("/messenger/frame.html")), { timeout: 15000 }).toBe(true);
    return page.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  };
  await page.goto(relay.hostOrigin + "/?user=ada");
  await expect(page.locator("[data-launcher]")).toHaveCount(1, { timeout: 15000 });
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  const ada = await frame();
  await ada.getByRole("button", { name: "Start a conversation" }).click();
  await ada.getByRole("textbox", { name: "Write your message" }).fill("Ada's private question");
  await ada.getByRole("button", { name: "Send message" }).click();
  await expect(ada.getByRole("log", { name: "Messages" }).getByText("Ada's private question")).toBeVisible();

  const boots: number[] = [];
  page.on("response", (r) => r.url().endsWith("/v1/messenger/boot") && boots.push(r.status()));
  await page.goto(relay.hostOrigin + "/?user=grace");
  await expect(page.locator("[data-launcher]")).toHaveCount(1, { timeout: 15000 });
  expect(boots).toEqual([200]);
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  const grace = await frame();
  await grace.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(grace.getByText("Ada's private question")).toHaveCount(0);
});

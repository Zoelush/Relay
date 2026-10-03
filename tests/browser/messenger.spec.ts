import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let directory: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "relay-browser-"));
  // The AI agent (phase 08) is off: these tests count the messenger's messages exactly.
  relay = await startLocalRelay({
    apiPort: 8798,
    hostPort: 8799,
    directory,
    aiAgent: false,
  });
});
test.afterAll(async () => {
  await relay?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("hostile CSS and strict CSP: lazy frame, message, reply, keyboard, no host shift", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(relay.hostOrigin);
  await expect(page.locator("relay-launcher")).toHaveAttribute(
    "data-ready",
    "true",
  );
  expect(requests.some((x) => /frame\.(js|html)/.test(x))).toBe(false);
  const anchor = await page.locator("#anchor").boundingBox();
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  // The launcher deliberately uses a closed shadow root; locate the frame by its URL instead.
  await expect
    .poll(
      () =>
        page.frames().find((f) => f.url().includes("/messenger/frame.html")) !==
        undefined,
    )
    .toBe(true);
  const frame = page
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  await expect(
    frame.getByRole("heading", { name: "How can we help?" }),
  ).toBeVisible();
  const csp: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) csp.push(m.text());
  });
  expect(
    await frame
      .locator("header")
      .evaluate((el) => getComputedStyle(el).borderRadius),
  ).toBe("0px");
  expect(
    await frame
      .getByRole("button", { name: "Start a conversation" })
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(8, 122, 87)");
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame
    .getByRole("textbox", { name: "Write your message" })
    .fill("Hello from the hostile host");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect(
    frame
      .locator(".message")
      .filter({ hasText: "Hello from the hostile host" }),
  ).toHaveCount(1);
  const inbox = (await (await relay.agent()).json()) as any;
  const id = inbox.conversations.find(
    (c: any) => c.title === "Hello from the hostile host",
  ).id;
  expect(
    (
      await relay.agent({
        action: "note",
        conversationId: id,
        text: "INTERNAL DO NOT EXPOSE",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await relay.agent({
        action: "reply",
        conversationId: id,
        text: "A real reply from the support side",
      })
    ).status,
  ).toBe(200);
  await expect(
    frame.getByText("A real reply from the support side", { exact: true }),
  ).toBeVisible();
  await expect(frame.getByText("INTERNAL DO NOT EXPOSE")).toHaveCount(0);
  await expect
    .poll(async () => await frame.locator(".message").count())
    .toBe(2);
  expect(await page.locator("#anchor").boundingBox()).toEqual(anchor);
  expect(await page.evaluate(() => (window as any).relayViolations)).toEqual(
    [],
  );
  expect(csp).toEqual([]);
  await frame.getByRole("textbox", { name: "Write your message" }).focus();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open support", exact: true }),
  ).toBeFocused();
  await mkdir("work/screenshots", { recursive: true });
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect(
    frame.getByText("A real reply from the support side", { exact: true }),
  ).toBeVisible();
  await frame.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({ path: "work/screenshots/messenger-hostile.png" });
  // Background subscriptions must not acknowledge replies while the customer is on Home.
  await frame.getByRole("button", { name: "Home", exact: true }).click();
  await relay.agent({
    action: "reply",
    conversationId: id,
    text: "Unread while viewing Home",
  });
  const unreadThread = frame.getByRole("button", {
    name: /Hello from the hostile host.*Unread/,
  });
  await expect(unreadThread).toBeVisible();
  await unreadThread.click();
  await expect(
    frame.getByText("Unread while viewing Home", { exact: true }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Home", exact: true }).click();
  await expect(unreadThread).toHaveCount(0);
  // Tab into the closed-shadow launcher and verify Escape restores the same control.
  await frame.getByRole("button", { name: "Close support" }).click();
  await expect(
    page.getByRole("button", { name: "Open support", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("link", { name: "Open the local agent inbox" })
    .focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    "RELAY-LAUNCHER",
  );
  await page.keyboard.press("Enter");
  await expect(
    frame.getByRole("heading", { name: "How can we help?" }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Close support" }).focus();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => frame.evaluate(() => document.hasFocus()))
    .toBe(false);
  await page.keyboard.press("Enter");
  await expect(
    frame.getByRole("heading", { name: "How can we help?" }),
  ).toBeVisible();
});

test("60-second disconnect and server restart replay the exact timeline without duplicates", async ({
  page,
  context,
}) => {
  await page.goto(relay.hostOrigin);
  await expect(page.locator("relay-launcher")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(() => page.frames().some((f) => f.url().includes("frame.html")))
    .toBe(true);
  const frame = page.frames().find((f) => f.url().includes("frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame
    .getByRole("textbox", { name: "Write your message" })
    .fill("Reconnect acceptance");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect(
    frame.getByText("Reconnect acceptance", { exact: true }).last(),
  ).toBeVisible();
  const inbox = (await (await relay.agent()).json()) as any,
    id = inbox.conversations.find(
      (c: any) => c.title === "Reconnect acceptance",
    ).id;
  // Abort transport for a full minute; server writes continue throughout the outage.
  const disconnectedAt = Date.now();
  await context.setOffline(true);
  relay.disconnect(id);
  await relay.close();
  relay = await startLocalRelay({ apiPort: 8798, hostPort: 8799, directory });
  for (let i = 0; i < 3; i++)
    await relay.agent({
      action: "reply",
      conversationId: id,
      text: "Offline reply " + i,
    });
  await expect(frame.getByText("Offline reply 0", { exact: true })).toHaveCount(
    0,
  );
  await new Promise((r) =>
    setTimeout(r, Math.max(0, 60000 - (Date.now() - disconnectedAt))),
  );
  await context.setOffline(false);
  await expect(frame.getByText("Offline reply 2", { exact: true })).toBeVisible(
    { timeout: 35000 },
  );
  const server = (await (
    await relay.agent(undefined, "demo", "?conversation=" + id)
  ).json()) as any;
  const expected = server.parts
    .filter((p: any) => p.audience === "public")
    .map((p: any) => p.id);
  const actual = await frame
    .locator("[data-part-id]")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-part-id")));
  expect(actual).toEqual(expected);
  expect(new Set(actual).size).toBe(actual.length);
});

test("RTL locale and forged identity fail without exposing history", async ({
  page,
  request,
}) => {
  await page.goto(relay.hostOrigin + "/?locale=ar-EG");
  await expect(page.locator("relay-launcher")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(() => page.frames().some((f) => f.url().includes("frame.html")))
    .toBe(true);
  const frame = page.frames().find((f) => f.url().includes("frame.html"))!;
  await expect(frame.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    frame.getByRole("heading", { name: "كيف يمكننا مساعدتك؟" }),
  ).toBeVisible();
  const response = await request.post(relay.apiOrigin + "/v1/messenger/boot", {
    headers: {
      Origin: relay.hostOrigin,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      workspaceId: "demo",
      brandId: "default",
      pageUrl: relay.hostOrigin,
      deviceToken: crypto.randomUUID(),
      user: {
        userId: "victim",
        email: "victim@example.com",
        jwt: "forged.token.signature",
      },
    },
  });
  expect(response.status()).toBe(401);
});

test("cold browser host-load measurement and CLS", async ({ browser }) => {
  const samples: {
    baseline: number;
    widget: number;
    delta: number;
    cls: number;
    loadHandlerMs: number;
    bootAfterLoadMs: number;
  }[] = [];
  for (let i = 0; i < 20; i++) {
    const pair = {
      baseline: 0,
      widget: 0,
      cls: 0,
      loadHandlerMs: 0,
      bootAfterLoadMs: 0,
    };
    for (const enabled of i % 2 ? [true, false] : [false, true]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(() => {
        (window as any).relayCls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as any)
            if (!e.hadRecentInput) (window as any).relayCls += e.value;
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(relay.hostOrigin + (enabled ? "" : "/?baseline=1"), {
        waitUntil: "load",
      });
      const duration = await page.evaluate(
        () => performance.getEntriesByType("navigation")[0].duration,
      );
      if (enabled) {
        await expect(page.locator("relay-launcher")).toHaveAttribute(
          "data-ready",
          "true",
        );
        pair.widget = duration;
        pair.cls = await page.evaluate(() => (window as any).relayCls);
        const timing = await page.evaluate(() => {
          const navigation = performance.getEntriesByType(
            "navigation",
          )[0] as PerformanceNavigationTiming;
          const boot = performance
            .getEntriesByType("resource")
            .find((r) => r.name.endsWith("/v1/messenger/boot"));
          return {
            loadHandlerMs: navigation.loadEventEnd - navigation.loadEventStart,
            bootAfterLoadMs: boot
              ? boot.startTime - navigation.loadEventEnd
              : null,
          };
        });
        expect(timing.bootAfterLoadMs).not.toBeNull();
        expect(timing.bootAfterLoadMs!).toBeGreaterThanOrEqual(0);
        pair.loadHandlerMs = timing.loadHandlerMs;
        pair.bootAfterLoadMs = timing.bootAfterLoadMs!;
      } else pair.baseline = duration;
      await context.close();
    }
    samples.push({ ...pair, delta: pair.widget - pair.baseline });
  }
  const sorted = samples.map((x) => x.delta).sort((a, b) => a - b),
    result = {
      environment:
        "Local loopback Chromium; new browser context each run; 20 alternating baseline/widget pairs. Includes async launcher boot; iframe unopened.",
      samples,
      p50DeltaMs: sorted[9],
      p95DeltaMs: sorted[18],
      maxCls: Math.max(...samples.map((x) => x.cls)),
    };
  await mkdir("work/benchmarks", { recursive: true });
  await writeFile(
    "work/benchmarks/host-load.json",
    JSON.stringify(result, null, 2),
  );
  expect(result.maxCls).toBe(0);
  expect(result.p95DeltaMs).toBeLessThan(50);
});

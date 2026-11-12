import test from "node:test";
import assert from "node:assert/strict";
import { brandColors, readBrand, runBrandImport } from "../server/help-brand";
import type { Job } from "../server/jobs";

/**
 * "Import your brand" (docs/HELP_CENTER_DESIGN.md): a website's colours and name read from its
 * own page and stylesheets, and nothing else. The job never reaches the network here.
 */
const page = `<!doctype html><html><head>
<title>Acme Tools | Shop</title>
<meta name="theme-color" content="#1f6feb">
<link rel="stylesheet" href="/styles/site.css">
<link rel="stylesheet" href="https://fonts.example.com/other.css">
<style>a{color:#1f6feb}</style>
</head><body><p style="color:#111827">Hello</p></body></html>`;
const sheet = `:root{--brand:#1f6feb;--accent:rgb(217, 70, 239)}
.btn{background:#1f6feb;color:#fff}.tag{background:#D946EF}
.muted{color:#6b7280}.page{background:#ffffff}`;

test("brand colours: the brand's own, never greys, white or near-black", () => {
  const found = brandColors(page + sheet);
  assert.deepEqual(found.slice(0, 2), ["#1f6feb", "#d946ef"]);
  for (const grey of ["#ffffff", "#111827", "#6b7280", "#fff"])
    assert(!found.includes(grey), grey);
  // rgb() counts too, and nonsense channels are left alone.
  assert.deepEqual(brandColors("rgb(300, 70, 239)"), []);
  assert.deepEqual(brandColors("rgba(217, 70, 239, .5)"), ["#d946ef"]);
  assert.deepEqual(brandColors("no colours here"), []);
});

test("what a page suggests: the stated colour, a second for the hero, and the site's name", () => {
  const brand = readBrand(page, "https://shop.example.com/help", sheet);
  assert.equal(brand.site, "https://shop.example.com");
  assert.equal(brand.name, "Acme Tools", "the part before the separator");
  assert.equal(brand.actionColor, "#1f6feb");
  assert.deepEqual(brand.heroColors, ["#1f6feb", "#d946ef"]);
  assert.equal(brand.heroText, "#ffffff", "white reads on that blue");
  assert.equal(brand.bodyBackground, "#f6f7f8");
  // og:site_name wins over the title; a page that states nothing falls back to its host.
  assert.equal(
    readBrand('<meta property="og:site_name" content="Acme Inc">' + page, "https://shop.example.com/").name,
    "Acme Inc",
  );
  assert.equal(readBrand("<html></html>", "https://www.plain.test/").name, "plain.test");
  // A stated theme colour that is a near-white page background is not the brand's.
  const pale = readBrand('<meta name="theme-color" content="#fafafa"><style>.b{background:#7a0ba5}</style>', "https://pale.test/");
  assert.equal(pale.actionColor, "#7a0ba5");
  // Nothing to go on: Relay's own green, so the help center still looks finished.
  assert.equal(readBrand("<html></html>", "https://plain.test/").actionColor, "#087a57");
});

test("the import job: the page and its own stylesheets, and a refusal a teammate can read", async () => {
  const asked: string[] = [];
  const policy = {
    fetch: (async (url: string | URL | Request) => {
      const address = String(url);
      asked.push(address);
      if (address.endsWith("/styles/site.css")) return new Response(sheet, { status: 200 });
      if (address.includes("fonts.example.com")) throw new Error("not reached");
      return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch,
  };
  const job = (url: string) => ({ workspace_id: "a", payload: { url } }) as unknown as Job;
  const done = await runBrandImport(policy, job("https://shop.example.com/"));
  assert.equal(done.done, true);
  const brand = done.result.brand as { actionColor: string; heroColors: string[] };
  assert.equal(brand.actionColor, "#1f6feb");
  assert.deepEqual(brand.heroColors, ["#1f6feb", "#d946ef"]);
  assert.deepEqual(
    asked,
    ["https://shop.example.com/", "https://shop.example.com/styles/site.css"],
    "the page and its own stylesheet only: another host's is never fetched",
  );
  // Addresses a teammate can't be allowed to reach, told as something they can act on.
  for (const address of ["http://shop.example.com/", "https://localhost/", "https://192.168.0.1/"])
    assert.equal(
      (await runBrandImport(policy, job(address))).result.refused,
      "That isn't a public website address.",
      address,
    );
  const empty = await runBrandImport(
    { fetch: (async () => new Response("", { status: 404 })) as typeof fetch },
    job("https://gone.example.com/"),
  );
  assert.equal(empty.result.refused, "That website didn't give us a page to read.");
  const broken = await runBrandImport(
    { fetch: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch },
    job("https://broken.example.com/"),
  );
  assert.equal(broken.result.refused, "That website couldn't be reached.");
});

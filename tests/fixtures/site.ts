import { createServer, type Server } from "node:http";

/**
 * A small website for website-sync tests (phase 07, C1b), served on 127.0.0.1. Routes can be
 * changed between runs: a page edited, removed (404), or a robots.txt that errors.
 */
export type Route = {
  status?: number;
  type?: string;
  body?: string;
  headers?: Record<string, string>;
};
export async function testSite(port = 0) {
  const routes = new Map<string, Route>();
  const hits: string[] = [];
  /** Paths answered "304 Not Modified" (a conditional request matched). */
  const notModified: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    const r = routes.get(path);
    if (!r) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const etag = r.headers?.etag;
    if (etag && req.headers["if-none-match"] === etag) {
      notModified.push(path);
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(r.status ?? 200, {
      "content-type": r.type ?? "text/html; charset=utf-8",
      ...r.headers,
    });
    res.end(r.body ?? "");
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const address = server.address();
  const host = `127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
  const origin = `http://${host}`;
  return {
    host,
    origin,
    routes,
    hits,
    notModified,
    page(path: string, title: string, body: string, extra: Route = {}) {
      routes.set(path, {
        body: `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`,
        ...extra,
      });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type TestSite = Awaited<ReturnType<typeof testSite>>;

/** The standard site: home linking to two pages, a sitemap-only page, and pages that are skipped. */
export function standardSite(site: TestSite) {
  site.routes.set("/robots.txt", {
    type: "text/plain",
    body: `User-agent: *\nDisallow: /private\n\nSitemap: ${site.origin}/sitemap.xml\n`,
  });
  site.routes.set("/sitemap.xml", {
    type: "application/xml",
    body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${site.origin}/only-in-sitemap</loc></url></urlset>`,
  });
  site.page(
    "/",
    "Help home",
    `<nav>Menu Pricing Login</nav><div class="cookie-banner">We use cookies</div>
    <h1>Help</h1><p>Welcome to the help site.</p>
    <a href="/shipping?utm_source=nav#top">Shipping</a> <a href="/returns">Returns</a>
    <a href="/private/staff">Staff</a> <a href="/blog/news">News</a> <a href="/quiet">Quiet</a>
    <a href="/guide.pdf">Guide</a> <a href="https://elsewhere.example/page">Elsewhere</a>`,
  );
  site.page(
    "/shipping",
    "Shipping times",
    "<p>Orders ship within two working days by wombat courier.</p>",
    { headers: { etag: '"ship-1"' } },
  );
  site.page(
    "/returns",
    "Returns",
    "<p>Return unused items within 30 days for a full refund.</p>",
  );
  site.page(
    "/only-in-sitemap",
    "Warranty",
    "<p>Every device has a two-year platypus warranty.</p>",
  );
  site.page("/private/staff", "Staff", "<p>Staff only rota.</p>");
  site.page("/blog/news", "News", "<p>Company news.</p>");
  // noindex through the robots meta tag.
  site.routes.set("/quiet", {
    body: '<!doctype html><html><head><title>Quiet</title><meta name="robots" content="noindex"></head><body><p>Do not index me.</p></body></html>',
  });
}

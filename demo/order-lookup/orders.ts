/**
 * The demo order service for the order-lookup example app (phase 15, step D5;
 * docs/DEVELOPER_PLATFORM_STEP5.md): a stand-in for a shop's own system, with two shops. Every
 * email has a few orders, made up from the address so they're the same each time (an address
 * containing "noorders" has none). It answers JSON over HTTP, as a real order system would.
 *
 *   GET /orders?shop=uk&email=ada@example.test   the customer's orders, newest first
 */
export type Order = {
  number: string;
  email: string;
  placedAt: string;
  status: "processing" | "shipped" | "delivered" | "refunded";
  total: string;
  items: string[];
  carrier: string | null;
  tracking: string | null;
  estimatedDelivery: string | null;
};
export const SHOPS = {
  uk: { name: "Acme UK", currency: "£", carrier: "Royal Mail" },
  us: { name: "Acme US", currency: "$", carrier: "UPS" },
} as const;
export type Shop = keyof typeof SHOPS;

const PRODUCTS = ["Linen shirt", "Canvas tote", "Merino socks (3 pairs)", "Rain jacket", "Leather belt", "Wool beanie", "Chino trousers"];
function seed(text: string) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) % 10_000) / 10_000;
}
const day = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** A customer's orders in a shop, newest first: made up from their address, the same every time. */
export function ordersFor(shop: Shop, email: string, today = new Date("2026-10-20T12:00:00Z")): Order[] {
  const address = email.trim().toLowerCase();
  if (!address.includes("@") || address.includes("noorders")) return [];
  const r = seed(shop + ":" + address);
  const count = 2 + Math.floor(r() * 3);
  const out: Order[] = [];
  for (let i = 0; i < count; i++) {
    const placed = new Date(today.getTime() - (i * 19 + 2 + Math.floor(r() * 6)) * 86_400_000);
    const status: Order["status"] = i === 0 ? (r() < 0.5 ? "shipped" : "processing") : r() < 0.8 ? "delivered" : "refunded";
    const items = [PRODUCTS[Math.floor(r() * PRODUCTS.length)], ...(r() < 0.4 ? [PRODUCTS[Math.floor(r() * PRODUCTS.length)]] : [])];
    const shipped = status === "shipped" || status === "delivered";
    out.push({
      number: String(1000 + Math.floor(r() * 9000)),
      email: address,
      placedAt: placed.toISOString(),
      status,
      total: `${SHOPS[shop].currency}${(20 + r() * 140).toFixed(2)}`,
      items,
      carrier: shipped ? SHOPS[shop].carrier : null,
      tracking: shipped ? (shop === "uk" ? "RM" : "1Z") + Math.floor(100_000_000 + r() * 899_999_999) : null,
      estimatedDelivery: status === "shipped" ? day(today, 2) : status === "processing" ? day(today, 5) : null,
    });
  }
  return out;
}

/** The order service's HTTP handler. `down` makes it fail, to show the app's own error card. */
export function orderService(options: { down?: () => boolean } = {}) {
  return async (req: Request): Promise<Response> => {
    if (options.down?.()) return Response.json({ error: "The order service is down for maintenance." }, { status: 503 });
    const url = new URL(req.url);
    const shop = (url.searchParams.get("shop") ?? "uk") as Shop;
    if (!(shop in SHOPS)) return Response.json({ error: "No such shop." }, { status: 404 });
    if (url.pathname === "/orders") return Response.json({ orders: ordersFor(shop, url.searchParams.get("email") ?? "") });
    return Response.json({ error: "Not found." }, { status: 404 });
  };
}

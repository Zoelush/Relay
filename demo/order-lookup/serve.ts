import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { orderLookupApp } from "./app";
import { orderService } from "./orders";

/**
 * Runs the order-lookup example (phase 15, step D5) on this machine: the app on 127.0.0.1:8830 (the
 * address the local relay allows for Canvas) and the demo order service on 127.0.0.1:8831.
 *
 *   1. Start Relay (`npm run dev:relay`) and register the app in Settings › Developers › Apps:
 *      redirect http://127.0.0.1:8830/oauth/callback, scopes conversations.read and
 *      contacts.personal_data, canvas address http://127.0.0.1:8830/canvas, all three placements.
 *   2. Start this with what Relay showed you once:
 *      RELAY_CLIENT_ID=… RELAY_CLIENT_SECRET=… RELAY_CANVAS_SECRET=… npm run example:orders
 *   3. Open http://127.0.0.1:8830/install, allow it, then configure it in Settings and open a
 *      conversation whose customer has an email.
 *
 * Installations are kept in memory: after a restart, install again.
 */
export function listen(handle: (req: Request) => Promise<Response>, port: number, host = "127.0.0.1") {
  return new Promise<Server>((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const response = await handle(new Request(`http://${host}:${port}${req.url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const appPort = Number(process.env.ORDER_APP_PORT ?? 8830);
  const ordersPort = Number(process.env.ORDER_SERVICE_PORT ?? 8831);
  const { RELAY_CLIENT_ID, RELAY_CLIENT_SECRET, RELAY_CANVAS_SECRET } = process.env;
  const app = orderLookupApp({
    relayHost: process.env.RELAY_HOST ?? "http://127.0.0.1:8789",
    relayApi: process.env.RELAY_API ?? "http://127.0.0.1:8788",
    publicUrl: `http://127.0.0.1:${appPort}`,
    orderService: `http://127.0.0.1:${ordersPort}`,
    credentials: RELAY_CLIENT_ID && RELAY_CLIENT_SECRET && RELAY_CANVAS_SECRET ? { clientId: RELAY_CLIENT_ID, clientSecret: RELAY_CLIENT_SECRET, canvasSecret: RELAY_CANVAS_SECRET } : undefined,
  });
  await listen(orderService(), ordersPort);
  await listen(app.handle, appPort);
  console.log(`Order lookup: http://127.0.0.1:${appPort} (orders at http://127.0.0.1:${ordersPort}).`);
  if (!RELAY_CLIENT_ID) console.log("Set RELAY_CLIENT_ID, RELAY_CLIENT_SECRET and RELAY_CANVAS_SECRET from Settings › Developers › Apps to install it.");
}

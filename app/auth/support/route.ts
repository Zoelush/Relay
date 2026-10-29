import { env } from "cloudflare:workers";
import { bridgeSsoRequest } from "@/server/agent-bridge";
export const dynamic = "force-dynamic";
/** Phase 16 C7b: Relay support's sign-in: to Relay's identity provider (docs/SECURITY_STEP12.md). */
export async function GET(request: Request) {
  return bridgeSsoRequest(request, env);
}

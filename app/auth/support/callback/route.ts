import { env } from "cloudflare:workers";
import { bridgeSsoRequest } from "@/server/agent-bridge";
export const dynamic = "force-dynamic";
/** Phase 16 C7b: Relay's identity provider's return: a read-only support session (docs/SECURITY_STEP12.md). */
export async function GET(request: Request) {
  return bridgeSsoRequest(request, env);
}

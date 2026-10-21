import { env } from "cloudflare:workers";
import { bridgeAuthRequest } from "@/server/agent-bridge";
export const dynamic = "force-dynamic";
/** Phase 16 C3a: sign in, accept an invitation, sign out, read an invitation (docs/SECURITY_STEP3.md). */
export async function POST(request: Request) {
  return bridgeAuthRequest(request, env);
}

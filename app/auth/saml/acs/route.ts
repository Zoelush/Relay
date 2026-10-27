import { env } from "cloudflare:workers";
import { bridgeSsoRequest } from "@/server/agent-bridge";
export const dynamic = "force-dynamic";
/** Phase 16 C4b: the identity provider's SAML response (HTTP-POST), parked, then on to the callback (docs/SECURITY_STEP6.md). */
export async function POST(request: Request) {
  return bridgeSsoRequest(request, env);
}

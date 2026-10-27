import { env } from "cloudflare:workers";
import { bridgeSsoRequest } from "@/server/agent-bridge";
export const dynamic = "force-dynamic";
/** Phase 16 C4b: Relay's SAML service provider metadata, for the identity provider (docs/SECURITY_STEP6.md). */
export async function GET(request: Request) {
  return bridgeSsoRequest(request, env);
}

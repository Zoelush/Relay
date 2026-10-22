import { env } from "cloudflare:workers";
import { bridgeSsoRequest } from "@/server/agent-bridge";
export const dynamic = "force-dynamic";
/** Phase 16 C4a: start single sign-on: to the identity provider (docs/SECURITY_STEP5.md). */
export async function GET(request: Request) {
  return bridgeSsoRequest(request, env);
}

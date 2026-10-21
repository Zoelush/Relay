import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { bridgeAgentRequest, sessionCookie } from "@/server/agent-bridge";
export const dynamic = "force-dynamic";
async function handler(request: Request) {
  // Phase 16 C3a: a Relay session (password sign-in) comes first; otherwise the hosting platform's.
  const session = sessionCookie(request);
  const user = session ? null : await getChatGPTUser();
  return bridgeAgentRequest(request, user?.userId, env, fetch, session);
}
export const GET = handler;
export const POST = handler;

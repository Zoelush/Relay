import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { bridgeAgentRequest } from "@/server/agent-bridge";
export const dynamic = "force-dynamic";
async function handler(request: Request) {
  const user = await getChatGPTUser();
  return bridgeAgentRequest(request, user?.userId, env);
}
export const GET = handler;
export const POST = handler;

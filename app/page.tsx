import Inbox from "@/components/relay/inbox";
import PostgresInbox from "@/components/relay/postgres-inbox";
import { env } from "cloudflare:workers";
import { postgresInboxEnabled } from "@/server/agent-bridge";
import { requireChatGPTUser } from "./chatgpt-auth";
export const dynamic = "force-dynamic";
export default async function Page() {
  await requireChatGPTUser("/");
  return postgresInboxEnabled(env) ? <PostgresInbox /> : <Inbox />;
}

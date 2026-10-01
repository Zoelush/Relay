import Inbox from "@/components/relay/inbox";
import PostgresInbox from "@/components/relay/postgres-inbox";
import { env } from "cloudflare:workers";
import { postgresInboxEnabled } from "@/server/agent-bridge";
import { chatGPTSignOutPath, requireChatGPTUser } from "./chatgpt-auth";
export const dynamic = "force-dynamic";
export default async function Page() {
  const user = await requireChatGPTUser("/");
  return postgresInboxEnabled(env) ? (
    <PostgresInbox
      hosting={{ email: user.email, signOutHref: chatGPTSignOutPath("/") }}
    />
  ) : (
    <Inbox />
  );
}

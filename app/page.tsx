import Inbox from "@/components/relay/inbox";
import PostgresInbox from "@/components/relay/postgres-inbox";
import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { postgresInboxEnabled, SESSION_COOKIE } from "@/server/agent-bridge";
import { chatGPTSignOutPath, requireChatGPTUser } from "./chatgpt-auth";
export const dynamic = "force-dynamic";
export default async function Page() {
  // Phase 16 C3a: a Relay session (password sign-in) opens the inbox; the API checks it on every
  // request and sends the page to /signin when it's ended. Otherwise, the hosting platform's sign-in.
  if (postgresInboxEnabled(env) && (await cookies()).get(SESSION_COOKIE)) return <PostgresInbox />;
  const user = await requireChatGPTUser("/");
  return postgresInboxEnabled(env) ? (
    <PostgresInbox
      hosting={{ email: user.email, signOutHref: chatGPTSignOutPath("/") }}
    />
  ) : (
    <Inbox />
  );
}

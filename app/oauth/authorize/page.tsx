import OAuthConsentPage from "./consent";
import { requireChatGPTUser } from "../../chatgpt-auth";
export const dynamic = "force-dynamic";
/** Phase 15 D4: an app's consent screen, for the signed-in teammate (docs/DEVELOPER_PLATFORM_STEP4.md). */
export default async function Page() {
  await requireChatGPTUser("/oauth/authorize");
  return <OAuthConsentPage />;
}

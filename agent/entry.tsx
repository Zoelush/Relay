import { createRoot } from "react-dom/client";
import PostgresInbox from "../components/relay/postgres-inbox";
import OAuthConsent from "./oauth-consent";
// Phase 15 D4: /oauth/authorize is an app's consent screen; everything else is the inbox.
createRoot(document.getElementById("agent-root")!).render(window.location.pathname === "/oauth/authorize" ? <OAuthConsent /> : <PostgresInbox />);

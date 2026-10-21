import { createRoot } from "react-dom/client";
import PostgresInbox from "../components/relay/postgres-inbox";
import OAuthConsent from "./oauth-consent";
import { AcceptInvitation, SignIn } from "./signin";
// Phase 15 D4: /oauth/authorize is an app's consent screen. Phase 16 C3a: /signin and /invite are
// Relay's own sign-in and invitations. Everything else is the inbox.
const path = window.location.pathname;
createRoot(document.getElementById("agent-root")!).render(
  path === "/oauth/authorize" ? <OAuthConsent /> : path === "/signin" ? <SignIn /> : path === "/invite" ? <AcceptInvitation /> : <PostgresInbox />,
);

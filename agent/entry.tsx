import { createRoot } from "react-dom/client";
import PostgresInbox from "../components/relay/postgres-inbox";
createRoot(document.getElementById("agent-root")!).render(<PostgresInbox />);

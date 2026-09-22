declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    RELAY_AGENT_INBOX_V1?: string;
    RELAY_STORAGE_AUTHORITY?: string;
    RELAY_API_ORIGIN?: string;
    RELAY_WORKSPACE_ID?: string;
    RELAY_BRIDGE_SECRET?: string;
  }
}

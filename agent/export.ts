import { api } from "./api";
import { MESSAGES, type TimelinePart } from "./timeline";

/**
 * "Export conversation as text" in the conversation header's menu: the whole conversation as
 * the customer saw it, oldest first, downloaded as a text file. Internal notes are left out (a
 * file can travel anywhere; notes stay in Relay), and so are system events.
 */
type Part = TimelinePart & { seq: string; created_at: string };
const MAX_PAGES = 100;

export function transcript(
  title: string,
  parts: Part[],
  locale?: string,
): string {
  const superseded = new Set(parts.map((p) => p.supersedes_id).filter(Boolean));
  const lines = parts
    .filter(
      (p) =>
        MESSAGES.has(p.kind) &&
        !superseded.has(p.id) &&
        p.audience !== "internal" &&
        p.kind !== "internal_note" &&
        !p.data.deleted,
    )
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .map((p) => {
      const who =
        p.author_type === "contact"
          ? "Customer"
          : (p.data.authorName ??
            (p.author_type === "ai" ? "AI agent" : "Teammate"));
      const when = new Date(p.created_at).toLocaleString(locale);
      const attachment =
        p.kind === "attachment" ? `[Attachment: ${p.data.name ?? "file"}]` : "";
      return `${who} · ${when}\n${[p.body, attachment].filter(Boolean).join("\n")}`;
    });
  return [
    title || "Conversation",
    "Exported from Relay. Internal notes are not included.",
    "",
    lines.join("\n\n") || "No messages.",
    "",
  ].join("\n");
}

/** Fetches every part (the open timeline may hold only the newest ones), then downloads. */
export async function exportConversation(
  conversationId: string,
  title: string,
  loaded: Part[],
  older: string | null | undefined,
) {
  const parts = new Map(loaded.map((p) => [p.id, p]));
  let before = older;
  for (let i = 0; before && i < MAX_PAGES; i++) {
    const page = await api<{ parts: Part[]; older: string | null }>(
      "history?" +
        new URLSearchParams({ conversation: conversationId, before }),
    );
    for (const p of page.parts) parts.set(p.id, p);
    before = page.older;
  }
  const text = transcript(title, [...parts.values()]);
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download =
    (title || "conversation")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)
      .toLowerCase() + ".txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { normalizeDoc, type RichBlock, type RichDoc, type RichInline } from "./rich-doc";

/**
 * An article as Markdown (the help center's "View as Markdown"; docs/HELP_CENTER_DESIGN.md), for
 * readers who paste it into another tool. Built from the validated document, never from HTML;
 * links to other articles use the address `link` gives, images theirs from `image`.
 */
export function articleMarkdown(
  title: string,
  doc: unknown,
  fallback: string,
  to: { link: (recordId: string) => string | null | undefined; image: (attachmentId: string) => string | null },
) {
  let safe: RichDoc;
  try {
    safe = normalizeDoc(doc, { article: true });
  } catch {
    return `# ${title}\n\n${fallback}\n`;
  }
  // Characters Markdown would read as formatting, in running text.
  const escape = (t: string) => t.replace(/([\\`*_[\]<>|])/g, "\\$1");
  const inline = (nodes: RichInline[] = []) =>
    nodes
      .map((n) => {
        if (n.type === "hardBreak") return "  \n";
        if (n.type === "mention") return "@" + escape(n.attrs.label);
        if (n.type === "variable") return "{" + n.attrs.name + "}";
        let text = n.marks?.some((m) => m.type === "code") ? "`" + n.text.replace(/`/g, "'") + "`" : escape(n.text);
        for (const m of n.marks ?? []) {
          if (m.type === "bold") text = `**${text}**`;
          else if (m.type === "italic") text = `*${text}*`;
          else if (m.type === "link") text = `[${text}](${m.attrs.href.replace(/[()\s]/g, encodeURIComponent)})`;
          else if (m.type === "articleLink") {
            const href = to.link(m.attrs.recordId);
            if (href) text = `[${text}](${href})`;
          }
        }
        return text;
      })
      .join("");
  const indent = (text: string, first: string) => {
    const pad = " ".repeat(first.length);
    return text
      .split("\n")
      .map((l, i) => (i === 0 ? first + l : l ? pad + l : l))
      .join("\n");
  };
  const blocks = (list: RichBlock[]): string => list.map(block).filter(Boolean).join("\n\n");
  const block = (n: RichBlock): string => {
    switch (n.type) {
      case "paragraph":
        return inline(n.content);
      case "heading":
        return "#".repeat(n.attrs.level) + " " + inline(n.content);
      case "codeBlock":
        return "```" + (n.attrs?.language ?? "") + "\n" + (n.content ?? []).map((t) => t.text).join("") + "\n```";
      case "image": {
        const src = to.image(n.attrs.attachmentId);
        return src ? `![${escape(n.attrs.alt ?? "")}](${src})` : n.attrs.alt ? `[Image: ${escape(n.attrs.alt)}]` : "";
      }
      case "blockquote":
        return blocks(n.content)
          .split("\n")
          .map((l) => "> " + l)
          .join("\n");
      case "callout":
        return (
          `> **${{ info: "Note", warning: "Warning", success: "Tip" }[n.attrs.tone]}**\n` +
          blocks(n.content)
            .split("\n")
            .map((l) => "> " + l)
            .join("\n")
        );
      case "bulletList":
        return n.content.map((item) => indent(blocks(item.content), "- ")).join("\n");
      case "orderedList":
        return n.content.map((item, i) => indent(blocks(item.content), `${(n.attrs?.start ?? 1) + i}. `)).join("\n");
      case "video":
        return n.attrs.provider === "youtube" ? `https://www.youtube.com/watch?v=${n.attrs.id}` : `https://vimeo.com/${n.attrs.id}`;
      case "table": {
        const rows = n.content.map((row) => row.content.map((cell) => blocks(cell.content).replace(/\n+/g, " ").replace(/\|/g, "\\|")));
        if (!rows.length) return "";
        const width = Math.max(...rows.map((r) => r.length));
        const line = (cells: string[]) => "| " + Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ") + " |";
        return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
      }
    }
  };
  return `# ${title}\n\n${blocks(safe.content)}\n`;
}

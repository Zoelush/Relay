import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { Extension, Mark, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import {
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
  tableEditing,
} from "@tiptap/pm/tables";
import {
  normalizeDoc,
  RichDocError,
  safeHref,
  type RichDoc,
} from "../lib/rich-doc";
import { IMAGE_ACCEPT, uploadKnowledgeFile } from "./knowledge-files";

/**
 * The knowledge article editor: Relay's article profile (lib/rich-doc.ts) as a TipTap editor.
 * Headings (levels 2–4), callouts, code blocks with a language, tables, YouTube and Vimeo videos,
 * links, and links to other knowledge records by id. The server validates every save again.
 * Images (step C1a) are uploaded as knowledge files and scanned before they are placed; each one
 * needs a description (alt text).
 */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({ tone: { default: "info" } }),
  parseHTML: () => [
    {
      tag: "div[data-callout]",
      getAttrs: (el) => ({ tone: (el as HTMLElement).dataset.callout }),
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    {
      "data-callout": node.attrs.tone,
      class: `pg-callout pg-callout-${node.attrs.tone}`,
    },
    0,
  ],
});
/** Shown as a labelled card: the inbox does not load third-party frames. */
const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  addAttributes: () => ({
    provider: { default: "youtube" },
    id: { default: "" },
  }),
  parseHTML: () => [{ tag: "div[data-video]" }],
  renderHTML: ({ node }) => [
    "div",
    { "data-video": node.attrs.provider, class: "pg-video" },
    `${node.attrs.provider === "youtube" ? "YouTube" : "Vimeo"} video · ${node.attrs.id}`,
  ],
});
/** An uploaded, scanned image, shown through the authenticated file route. */
const ArticleImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({
    attachmentId: { default: "" },
    alt: { default: "" },
  }),
  renderHTML: ({ node }) => [
    "figure",
    { class: "pg-article-image" },
    [
      "img",
      {
        src:
          "/api/agent/knowledge-file?" +
          new URLSearchParams({ id: String(node.attrs.attachmentId) }),
        alt: node.attrs.alt,
        draggable: "false",
      },
    ],
  ],
});
const cellAttributes = () => ({
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null },
});
const Table = Node.create({
  name: "table",
  group: "block",
  content: "tableRow+",
  isolating: true,
  parseHTML: () => [{ tag: "table" }],
  renderHTML: ({ HTMLAttributes }) => [
    "table",
    mergeAttributes(HTMLAttributes, { class: "pg-table" }),
    ["tbody", 0],
  ],
});
const TableRow = Node.create({
  name: "tableRow",
  content: "(tableCell | tableHeader)*",
  parseHTML: () => [{ tag: "tr" }],
  renderHTML: () => ["tr", 0],
});
const TableCell = Node.create({
  name: "tableCell",
  content: "block+",
  isolating: true,
  addAttributes: cellAttributes,
  parseHTML: () => [{ tag: "td" }],
  renderHTML: () => ["td", 0],
});
const TableHeader = Node.create({
  name: "tableHeader",
  content: "block+",
  isolating: true,
  addAttributes: cellAttributes,
  parseHTML: () => [{ tag: "th" }],
  renderHTML: () => ["th", 0],
});
/** ProseMirror's table commands find tables by schema role, which TipTap does not pass through. */
const TABLE_ROLES: Record<string, string> = {
  table: "table",
  tableRow: "row",
  tableCell: "cell",
  tableHeader: "header_cell",
};
const TableRoles = Extension.create({
  name: "tableRoles",
  extendNodeSchema: (extension) =>
    TABLE_ROLES[extension.name]
      ? { tableRole: TABLE_ROLES[extension.name] }
      : {},
});
const TableEditing = Extension.create({
  name: "tableEditing",
  addProseMirrorPlugins: () => [tableEditing()],
});
/** A link to another knowledge record, kept by id so it survives title and slug changes. */
const ArticleLink = Mark.create({
  name: "articleLink",
  inclusive: false,
  addAttributes: () => ({ recordId: { default: "" } }),
  parseHTML: () => [
    {
      tag: "a[data-article-link]",
      getAttrs: (el) => ({ recordId: (el as HTMLElement).dataset.articleLink }),
    },
  ],
  renderHTML: ({ mark }) => [
    "a",
    { "data-article-link": mark.attrs.recordId, class: "pg-article-link" },
    0,
  ],
});

const EMPTY_CELL = { type: "paragraph" };
const newTable = {
  type: "table",
  content: [0, 1, 2].map((row) => ({
    type: "tableRow",
    content: [0, 1].map(() => ({
      type: row === 0 ? "tableHeader" : "tableCell",
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: [EMPTY_CELL],
    })),
  })),
};

/** The editor's content as an article document, or the reason it is not valid. */
export function articleDoc(editor: Editor): {
  doc: RichDoc | null;
  error: string;
} {
  try {
    const doc = normalizeDoc(editor.getJSON(), { article: true });
    const empty =
      doc.content.length === 1 &&
      doc.content[0].type === "paragraph" &&
      !doc.content[0].content;
    return { doc: empty ? null : doc, error: "" };
  } catch (e) {
    return {
      doc: null,
      error:
        e instanceof RichDocError ? e.message : "This content cannot be saved.",
    };
  }
}

/** A YouTube or Vimeo address as a video node's attributes, or null. */
export function videoFrom(address: string) {
  try {
    const url = new URL(address.trim());
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be")
      return { provider: "youtube", id: url.pathname.slice(1) };
    if (host === "youtube.com" || host === "m.youtube.com")
      return {
        provider: "youtube",
        id: url.searchParams.get("v") ?? url.pathname.split("/").pop() ?? "",
      };
    if (host === "vimeo.com")
      return {
        provider: "vimeo",
        id: url.pathname.split("/").filter(Boolean).pop() ?? "",
      };
  } catch {
    // Not an address.
  }
  return null;
}

export function ArticleEditor({
  value,
  editable,
  records,
  recordId,
  onChange,
}: {
  /** Content loaded when `key` changes (another record or language, or a restore). */
  value: { key: string; doc: RichDoc | null };
  editable: boolean;
  /** Other records, for internal links. */
  records: { id: string; title: string }[];
  /** The record being edited, which uploaded images belong to. */
  recordId?: string;
  onChange: (doc: RichDoc | null, error: string) => void;
}) {
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });
  const [prompt, setPrompt] = useState<
    null | "link" | "video" | "article" | "image"
  >(null);
  const [input, setInput] = useState("");
  const [problem, setProblem] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [uploading, setUploading] = useState("");
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      content: value.doc ?? "",
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3, 4] },
          horizontalRule: false,
          strike: false,
          underline: false,
          link: {
            openOnClick: false,
            autolink: true,
            protocols: ["mailto"],
            isAllowedUri: (url) => {
              try {
                safeHref(url);
                return true;
              } catch {
                return false;
              }
            },
          },
        }),
        Callout,
        Video,
        ArticleImage,
        Table,
        TableRow,
        TableCell,
        TableHeader,
        TableRoles,
        TableEditing,
        ArticleLink,
      ],
      editorProps: {
        attributes: { "aria-label": "Article body", class: "pg-article-body" },
      },
      onUpdate: ({ editor }) => {
        const { doc, error } = articleDoc(editor);
        change.current(doc, error);
      },
    },
    [value.key, editable],
  );
  if (!editor) return <div className="pg-article-editor" aria-busy="true" />;
  const chain = () => editor.chain().focus();
  /** A 3×2 table with a paragraph after it, the cursor in its first cell. */
  const insertTable = () =>
    chain()
      .insertContent([newTable, { type: "paragraph" }])
      .command(({ tr }) => {
        let start = -1;
        tr.doc.nodesBetween(0, tr.selection.from, (node, pos) => {
          if (node.type.name === "table") start = pos;
        });
        if (start >= 0)
          tr.setSelection(TextSelection.near(tr.doc.resolve(start + 4)));
        return true;
      })
      .run();
  const table = (command: typeof addRowAfter) =>
    command(editor.state, editor.view.dispatch);
  const button = (label: string, active: boolean, run: () => void) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );
  /** Uploads the chosen image, waits for the scan, then places it with its description. */
  const placeImage = async () => {
    const alt = input.trim();
    if (!image) return setProblem("Choose an image.");
    if (!alt)
      return setProblem("Describe the image for people who cannot see it.");
    try {
      const { fileId } = await uploadKnowledgeFile(
        image,
        { purpose: "article_image", recordId: recordId! },
        (state) =>
          setUploading(
            state === "uploading" ? "Uploading image…" : "Checking image…",
          ),
      );
      chain()
        .insertContent([
          { type: "image", attrs: { attachmentId: fileId, alt } },
          { type: "paragraph" },
        ])
        .run();
      setPrompt(null);
      setInput("");
      setImage(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "The image was not added.");
    } finally {
      setUploading("");
    }
  };
  const apply = () => {
    setProblem("");
    if (prompt === "image") return void placeImage();
    if (prompt === "link") {
      try {
        chain()
          .extendMarkRange("link")
          .setLink({ href: safeHref(input) })
          .run();
      } catch {
        return setProblem("Use a web or email address.");
      }
    } else if (prompt === "video") {
      const video = videoFrom(input);
      if (!video) return setProblem("Paste a YouTube or Vimeo address.");
      // A paragraph after it, so the next insert does not replace the selected video.
      chain()
        .insertContent([{ type: "video", attrs: video }, { type: "paragraph" }])
        .run();
    } else if (prompt === "article") {
      if (!input) return setProblem("Choose an article.");
      chain().setMark("articleLink", { recordId: input }).run();
    }
    setPrompt(null);
    setInput("");
  };
  return (
    <div className="pg-article-editor">
      {editable && (
        <div
          role="toolbar"
          aria-label="Formatting"
          className="pg-article-toolbar"
        >
          {button("Heading 2", editor.isActive("heading", { level: 2 }), () =>
            chain().toggleHeading({ level: 2 }).run(),
          )}
          {button("Heading 3", editor.isActive("heading", { level: 3 }), () =>
            chain().toggleHeading({ level: 3 }).run(),
          )}
          {button("Bold", editor.isActive("bold"), () =>
            chain().toggleBold().run(),
          )}
          {button("Italic", editor.isActive("italic"), () =>
            chain().toggleItalic().run(),
          )}
          {button("Bullet list", editor.isActive("bulletList"), () =>
            chain().toggleBulletList().run(),
          )}
          {button("Numbered list", editor.isActive("orderedList"), () =>
            chain().toggleOrderedList().run(),
          )}
          {button("Quote", editor.isActive("blockquote"), () =>
            chain().toggleBlockquote().run(),
          )}
          {button("Code block", editor.isActive("codeBlock"), () =>
            chain().toggleCodeBlock().run(),
          )}
          {button("Callout", editor.isActive("callout"), () =>
            editor.isActive("callout")
              ? chain().lift("callout").run()
              : chain().wrapIn("callout", { tone: "info" }).run(),
          )}
          {button("Table", editor.isActive("table"), () => insertTable())}
          {editor.isActive("table") && (
            <>
              {button("Add row", false, () => table(addRowAfter))}
              {button("Add column", false, () => table(addColumnAfter))}
              {button("Delete row", false, () => table(deleteRow))}
              {button("Delete column", false, () => table(deleteColumn))}
              {button("Delete table", false, () => table(deleteTable))}
            </>
          )}
          {button("Link", editor.isActive("link"), () => {
            setPrompt("link");
            setInput(String(editor.getAttributes("link").href ?? ""));
          })}
          {button("Link to article", editor.isActive("articleLink"), () => {
            setPrompt("article");
            setInput(
              String(editor.getAttributes("articleLink").recordId ?? ""),
            );
          })}
          {button("Video", false, () => {
            setPrompt("video");
            setInput("");
          })}
          {recordId &&
            button("Image", false, () => {
              setPrompt("image");
              setInput("");
              setImage(null);
              setProblem("");
            })}
          {editor.isActive("callout") && (
            <select
              aria-label="Callout tone"
              value={String(editor.getAttributes("callout").tone ?? "info")}
              onChange={(e) =>
                chain()
                  .updateAttributes("callout", { tone: e.target.value })
                  .run()
              }
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="success">Success</option>
            </select>
          )}
          {editor.isActive("codeBlock") && (
            <input
              aria-label="Code language"
              placeholder="Language"
              value={String(editor.getAttributes("codeBlock").language ?? "")}
              onChange={(e) =>
                chain()
                  .updateAttributes("codeBlock", {
                    language: e.target.value || null,
                  })
                  .run()
              }
            />
          )}
        </div>
      )}
      {prompt && (
        <div
          className="pg-article-prompt"
          role="group"
          aria-label={
            prompt === "article"
              ? "Link to article"
              : prompt === "video"
                ? "Add video"
                : prompt === "image"
                  ? "Add image"
                  : "Add link"
          }
        >
          {prompt === "image" ? (
            <>
              <input
                type="file"
                aria-label="Image file"
                accept={IMAGE_ACCEPT}
                disabled={!!uploading}
                onChange={(e) => setImage(e.target.files?.[0] ?? null)}
              />
              <input
                aria-label="Image description"
                placeholder="Describe the image (alt text)"
                value={input}
                disabled={!!uploading}
                onChange={(e) => setInput(e.target.value)}
              />
            </>
          ) : prompt === "article" ? (
            <select
              aria-label="Article"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            >
              <option value="">Choose an article…</option>
              {records.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title || "Untitled"}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={prompt === "video" ? "Video address" : "Link address"}
              value={input}
              autoFocus
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply();
                }
              }}
            />
          )}
          <button type="button" onClick={apply} disabled={!!uploading}>
            {prompt === "image" ? "Add image" : "Apply"}
          </button>
          <button
            type="button"
            onClick={() => setPrompt(null)}
            disabled={!!uploading}
          >
            Cancel
          </button>
          {uploading && <span role="status">{uploading}</span>}
          {problem && <span role="alert">{problem}</span>}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

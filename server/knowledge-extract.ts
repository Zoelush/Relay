import { unzipSync } from "fflate";
import { Parser } from "htmlparser2";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * What a knowledge file is, judged from its bytes, and its text (phase 07, step C1a).
 *
 * Documents: PDF (pdf.js, through unpdf, which runs in Workers and in Node), Word .docx (a zip of
 * XML, read with fflate), HTML (htmlparser2, which behaves the same in both runtimes), Markdown
 * and plain text. Images: PNG, JPEG, GIF and WebP. SVG is not accepted: it can carry script.
 *
 * Extraction failures carry a code a teammate can act on: an encrypted PDF, a PDF with no text
 * layer (a scan), a damaged file, or a file of the wrong type.
 */
export const DOCUMENT_TYPES = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "Word",
  "text/html": "HTML",
  "text/markdown": "Markdown",
  "text/plain": "Text",
} as const;
export const IMAGE_TYPES = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
} as const;
export type DocumentType = keyof typeof DOCUMENT_TYPES;
export type ImageType = keyof typeof IMAGE_TYPES;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Extracted text kept per file; longer documents are truncated, and say so. */
export const MAX_EXTRACTED_CHARS = 2_000_000;

export class ExtractError extends Error {
  constructor(
    public code: "PDF_ENCRYPTED" | "NO_TEXT" | "UNREADABLE" | "TYPE_MISMATCH",
  ) {
    super(code);
  }
}

const startsWith = (bytes: Uint8Array, prefix: number[]) =>
  prefix.every((b, i) => bytes[i] === b);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.slice(from, to));

/** Whether bytes really are of the declared type (declared by the browser, checked here). */
export function matchesType(bytes: Uint8Array, declared: string) {
  switch (declared) {
    case "application/pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
    case "image/png":
      return startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
    case "image/jpeg":
      return startsWith(bytes, [255, 216, 255]);
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6));
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    case "text/html":
    case "text/markdown":
    case "text/plain":
      return isText(bytes);
  }
  return false;
}
function isText(bytes: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(0, 65536),
    );
    return !/[\u0000-\u0008\u000e-\u001f]/.test(text);
  } catch {
    // A multi-byte character cut at the sample boundary is still text.
    return bytes.length > 65536;
  }
}

/** Tidies extracted text: no runs of spaces, at most one blank line, trimmed, capped. */
export function tidy(text: string) {
  const t = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > MAX_EXTRACTED_CHARS
    ? { text: t.slice(0, MAX_EXTRACTED_CHARS), truncated: true }
    : { text: t, truncated: false };
}

export type Extracted = {
  text: string;
  truncated: boolean;
  pages: number | null;
  /** A title found inside the document (HTML <title>), if any. */
  title: string | null;
};

export async function extract(
  bytes: Uint8Array,
  type: DocumentType,
): Promise<Extracted> {
  if (!matchesType(bytes, type)) throw new ExtractError("TYPE_MISMATCH");
  if (type === "application/pdf") return pdf(bytes);
  if (
    type ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return { ...tidy(word(bytes)), pages: null, title: null };
  const decoded = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  if (type === "text/html") {
    const { text, title } = html(decoded);
    return { ...tidy(text), pages: null, title };
  }
  const result = tidy(decoded);
  if (!result.text) throw new ExtractError("NO_TEXT");
  return { ...result, pages: null, title: null };
}

async function pdf(bytes: Uint8Array): Promise<Extracted> {
  let document;
  try {
    // Quiet: pdf.js would otherwise log warnings about the document's content.
    document = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (e) {
    if ((e as { name?: string })?.name === "PasswordException")
      throw new ExtractError("PDF_ENCRYPTED");
    throw new ExtractError("UNREADABLE");
  }
  try {
    const { totalPages, text } = await extractText(document, {
      mergePages: false,
    });
    const result = tidy((text as string[]).join("\n\n"));
    // A scan: pages, but no text layer.
    if (!result.text) throw new ExtractError("NO_TEXT");
    return { ...result, pages: totalPages, title: null };
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError("UNREADABLE");
  } finally {
    await (document as { destroy?: () => Promise<void> }).destroy?.();
  }
}

/** The text of a .docx: paragraphs, tabs and line breaks from word/document.xml. */
function word(bytes: Uint8Array) {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => f.name === "word/document.xml",
    });
  } catch {
    throw new ExtractError("UNREADABLE");
  }
  const xml = files["word/document.xml"];
  if (!xml) throw new ExtractError("UNREADABLE");
  const text = new TextDecoder()
    .decode(xml)
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(br|cr)\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g, "\u0001$1\u0002")
    .replace(/<[^>]+>/g, "")
    .replace(/\u0001([^\u0002]*)\u0002/g, "$1");
  const decoded = decodeXml(text);
  if (!decoded.trim()) throw new ExtractError("NO_TEXT");
  return decoded;
}
const decodeXml = (t: string) =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&amp;/g, "&");

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "head",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "li",
  "ul",
  "ol",
  "tr",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "hr",
  "blockquote",
  "pre",
  "dt",
  "dd",
  "figure",
  "figcaption",
]);

/**
 * The visible text of an HTML document: scripts, styles and other non-content removed, block
 * elements on their own lines, and the <title>. Step C1b reuses this for synced pages, with
 * selectors to strip.
 */
export function html(source: string) {
  let skip = 0,
    inTitle = false,
    title = "";
  const out: string[] = [];
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === "title") inTitle = true;
        else if (SKIP.has(name)) skip++;
        else if (BLOCK.has(name)) out.push("\n");
        if (name === "td" || name === "th") out.push(" ");
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
        else if (SKIP.has(name)) skip = Math.max(0, skip - 1);
        else if (BLOCK.has(name)) out.push("\n");
      },
      ontext(text) {
        if (inTitle) title += text;
        else if (!skip) out.push(text);
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(source);
  parser.end();
  return {
    text: out.join(""),
    title: title.replace(/\s+/g, " ").trim() || null,
  };
}

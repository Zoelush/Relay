import { createContext, useContext } from "react";
import { Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { api } from "./api";

export type ImageStatus =
  "uploading" | "scanning" | "clean" | "rejected" | "failed";
export const IMAGE_TYPES = ["image/png", "image/jpeg"];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Upload status by attachment id, provided by the inbox. Unknown ids (restored drafts) load. */
export const ImageStatusContext = createContext<
  (id: string) => ImageStatus | undefined
>(() => undefined);

function ImageView({ node, deleteNode, selected }: NodeViewProps) {
  const status = useContext(ImageStatusContext)(node.attrs.attachmentId);
  const alt = String(node.attrs.alt ?? "");
  return (
    <NodeViewWrapper
      className={"pg-inline-image" + (selected ? " selected" : "")}
      data-image-status={status ?? "restored"}
    >
      {status === "uploading" || status === "scanning" ? (
        <span className="pg-image-state" role="status">
          {status === "uploading" ? "Uploading image…" : "Checking image…"}{" "}
          {alt}
        </span>
      ) : status === "rejected" || status === "failed" ? (
        <span className="pg-image-state blocked" role="alert">
          {status === "rejected"
            ? "Blocked by the scanner: " + alt
            : "Upload failed: " + alt}
        </span>
      ) : (
        // Authenticated attachment proxy: next/image would fetch without the session.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={
            "/api/agent/attachment/content?preview=true&id=" +
            encodeURIComponent(node.attrs.attachmentId)
          }
          alt={alt}
          draggable={false}
        />
      )}
      <button
        type="button"
        className="pg-image-remove"
        aria-label={"Remove image " + alt}
        onClick={() => deleteNode()}
      >
        Remove
      </button>
    </NodeViewWrapper>
  );
}

/**
 * The document's image node: an attachment id and alt text. It never holds a URL, and pasted
 * HTML images without an attachment id are dropped rather than hot-linked.
 */
export const InlineImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { attachmentId: { default: null }, alt: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "img[data-attachment-id]",
        getAttrs: (el) => ({
          attachmentId: (el as HTMLElement).getAttribute("data-attachment-id"),
          alt: (el as HTMLElement).getAttribute("alt") ?? "",
        }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      {
        "data-attachment-id": HTMLAttributes.attachmentId,
        alt: HTMLAttributes.alt,
      },
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

/** Client-side checks before upload; the server checks the bytes again after upload. */
export function imageProblem(file: File) {
  if (!IMAGE_TYPES.includes(file.type))
    return file.name + ": images must be PNG or JPEG.";
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES)
    return file.name + ": images must be 10 MB or smaller.";
  return null;
}

/**
 * Prepares an inline upload and returns its id straight away, so the image can appear in the
 * message; `done` settles when the bytes are uploaded and the scan job has been queued.
 */
export async function startImageUpload(
  file: File,
  conversationId: string,
  audience: "customer_visible" | "internal",
) {
  const prepared = await api<{
    attachmentId: string;
    url: string;
    headers: Record<string, string>;
  }>("attachment/prepare", {
    conversationId,
    name: file.name.slice(0, 200) || "image",
    size: file.size,
    type: file.type,
    audience,
    purpose: "inline",
  });
  const done = (async () => {
    const put = await fetch(prepared.url, {
      method: "PUT",
      headers: prepared.headers,
      body: file,
    });
    if (!put.ok) throw new Error("The image could not be uploaded.");
    const { jobId } = await api<{ jobId: string }>("attachment/complete", {
      attachmentId: prepared.attachmentId,
    });
    return jobId;
  })();
  return { attachmentId: prepared.attachmentId, done };
}

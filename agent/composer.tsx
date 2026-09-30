import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Italic,
  Code,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  ImagePlus,
} from "lucide-react";
import { mentionExtension, type Mentionable } from "./mentions";
import {
  InlineImage,
  ImageStatusContext,
  IMAGE_TYPES,
  type ImageStatus,
} from "./images";
import {
  normalizeDoc,
  plainText,
  safeHref,
  type RichDoc,
} from "../lib/rich-doc";

/** The editor's content as Relay's restricted document, or null when there is no text. */
export function editorDoc(editor: Editor): RichDoc | null {
  try {
    const doc = normalizeDoc(editor.getJSON());
    // The editor keeps an empty paragraph after lists and quotes; it is not content.
    while (doc.content.length > 1) {
      const last = doc.content[doc.content.length - 1];
      if (last.type !== "paragraph" || last.content?.length) break;
      doc.content.pop();
    }
    return plainText(doc) ? doc : null;
  } catch {
    // Empty paragraphs and similar editor artefacts: treat as no content.
    return null;
  }
}

export type ComposerHandle = {
  focus: () => void;
  /** Places an image (by attachment id) at the cursor. */
  insertImage: (attachmentId: string, alt: string) => void;
};

/**
 * Rich composer limited to Relay's document format: paragraphs, lists, quotes, code blocks and
 * bold, italic, code and links. Paste is reduced to the same schema by the editor; the server
 * validates again. Keeps the accessible name the plain textarea had.
 */
export function Composer({
  label,
  placeholder,
  value,
  disabled,
  onChange,
  onSubmit,
  handleRef,
  onFiles,
  imageStatus,
  mentionables,
}: {
  label: string;
  placeholder: string;
  /** Content loaded whenever `key` changes. Typing does not round-trip through here. */
  value: { key: string; doc: RichDoc | null };
  disabled: boolean;
  onChange: (doc: RichDoc | null) => void;
  onSubmit: () => void;
  handleRef: React.RefObject<ComposerHandle | null>;
  /** Image files chosen, pasted or dropped. */
  onFiles: (files: File[]) => void;
  imageStatus: (attachmentId: string) => ImageStatus | undefined;
  /** Teammates and teams for @-mentions; null where mentions are not allowed (replies). */
  mentionables: Mentionable[] | null;
}) {
  const submit = useRef(onSubmit);
  const change = useRef(onChange);
  const files = useRef(onFiles);
  useEffect(() => {
    submit.current = onSubmit;
    change.current = onChange;
    files.current = onFiles;
  });
  const picker = useRef<HTMLInputElement>(null);
  // The editor is recreated whenever `value.key` changes (a new conversation or mode, or a
  // restored draft) with that content. Setting content on a just-created editor, before its view
  // mounts, can be dropped; typing never round-trips through here, so the cursor stays put.
  const editor = useEditor(
    {
      immediatelyRender: false,
      content: value.doc ?? "",
      extensions: [
        InlineImage,
        ...(mentionables ? [mentionExtension(mentionables)] : []),
        StarterKit.configure({
          heading: false,
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
            HTMLAttributes: {
              rel: "noopener noreferrer nofollow ugc",
              target: "_blank",
            },
          },
        }),
      ],
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": label,
          "data-placeholder": placeholder,
          class: "pg-editor",
        },
        // Image files become uploads; anything else pastes as the schema allows.
        handlePaste: (_view, event) => {
          const list = [...(event.clipboardData?.files ?? [])];
          if (!list.length) return false;
          files.current(list);
          return true;
        },
        handleDrop: (_view, event) => {
          const list = [...((event as DragEvent).dataTransfer?.files ?? [])];
          if (!list.length) return false;
          event.preventDefault();
          files.current(list);
          return true;
        },
        handleKeyDown: (view, event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit.current();
            return true;
          }
          if (event.key === "Escape") {
            (view.dom as HTMLElement).blur();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor }) => change.current(editorDoc(editor)),
    },
    [value.key],
  );
  useEffect(() => {
    editor?.setEditable(!disabled);
    editor?.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: {
          ...(editor.options.editorProps.attributes as Record<string, string>),
          "aria-label": label,
          "data-placeholder": placeholder,
        },
      },
    });
  }, [editor, disabled, label, placeholder]);
  useEffect(() => {
    handleRef.current = {
      focus: () => editor?.commands.focus("end"),
      insertImage: (attachmentId, alt) =>
        editor
          ?.chain()
          .focus()
          .insertContent([
            { type: "image", attrs: { attachmentId, alt } },
            { type: "paragraph" },
          ])
          .run(),
    };
  }, [editor, handleRef]);
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState("");
  if (!editor) return <div className="pg-editor-shell" aria-busy="true" />;
  const tool = (
    name: string,
    active: boolean,
    run: () => void,
    icon: React.ReactNode,
  ) => (
    <button
      type="button"
      aria-label={name}
      title={name}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon}
    </button>
  );
  const chain = () => editor.chain().focus();
  return (
    <div className="pg-editor-shell">
      <div className="pg-toolbar" role="toolbar" aria-label="Formatting">
        {tool(
          "Bold",
          editor.isActive("bold"),
          () => chain().toggleBold().run(),
          <Bold size={14} />,
        )}
        {tool(
          "Italic",
          editor.isActive("italic"),
          () => chain().toggleItalic().run(),
          <Italic size={14} />,
        )}
        {tool(
          "Inline code",
          editor.isActive("code"),
          () => chain().toggleCode().run(),
          <Code size={14} />,
        )}
        {tool(
          "Link",
          editor.isActive("link"),
          () => {
            setHref(String(editor.getAttributes("link").href ?? ""));
            setLinkError("");
            setLinking((x) => !x);
          },
          <LinkIcon size={14} />,
        )}
        {tool(
          "Bulleted list",
          editor.isActive("bulletList"),
          () => chain().toggleBulletList().run(),
          <List size={14} />,
        )}
        {tool(
          "Numbered list",
          editor.isActive("orderedList"),
          () => chain().toggleOrderedList().run(),
          <ListOrdered size={14} />,
        )}
        {tool(
          "Quote",
          editor.isActive("blockquote"),
          () => chain().toggleBlockquote().run(),
          <Quote size={14} />,
        )}
        {tool(
          "Code block",
          editor.isActive("codeBlock"),
          () => chain().toggleCodeBlock().run(),
          <SquareCode size={14} />,
        )}
        <button
          type="button"
          aria-label="Insert image"
          title="Insert image"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => picker.current?.click()}
        >
          <ImagePlus size={14} />
        </button>
        <input
          ref={picker}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          multiple
          hidden
          aria-label="Choose images"
          onChange={(e) => {
            const list = [...(e.target.files ?? [])];
            e.target.value = "";
            if (list.length) files.current(list);
          }}
        />
      </div>
      {linking && (
        <div className="pg-link-form">
          <input
            aria-label="Link address"
            placeholder="https://…"
            value={href}
            autoFocus
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setLinking(false);
              if (e.key !== "Enter") return;
              e.preventDefault();
              try {
                const url = safeHref(href);
                chain().extendMarkRange("link").setLink({ href: url }).run();
                setLinking(false);
              } catch {
                setLinkError(
                  "Use a web (https://) or email (mailto:) address.",
                );
              }
            }}
          />
          <button
            type="button"
            onClick={() => {
              chain().extendMarkRange("link").unsetLink().run();
              setLinking(false);
            }}
          >
            Remove link
          </button>
          {linkError && <span role="alert">{linkError}</span>}
        </div>
      )}
      <ImageStatusContext.Provider value={imageStatus}>
        <EditorContent editor={editor} />
      </ImageStatusContext.Provider>
    </div>
  );
}

import { forwardRef, useImperativeHandle, useState } from "react";
import Mention from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";

export type Mentionable = {
  kind: "teammate" | "team";
  id: string;
  label: string;
};
type ListHandle = { onKeyDown: (event: KeyboardEvent) => boolean };
type ListProps = SuggestionProps<Mentionable, Mentionable>;

/** The @-picker: arrow keys move, Enter or Tab chooses, Escape closes. */
const MentionList = forwardRef<ListHandle, ListProps>(function MentionList(
  { items, command },
  ref,
) {
  const [active, setActive] = useState(0);
  const current = Math.min(active, Math.max(0, items.length - 1));
  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (!items.length) return false;
      if (event.key === "ArrowDown") {
        setActive((current + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setActive((current - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        command(items[current]);
        return true;
      }
      return false;
    },
  }));
  return (
    <ul
      role="listbox"
      aria-label="Mention a teammate or team"
      className="pg-mention-list"
    >
      {items.length ? (
        items.map((item, i) => (
          <li
            key={item.kind + ":" + item.id}
            role="option"
            aria-selected={i === current}
            onMouseDown={(e) => {
              e.preventDefault();
              command(item);
            }}
          >
            {item.label}
            <small>{item.kind === "team" ? "Team" : "Teammate"}</small>
          </li>
        ))
      ) : (
        <li className="pg-empty">No matches</li>
      )}
    </ul>
  );
});

/**
 * TipTap's mention node with a `kind` attribute (teammate or team), matching Relay's document
 * format. `list` is the directory when the editor was created (it is recreated per conversation
 * and mode); the server re-checks every mention at send.
 */
export function mentionExtension(list: Mentionable[]) {
  return Mention.extend({
    addAttributes() {
      return { ...this.parent?.(), kind: { default: "teammate" } };
    },
  }).configure({
    HTMLAttributes: { class: "rich-mention" },
    renderText: ({ node }) => "@" + node.attrs.label,
    renderHTML: ({ node, options }) => [
      "span",
      { ...options.HTMLAttributes, "data-mention-kind": node.attrs.kind },
      "@" + node.attrs.label,
    ],
    suggestion: {
      char: "@",
      items: ({ query }) =>
        list
          .filter((m) => m.label.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 8),
      render: () => {
        let component: ReactRenderer<ListHandle, ListProps> | undefined;
        const place = (props: ListProps) => {
          const rect = props.clientRect?.();
          const el = component?.element as HTMLElement | undefined;
          if (!rect || !el) return;
          el.style.left = rect.left + "px";
          el.style.top = rect.bottom + 4 + "px";
        };
        return {
          onStart: (props) => {
            component = new ReactRenderer(MentionList, {
              props,
              editor: props.editor,
            });
            const el = component.element as HTMLElement;
            el.classList.add("pg-mention-popup");
            document.body.appendChild(el);
            place(props);
          },
          onUpdate: (props) => {
            component?.updateProps(props);
            place(props);
          },
          onKeyDown: (props: SuggestionKeyDownProps) => {
            if (props.event.key === "Escape") {
              (component?.element as HTMLElement | undefined)?.remove();
              return true;
            }
            return component?.ref?.onKeyDown(props.event) ?? false;
          },
          onExit: () => {
            (component?.element as HTMLElement | undefined)?.remove();
            component?.destroy();
          },
        };
      },
    },
  });
}

import { Node } from "@tiptap/core";
import type { MacroVariable } from "../lib/rich-doc";

/** Labels for the macro variables, as shown in the editor's picker. */
export const VARIABLE_LABELS: Record<MacroVariable, string> = {
  "contact.name": "Customer name",
  "contact.first_name": "Customer first name",
  "contact.email": "Customer email",
  "conversation.title": "Conversation title",
  "teammate.name": "Your name",
  "brand.name": "Brand name",
};

/**
 * A macro placeholder in the editor: an inline chip holding a variable name and fallback. It is
 * only added to editors for macro bodies; message editors cannot contain one, and the server
 * rejects variables anywhere but a macro.
 */
export const VariableNode = Node.create({
  name: "variable",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      name: { default: "contact.first_name" },
      fallback: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-variable]" }];
  },
  renderHTML({ node }) {
    return [
      "span",
      { class: "rich-variable", "data-variable": node.attrs.name },
      "{" +
        (VARIABLE_LABELS[node.attrs.name as MacroVariable] ?? node.attrs.name) +
        "}",
    ];
  },
  renderText({ node }) {
    return "{" + node.attrs.name + "}";
  },
});

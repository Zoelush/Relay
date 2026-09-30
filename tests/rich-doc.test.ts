import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDoc,
  plainText,
  isPlain,
  imageIds,
  fillVariables,
  RICH_LIMITS,
} from "../lib/rich-doc";

const text = (t: string, marks?: unknown[]) => ({
  type: "text",
  text: t,
  ...(marks ? { marks } : {}),
});
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", content });
const link = (href: string) => ({ type: "link", attrs: { href } });

test("rich documents are rebuilt from allowed content only", () => {
  const input = doc(
    p(
      text("Read ", [{ type: "bold", attrs: { style: "color:red" } }]),
      text("the guide", [
        {
          ...link("https://example.com/guide"),
          attrs: {
            href: "https://example.com/guide",
            target: "_top",
            onclick: "x()",
            class: "evil",
          },
        },
        { type: "italic" },
        { type: "italic" },
      ]),
      { type: "hardBreak", attrs: { id: "x" } },
    ),
    {
      type: "orderedList",
      attrs: { start: 3, class: "x" },
      content: [{ type: "listItem", content: [p(text("three"))] }],
    },
    {
      type: "codeBlock",
      attrs: { language: "js" },
      content: [text("let a = 1;")],
    },
    { type: "blockquote", content: [p(text("quoted"))] },
  );
  assert.deepEqual(
    normalizeDoc(input),
    doc(
      p(
        text("Read ", [{ type: "bold" }]),
        text("the guide", [
          link("https://example.com/guide"),
          { type: "italic" },
        ]),
        { type: "hardBreak" },
      ),
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [{ type: "listItem", content: [p(text("three"))] }],
      },
      { type: "codeBlock", content: [text("let a = 1;")] },
      { type: "blockquote", content: [p(text("quoted"))] },
    ),
  );
});

test("unsafe or unsupported content is rejected", () => {
  for (const [input, code] of [
    [
      doc({ type: "image", attrs: { src: "https://x.test/a.png" } }),
      "INVALID_DOCUMENT",
    ],
    [doc({ type: "heading", content: [text("H")] }), "INVALID_DOCUMENT"],
    [doc(p(text("x", [{ type: "strike" }]))), "INVALID_DOCUMENT"],
    [doc(p(text("x", [link("javascript:alert(1)")]))), "INVALID_LINK"],
    [doc(p(text("x", [link("JAVASCRIPT:alert(1)")]))), "INVALID_LINK"],
    [
      doc(p(text("x", [link("data:text/html,<script>1</script>")]))),
      "INVALID_LINK",
    ],
    [doc(p(text("x", [link("/relative/path")]))), "INVALID_LINK"],
    [doc(p(text("x", [link("vbscript:msgbox")]))), "INVALID_LINK"],
    [doc(p({ type: "text", text: "" })), "INVALID_DOCUMENT"],
    [doc(p({ type: "text", text: 42 })), "INVALID_DOCUMENT"],
    [doc(), "INVALID_DOCUMENT"],
    [{ type: "paragraph" }, "INVALID_DOCUMENT"],
    ["<p>html</p>", "INVALID_DOCUMENT"],
    [doc({ type: "bulletList", content: [] }), "INVALID_DOCUMENT"],
    [
      doc({ type: "bulletList", content: [p(text("not an item"))] }),
      "INVALID_DOCUMENT",
    ],
    [doc(p(text("x".repeat(RICH_LIMITS.text + 1)))), "DOCUMENT_TOO_LARGE"],
    [
      doc(...Array.from({ length: RICH_LIMITS.nodes + 1 }, () => p())),
      "DOCUMENT_TOO_LARGE",
    ],
  ] as const)
    assert.throws(
      () => normalizeDoc(input),
      { code },
      JSON.stringify(input).slice(0, 80),
    );
  // Nesting deeper than four levels is refused.
  let deep: unknown = p(text("deep"));
  for (let i = 0; i < RICH_LIMITS.depth; i++)
    deep = { type: "blockquote", content: [deep] };
  assert.throws(() => normalizeDoc(doc(deep)), { code: "INVALID_DOCUMENT" });
  // Exactly four levels is allowed.
  let ok: unknown = p(text("ok"));
  for (let i = 0; i < RICH_LIMITS.depth - 1; i++)
    ok = { type: "blockquote", content: [ok] };
  normalizeDoc(doc(ok));
  // mailto and http links are accepted and normalised.
  assert.equal(
    (
      normalizeDoc(doc(p(text("mail", [link("mailto:help@relay.test")]))))
        .content[0] as any
    ).content[0].marks[0].attrs.href,
    "mailto:help@relay.test",
  );
});

test("images refer to an attachment id, never a URL, and are limited per message", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.deepEqual(
    normalizeDoc(
      doc(
        {
          type: "image",
          attrs: {
            attachmentId: id.toUpperCase(),
            alt: "  Setup screen  ",
            src: "https://evil.test/x.png",
            title: "t",
          },
        },
        p(text("after")),
      ),
    ),
    doc(
      { type: "image", attrs: { attachmentId: id, alt: "Setup screen" } },
      p(text("after")),
    ),
  );
  for (const attrs of [
    { src: "https://evil.test/x.png" },
    { attachmentId: "../../etc" },
    { attachmentId: 42 },
    {},
  ])
    assert.throws(() => normalizeDoc(doc({ type: "image", attrs })), {
      code: "INVALID_DOCUMENT",
    });
  assert.throws(
    () =>
      normalizeDoc(
        doc(
          ...Array.from({ length: RICH_LIMITS.images + 1 }, () => ({
            type: "image",
            attrs: { attachmentId: id },
          })),
        ),
      ),
    { code: "DOCUMENT_TOO_LARGE" },
  );
  const withImages = normalizeDoc(
    doc(
      { type: "image", attrs: { attachmentId: id, alt: "Screen" } },
      { type: "image", attrs: { attachmentId: id } },
    ),
  );
  assert.equal(plainText(withImages), "[Image: Screen]\n\n[Image]");
  assert.deepEqual(imageIds(withImages), [id]);
  assert.equal(isPlain(withImages), false);
});

test("mentions name a teammate or team by id, with a bounded label and count", () => {
  const m = (attrs: Record<string, unknown>) => ({ type: "mention", attrs });
  assert.deepEqual(
    normalizeDoc(
      doc(
        p(
          text("Hi "),
          m({
            kind: "team",
            id: "billing",
            label: "  Billing  ",
            mentionSuggestionChar: "@",
            href: "x",
          }),
        ),
      ),
    ),
    doc(
      p(text("Hi "), {
        type: "mention",
        attrs: { kind: "team", id: "billing", label: "Billing" },
      }),
    ),
  );
  for (const attrs of [
    { kind: "customer", id: "x" },
    { kind: "teammate", id: "a b" },
    { kind: "teammate" },
  ])
    assert.throws(() => normalizeDoc(doc(p(m(attrs)))), {
      code: "INVALID_DOCUMENT",
    });
  assert.throws(
    () =>
      normalizeDoc(
        doc(
          p(
            ...Array.from({ length: RICH_LIMITS.mentions + 1 }, () =>
              m({ kind: "teammate", id: "ada" }),
            ),
          ),
        ),
      ),
    { code: "DOCUMENT_TOO_LARGE" },
  );
  const withMention = normalizeDoc(
    doc(p(text("cc "), m({ kind: "teammate", id: "ada", label: "Ada" }))),
  );
  assert.equal(plainText(withMention), "cc @Ada");
  assert.equal(isPlain(withMention), false);
});

test("variables exist only in macro bodies and fill as plain text", () => {
  const v = (name: string, fallback = "") => ({
    type: "variable",
    attrs: { name, fallback, extra: 1 },
  });
  const body = doc(
    p(
      text("Hi "),
      v("contact.first_name", "there"),
      text(" from "),
      v("brand.name"),
    ),
  );
  assert.throws(
    () => normalizeDoc(body),
    { code: "INVALID_DOCUMENT" },
    "not in messages",
  );
  assert.throws(
    () => normalizeDoc(doc(p(v("company.name"))), { variables: true }),
    {
      code: "INVALID_DOCUMENT",
    },
  );
  const macro = normalizeDoc(body, { variables: true });
  assert.deepEqual((macro.content[0] as any).content[1], {
    type: "variable",
    attrs: { name: "contact.first_name", fallback: "there" },
  });
  assert.equal(plainText(macro), "Hi {contact.first_name} from {brand.name}");
  const filled = fillVariables(macro, {
    "contact.first_name": "**Jo** <b>",
    "brand.name": "",
  });
  assert.deepEqual((filled.content[0] as any).content, [
    { type: "text", text: "Hi " },
    { type: "text", text: "**Jo** <b>" },
    { type: "text", text: " from " },
  ]);
  assert.equal(plainText(fillVariables(macro, {})), "Hi there from");
  assert.doesNotThrow(() =>
    normalizeDoc(fillVariables(macro, { "brand.name": "Relay" })),
  );
});

test("the plain-text fallback keeps structure and link destinations", () => {
  const rich = normalizeDoc(
    doc(
      p(
        text("Hi "),
        text("Ada", [{ type: "bold" }]),
        { type: "hardBreak" },
        text("see "),
        text("docs", [link("https://relay.test/docs")]),
      ),
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [p(text("one"))] },
          { type: "listItem", content: [p(text("two"))] },
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 4 },
        content: [{ type: "listItem", content: [p(text("four"))] }],
      },
      { type: "blockquote", content: [p(text("quoted"))] },
      { type: "codeBlock", content: [text("npm test")] },
      p(text("https://relay.test", [link("https://relay.test")])),
    ),
  );
  assert.equal(
    plainText(rich),
    [
      "Hi Ada\nsee docs (https://relay.test/docs)",
      "- one\n- two",
      "4. four",
      "> quoted",
      "npm test",
      "https://relay.test",
    ].join("\n\n"),
  );
  assert.equal(isPlain(rich), false);
  assert.equal(
    isPlain(normalizeDoc(doc(p(text("just text")), p(text("two lines"))))),
    true,
  );
});

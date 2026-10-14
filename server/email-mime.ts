/**
 * Building an outgoing email (phase 12, step E3; docs/OMNICHANNEL_STEP3.md): every message is
 * multipart/alternative, plain text first and HTML second, so every HTML mail has a plain-text
 * alternative; attachments make it multipart/mixed around that. Headers are folded and encoded
 * (RFC 2047) here, so no caller writes a header by hand, and no value can break a line.
 */
export type Mailbox = { address: string; name?: string };
export type OutgoingFile = { name: string; mime: string; bytes: Uint8Array };
export type OutgoingEmail = {
  from: Mailbox;
  to: Mailbox;
  /** E4: copied in (shown to everyone). Blind copies are never written into the message. */
  cc?: Mailbox[];
  replyTo?: Mailbox;
  subject: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  date?: Date;
  text: string;
  html: string;
  attachments?: OutgoingFile[];
  /** Extra headers (Auto-Submitted on away emails). Names must be plain tokens. */
  headers?: Record<string, string>;
};

const encoder = new TextEncoder();
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const NO_BREAKS = (v: string) => v.replace(/[\r\n\t]+/g, " ").trim();

function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Base64 in lines of 76, as MIME wants. */
function base64Lines(bytes: Uint8Array) {
  return (base64(bytes).match(/.{1,76}/g) ?? [""]).join("\r\n");
}
/** A header word: as it is when plain ASCII, else UTF-8 encoded words of at most 75 characters. */
export function encodeWord(value: string) {
  const v = NO_BREAKS(value);
  if (ASCII_PRINTABLE.test(v)) return v;
  const words: string[] = [];
  let chunk = "";
  // Whole characters per word (a word may not split a UTF-8 sequence): 45 bytes encode to 60.
  for (const ch of v) {
    if (encoder.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64(encoder.encode(w))}?=`).join("\r\n ");
}
const SAFE_ADDRESS = /^[^\s<>()",;:\\@]+@[^\s<>()",;:\\@]+$/;
export function mailbox(m: Mailbox) {
  if (!SAFE_ADDRESS.test(m.address)) throw new Error("Not an email address.");
  const name = NO_BREAKS(m.name ?? "");
  if (!name) return m.address;
  // A plain name is quoted (escaping quotes and backslashes); anything else is an encoded word.
  const shown = ASCII_PRINTABLE.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodeWord(name);
  return `${shown} <${m.address}>`;
}
const msgId = (id: string) => {
  const bare = id.replace(/^<|>$/g, "");
  if (!/^[^\s<>]+@[^\s<>]+$/.test(bare)) throw new Error("Not a Message-ID.");
  return `<${bare}>`;
};
/** A header line: only folds made here (CRLF then a space) may break it, and no line passes 998. */
function header(name: string, value: string) {
  const line = `${name}: ${value}`;
  if (/\r(?!\n )|(?<!\r)\n/.test(line)) throw new Error(`The ${name} header has a line break.`);
  if (line.split("\r\n").some((l) => l.length > 998)) throw new Error(`The ${name} header is too long.`);
  return line;
}
function boundary() {
  return "relay-" + crypto.randomUUID().replace(/-/g, "");
}
/** A filename parameter: quoted ASCII, or RFC 2231 UTF-8 when it isn't. */
function filenameParam(name: string) {
  const clean = NO_BREAKS(name).replace(/[\\/]/g, "_").slice(0, 150) || "attachment";
  if (ASCII_PRINTABLE.test(clean)) return `filename="${clean.replace(/(["\\])/g, "\\$1")}"`;
  return `filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/** The raw message, CRLF line endings throughout. */
export function buildEmail(m: OutgoingEmail): Uint8Array {
  const lines: string[] = [
    header("From", mailbox(m.from)),
    header("To", mailbox(m.to)),
    ...(m.cc?.length ? [header("Cc", m.cc.map(mailbox).join(",\r\n "))] : []),
    ...(m.replyTo ? [header("Reply-To", mailbox(m.replyTo))] : []),
    header("Subject", encodeWord(m.subject || "(no subject)")),
    header("Date", (m.date ?? new Date()).toUTCString().replace("GMT", "+0000")),
    header("Message-ID", msgId(m.messageId)),
    ...(m.inReplyTo ? [header("In-Reply-To", msgId(m.inReplyTo))] : []),
    ...(m.references?.length ? [header("References", m.references.slice(-10).map(msgId).join("\r\n "))] : []),
    ...Object.entries(m.headers ?? {}).map(([k, v]) => {
      if (!/^[A-Za-z][A-Za-z0-9-]{0,60}$/.test(k)) throw new Error("Not a header name.");
      return header(k, encodeWord(v));
    }),
    "MIME-Version: 1.0",
  ];
  const alt = boundary();
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(encoder.encode(m.text.replace(/\r?\n/g, "\r\n"))),
    `--${alt}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(encoder.encode(m.html)),
    `--${alt}--`,
  ];
  if (!m.attachments?.length) return encoder.encode([...lines, ...alternative, ""].join("\r\n"));
  const mixed = boundary();
  const body = [
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    ...alternative,
    ...m.attachments.flatMap((a) => [
      `--${mixed}`,
      `Content-Type: ${/^[a-z]+\/[a-z0-9.+-]+$/i.test(a.mime) ? a.mime : "application/octet-stream"}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; ${filenameParam(a.name)}`,
      "",
      base64Lines(a.bytes),
    ]),
    `--${mixed}--`,
  ];
  return encoder.encode([...lines, ...body, ""].join("\r\n"));
}

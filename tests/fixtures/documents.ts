import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";

/**
 * Test documents built in code (phase 07, C1a), so the fixtures are readable and nothing binary
 * is committed: PDFs with real text, an image-only PDF (no text layer), a password-protected PDF,
 * and a Word document.
 */

/** A PDF with one page per string, written with Helvetica so pdf.js extracts the text. */
export function textPdf(
  pages: string[],
  options: { encryptWith?: string } = {},
) {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;
  const catalog = add("");
  const pagesId = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const text of pages) {
    const lines = text.split("\n");
    const stream =
      "BT /F1 12 Tf 72 720 Td 14 TL " +
      lines
        .map((l) => `(${l.replace(/[\\()]/g, (c) => "\\" + c)}) '`)
        .join(" ") +
      " ET";
    const content = add(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let trailerExtra = "";
  const id = "0123456789abcdef0123456789abcdef";
  if (options.encryptWith) {
    const encrypt = add(standardEncryption(options.encryptWith, id));
    trailerExtra = ` /Encrypt ${encrypt} 0 R /ID [<${id}> <${id}>]`;
  }
  return assemble(objects, catalog, trailerExtra);
}

/** A PDF whose only page is a drawn image: there is no text layer to extract. */
export function imageOnlyPdf() {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;
  const catalog = add("");
  const pagesId = add("");
  const pixels = "ff0000";
  const image = add(
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${pixels.length + 1} >>\nstream\n${pixels}>\nendstream`,
  );
  const draw = "q 200 0 0 200 100 500 cm /Im1 Do Q";
  const content = add(
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
  );
  const page = add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${image} 0 R >> >> /Contents ${content} 0 R >>`,
  );
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
  return assemble(objects, catalog, "");
}

function assemble(objects: string[], root: number, trailerExtra: string) {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** The PDF standard security handler, revision 2 (40-bit RC4), with a user password set. */
function standardEncryption(userPassword: string, idHex: string) {
  const PAD = Buffer.from(
    "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
    "hex",
  );
  const pad = (pw: string) =>
    Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);
  const ownerKey = createHash("md5")
    .update(pad("owner-" + userPassword))
    .digest()
    .subarray(0, 5);
  const O = rc4(ownerKey, pad(userPassword));
  const P = -44;
  const p = Buffer.alloc(4);
  p.writeInt32LE(P);
  const key = createHash("md5")
    .update(Buffer.concat([pad(userPassword), O, p, Buffer.from(idHex, "hex")]))
    .digest()
    .subarray(0, 5);
  const U = rc4(key, PAD);
  return `<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${P} >>`;
}
function rc4(key: Uint8Array, data: Uint8Array) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

/** A minimal Word document: paragraphs, one with a tab and a line break. */
export function wordDocument(paragraphs: string[]) {
  const escape = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = paragraphs
    .map((p) => {
      const runs = p
        .split("\t")
        .map(
          (part) =>
            `<w:r><w:t xml:space="preserve">${escape(part)}</w:t></w:r>`,
        )
        .join("<w:r><w:tab/></w:r>");
      return `<w:p>${runs}</w:p>`;
    })
    .join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

/** The EICAR test string: harmless, and flagged by every scanner (including the local fake). */
export const EICAR_TEXT =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** A 1×1 PNG. */
export const PNG_PIXEL = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

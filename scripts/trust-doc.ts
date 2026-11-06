import { writeFileSync } from "node:fs";
import { trustDocument } from "../lib/encryption";

/** Writes docs/TRUST.md from the subprocessors (lib/processors.ts) and encryption registry (lib/encryption.ts). */
writeFileSync("docs/TRUST.md", trustDocument());
console.log("Wrote docs/TRUST.md");

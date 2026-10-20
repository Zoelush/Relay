import { writeFileSync } from "node:fs";
import { apiReferenceMarkdown } from "../lib/api-reference";
import { SPEC } from "../lib/api-spec";

/** Writes the API's reference and its machine-readable spec from `lib/api-spec.ts` (phase 15, D1). */
writeFileSync("docs/API.md", apiReferenceMarkdown());
writeFileSync("docs/openapi.json", JSON.stringify(SPEC, null, 2) + "\n");
console.log("wrote docs/API.md and docs/openapi.json");

import { mkdirSync, writeFileSync } from "node:fs";
import { apiReferenceMarkdown } from "../lib/api-reference";
import { SPEC } from "../lib/api-spec";
import { jsSdk, jsTypes, pythonSdk } from "../lib/api-sdk";

/** Writes everything derived from the API's spec (phase 15): the reference, the spec as JSON, and the SDKs. */
writeFileSync("docs/API.md", apiReferenceMarkdown());
writeFileSync("docs/openapi.json", JSON.stringify(SPEC, null, 2) + "\n");
mkdirSync("sdk/javascript", { recursive: true });
mkdirSync("sdk/python", { recursive: true });
writeFileSync("sdk/javascript/relay.mjs", jsSdk());
writeFileSync("sdk/javascript/relay.d.ts", jsTypes());
writeFileSync("sdk/python/relay.py", pythonSdk());
console.log("wrote docs/API.md, docs/openapi.json, sdk/javascript/relay.mjs, relay.d.ts and sdk/python/relay.py");

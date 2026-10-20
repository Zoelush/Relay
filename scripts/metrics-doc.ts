import { writeFileSync } from "node:fs";
import { metricsDocument } from "../lib/metrics";

/** Writes docs/METRICS.md from the metric dictionary (lib/metrics.ts). */
writeFileSync("docs/METRICS.md", metricsDocument());
console.log("Wrote docs/METRICS.md");

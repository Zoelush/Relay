import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
// The customer portal: a small same-origin page (portal/portal.tsx) served by server/assets.ts.
await mkdir("public/portal", { recursive: true });
await build({
  entryPoints: ["portal/portal.tsx"],
  outdir: "public/portal",
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["es2020"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile("portal/index.html", "public/portal/index.html");
await copyFile("portal/portal.css", "public/portal/portal.css");
const size = gzipSync(await readFile("public/portal/portal.js"), { level: 9 }).length;
console.log(`Portal built; ${size} bytes gzip.`);

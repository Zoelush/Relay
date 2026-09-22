import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
await build({
  entryPoints: ["messenger/frame.tsx"],
  outdir: "public/messenger",
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["es2020"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const size = gzipSync(await readFile("public/messenger/loader.js"), {
  level: 9,
}).length;
if (size >= 15000)
  throw new Error(`Loader budget exceeded: ${size} bytes gzip`);
console.log(`Messenger built; loader ${size} bytes gzip (budget <15,000).`);

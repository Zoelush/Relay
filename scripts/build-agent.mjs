import { build } from "esbuild";
await build({
  entryPoints: ["agent/entry.tsx"],
  outdir: "public/agent",
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["es2020"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
console.log("Local agent inbox built.");

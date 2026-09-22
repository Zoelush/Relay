// Private ClamAV adapter. Missing/stale signatures and engine errors fail closed.
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
const token = process.env.SCAN_SERVICE_TOKEN;
if (!token || token.length < 32)
  throw new Error("Configure the private scanner service token.");
async function currentSignatures() {
  for (const name of ["daily.cld", "daily.cvd"])
    try {
      const file = await stat("/var/lib/clamav/" + name);
      if (Date.now() - file.mtimeMs < 48 * 3600000) return true;
    } catch {}
  return false;
}
const server = createServer(async (req, res) => {
  const expected = Buffer.from("Bearer " + token),
    provided = Buffer.from(req.headers.authorization ?? "");
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/scan") {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!(await currentSignatures())) {
    res.writeHead(503);
    res.end("Scanner signatures unavailable");
    return;
  }
  let directory;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    }
    directory = await mkdtemp(join(tmpdir(), "relay-scan-"));
    const file = join(directory, "upload");
    await writeFile(file, Buffer.concat(chunks), { mode: 0o600 });
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/clamscan",
        [
          "--no-summary",
          "--max-filesize=10M",
          "--max-scansize=20M",
          "--alert-exceeds-max=yes",
          file,
        ],
        { stdio: "ignore", shell: false },
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Scan timeout"));
      }, 80000);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (code !== 0 && code !== 1) throw new Error("Scanner engine unavailable");
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ verdict: code === 0 ? "clean" : "infected" }));
  } catch {
    if (!res.headersSent) res.writeHead(503);
    res.end("Scanner unavailable");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");

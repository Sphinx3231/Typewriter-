// Serves the test pages on http://127.0.0.1:4174 (chrome.debugger can't attach to file:// pages by default).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "fixtures");
createServer(async (req, res) => {
  const name = (req.url ?? "/").split("?")[0].replace(/^\/+/, "") || "target.html";
  if (!/^[\w-]+\.html$/.test(name)) return res.writeHead(404).end();
  try {
    const body = await readFile(resolve(dir, name));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(4174, "127.0.0.1");

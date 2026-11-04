// SPDX-License-Identifier: AGPL-3.0-only
// Serves the browser test page from this folder. Static files only, no caching, localhost.
// The page needs an http(s) origin (not file://) for ES modules and WebCrypto.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8097);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

createServer(async (req, res) => {
  let path = new URL(req.url, "http://localhost").pathname;
  if (path === "/") path = "/index.html";
  // The synthetic sample family, from the tests' own fixture, so there is one copy of it.
  if (path === "/sample/rivera-export.json") {
    res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
    return res.end(await readFile(join(here, "..", "test", "fixtures", "rivera-export.json")));
  }
  const file = normalize(join(here, path));
  if (!file.startsWith(here)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`test page on http://localhost:${PORT}`));

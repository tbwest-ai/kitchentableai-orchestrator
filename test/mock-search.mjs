// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for https://websearch.tinfoil.sh/mcp, Tinfoil's confidential web search server, for
// local runs and tests. It speaks the one request the orchestrator makes (a stateless MCP
// `tools/call` of `search`), checks for a bearer token, and answers with two made-up results in
// the shape Tinfoil documents, as JSON or, with MOCK_SEARCH_SSE=1, as a server-sent event stream.
// GET /last returns the last request it was sent (the arguments and the two safety headers), so a
// test can assert that no name left. It never calls anything. It is not Tinfoil and searches nothing.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8082);
const AS_SSE = process.env.MOCK_SEARCH_SSE === "1";
let last = null;

const RESULTS = [
  { title: "Mock result one", url: "https://www.mock-one.example/story", content: "A made-up excerpt for a local run. Nothing here came from the web.", published_date: "2026-11-08T12:00:00Z" },
  { title: "Mock result two", url: "https://mock-two.example/page", content: "A second made-up excerpt." },
];

const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return json(200, { status: "ok" });
    if (req.method === "GET" && req.url === "/last") return json(200, last);
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404);
      return res.end();
    }
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || auth.length < 12) return json(401, { error: { message: "You didn't provide an API key.", type: "invalid_request_error", param: null, code: "missing_api_key" } });
    let body;
    try {
      body = JSON.parse(data);
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const args = body?.params?.arguments ?? {};
    last = {
      authorization_present: true,
      accept: req.headers.accept ?? null,
      pii_check: req.headers["x-tinfoil-tool-pii-check"] ?? null,
      injection_check: req.headers["x-tinfoil-tool-injection-check"] ?? null,
      method: body?.method ?? null,
      tool: body?.params?.name ?? null,
      arguments: args,
    };
    if (body?.method !== "tools/call" || body?.params?.name !== "search" || typeof args.query !== "string") {
      return json(200, { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: "only tools/call of search is mocked" } });
    }
    const results = /\bnothing\b/i.test(args.query) ? [] : RESULTS.slice(0, args.max_results ?? 8);
    const payload = { results, pii_checked: last.pii_check === "true", pii_masked: false, redacted_query: args.query, pii_redactions: [], pii_filter_requests: 1 };
    const answer = { jsonrpc: "2.0", id: body.id ?? 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } };
    if (AS_SSE) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
    }
    return json(200, answer);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock search on 127.0.0.1:${PORT}${AS_SSE ? " (event stream)" : ""}`));

// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for https://inference.tinfoil.sh/v1/chat/completions, for local runs and tests.
// It checks for a bearer token, echoes back a glm-5-3-shaped completion (or, for the judge model,
// a verdict that clears the reply), and keeps the last request body per kind at GET /last and
// GET /last-judge so a test can assert what the orchestrator sent (model, effort, page). Offered the
// search tool and asked to look something up, it asks for a search, and it answers from results.
// It never calls anything. It is not Tinfoil and proves nothing about enclaves.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8081);
let last = null;
let lastJudge = null;

const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (req.method === "GET" && (req.url === "/last" || req.url === "/last-judge")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(req.url === "/last" ? last : lastJudge));
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      return res.end();
    }
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || auth.length < 12) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "missing bearer token" } }));
    }
    let body;
    try {
      body = JSON.parse(data);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const isSafeguard = /safeguard/.test(body.model ?? "");
    // The one question before a parent alert (lib/alert.mjs): the mock always answers that the
    // trouble is not at home.
    const isHomeCheck = isSafeguard && /^You check one thing/.test(body.messages?.[0]?.content ?? "");
    const isJudge = isSafeguard && !isHomeCheck;
    if (isJudge) lastJudge = { authorization_present: true, body };
    else if (!isHomeCheck) last = { authorization_present: true, body };
    const userMessage = body.messages?.findLast((m) => m.role === "user")?.content ?? "";
    // Web search, for a local run. When the request offers the search tool and the message asks to
    // look something up, ask for one search with the message's first line as the words. When the
    // request carries results (a tool message, or the frame next to the message), answer and cite.
    const offersSearch = !isJudge && Array.isArray(body.tools) && body.tools.some((t) => t?.function?.name === "search") && body.tool_choice !== "none";
    const hasResults = Boolean(body.messages?.some((m) => m.role === "tool")) || /\nSEARCH RESULTS\n/.test(userMessage);
    const wantsSearch = offersSearch && !hasResults && /\b(?:look up|search|latest|today|tonight|score|weather|news)\b/i.test(userMessage);
    const content = isHomeCheck
      ? JSON.stringify({ home: "no" })
      : isJudge
        ? JSON.stringify({ message: "ok", reply: "ok", topic: "a mock exchange", why: "mock verdict" })
        : hasResults
        ? "Mock answer from the search results [1]."
        : `Mock reply: I received ${userMessage.length} characters and all is well.`;
    const completion = {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "glm-5-3",
      choices: [
        {
          index: 0,
          message: wantsSearch
            ? {
                role: "assistant",
                content: "",
                reasoning: null,
                tool_calls: [{ id: "call_mock_1", type: "function", function: { name: "search", arguments: JSON.stringify({ query: userMessage.split("\n")[0].slice(0, 160) }) } }],
              }
            : {
                role: "assistant",
                content,
                reasoning: null,
              },
          finish_reason: wantsSearch ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 16, total_tokens: 58 },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock inference on 127.0.0.1:${PORT}`));

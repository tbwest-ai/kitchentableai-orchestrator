// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for https://inference.tinfoil.sh/v1/chat/completions, for local runs and tests.
// It checks for a bearer token, echoes back a glm-5-3-shaped completion, and keeps the last
// request body at GET /last so a test can assert what the orchestrator sent (model, effort).
// It never calls anything. It is not Tinfoil and proves nothing about enclaves.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8081);
let last = null;

const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/last") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(last));
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
    last = { authorization_present: true, body };
    const userMessage = body.messages?.find((m) => m.role === "user")?.content ?? "";
    const completion = {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "glm-5-3",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `Mock reply: I received ${userMessage.length} characters and all is well.`,
            reasoning: null,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 16, total_tokens: 58 },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock inference on 127.0.0.1:${PORT}`));

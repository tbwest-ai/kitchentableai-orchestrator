// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for the family account's alert address (POST /api/alert), for local runs and tests.
// It takes `{ event, sealed }`, keeps every alert it was sent at GET /all (and the last at
// GET /last), and answers as the account does: 200 { ok: true }. MOCK_ALERT_MODE changes that:
// "missing" answers 404 (the family is not found), "refused" answers 200 { ok: false }, "slow"
// answers after MOCK_ALERT_DELAY_MS, "redirect" answers 308. It checks no signature and sends
// nothing to anyone: it is not the family account.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8083);
const MODE = process.env.MOCK_ALERT_MODE ?? "ok";
const DELAY_MS = Number(process.env.MOCK_ALERT_DELAY_MS ?? 5000);
const all = [];

const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return json(200, { status: "ok", mode: MODE });
    if (req.method === "GET" && req.url === "/all") return json(200, all);
    if (req.method === "GET" && req.url === "/last") return json(200, all.at(-1) ?? null);
    if (req.method !== "POST" || req.url !== "/api/alert") {
      res.writeHead(404);
      return res.end();
    }
    let body;
    try {
      body = JSON.parse(data);
    } catch {
      return json(400, { ok: false });
    }
    all.push({ received_at: new Date().toISOString(), authorization_present: Boolean(req.headers.authorization), body });
    if (MODE === "missing") return json(404, { ok: false });
    if (MODE === "refused") return json(200, { ok: false });
    if (MODE === "redirect") return json(308, {}, { location: "http://127.0.0.1:9/api/alert" });
    if (MODE === "slow") return setTimeout(() => json(200, { ok: true }), DELAY_MS);
    return json(200, { ok: true });
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock family account (alerts) on 127.0.0.1:${PORT}, mode ${MODE}`));

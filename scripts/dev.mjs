// SPDX-License-Identifier: AGPL-3.0-only
// Local run of the whole spike, no Tinfoil account needed:
//   - a mock inference API on 8081 that answers like glm-5-3 and records what it was sent,
//   - the orchestrator on 8080 with an ephemeral signing key and a dummy API key,
//   - the browser pages on 8097: the check (http://localhost:8097) and the test chat
//     (http://localhost:8097/chat.html); on either, use "Local, unverified".
// Nothing here is a real secret. The mock never reaches the internet.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

const children = [
  spawn(node, [join(root, "test", "mock-inference.mjs")], {
    env: { ...process.env, PORT: "8081" },
    stdio: "inherit",
  }),
  spawn(node, [join(root, "server.mjs")], {
    env: {
      ...process.env,
      PORT: "8080",
      INFERENCE_URL: "http://127.0.0.1:8081/v1/chat/completions",
      TINFOIL_API_KEY: "local-dummy-key-not-real",
      ALLOW_EPHEMERAL_KEY: "1",
    },
    stdio: "inherit",
  }),
  spawn(node, [join(root, "web", "serve.mjs")], {
    env: { ...process.env, PORT: "8097" },
    stdio: "inherit",
  }),
];

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => code && code !== 0 && stop());

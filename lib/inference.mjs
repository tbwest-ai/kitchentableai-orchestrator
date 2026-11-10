// SPDX-License-Identifier: AGPL-3.0-only
// One OpenAI-compatible chat call to Tinfoil's inference API, the only host the container's
// egress allowlist lets it reach. The API key comes from the environment (a Tinfoil-managed
// secret) and is never logged or returned. Neither the prompt nor the reply is ever logged.

export class InferenceError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = "InferenceError";
    this.kind = kind; // "timeout" | "network" | "http" | "parse" | "no_key"
    this.status = status;
  }
}

/** Optional fields a model may refuse with a 400; dropped one at a time and the call retried. */
const OPTIONAL = ["user_cache_secret", "response_format"];

/**
 * Returns infer(body, { timeoutMs }) -> { content, toolCalls, usage, model, finish, ms, dropped }.
 * `toolCalls` is the model's tool calls when the request offered a tool (lib/search.mjs), else [].
 * `fetchImpl` is injectable for tests.
 */
export function makeInference({ url, apiKey, fetchImpl = fetch }) {
  return async function infer(body, { timeoutMs = 60_000 } = {}) {
    if (!apiKey) throw new InferenceError("no_key", "TINFOIL_API_KEY is not set in this container");
    let current = { ...body, stream: false };
    const dropped = [];
    for (;;) {
      const t0 = Date.now();
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(current),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new InferenceError("timeout", `no answer in ${timeoutMs} ms`);
        throw new InferenceError("network", err?.cause?.code ?? err?.cause?.message ?? err?.name ?? "network error");
      }
      let text;
      try {
        text = await res.text();
      } catch (err) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new InferenceError("timeout", `no answer in ${timeoutMs} ms`);
        throw new InferenceError("network", "body not received");
      }
      if (res.status === 400) {
        const drop = OPTIONAL.find((k) => k in current);
        if (drop) {
          const { [drop]: _, ...rest } = current;
          current = rest;
          dropped.push(drop);
          continue;
        }
      }
      if (!res.ok) throw new InferenceError("http", `inference returned HTTP ${res.status}`, res.status);
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new InferenceError("parse", "inference returned a body that is not JSON");
      }
      const choice = j?.choices?.[0];
      return {
        content: String(choice?.message?.content ?? "").trim(),
        toolCalls: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [],
        usage: j?.usage ?? null,
        model: j?.model ?? current.model,
        finish: choice?.finish_reason ?? null,
        ms: Date.now() - t0,
        dropped,
      };
    }
  };
}

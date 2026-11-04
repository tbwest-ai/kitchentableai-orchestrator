// SPDX-License-Identifier: AGPL-3.0-only
// The test chat. Verifies the enclave with Tinfoil's SecureClient, then sends one person's turns
// to /turn over the verified channel (EHBP), checks every reply's envelope and receipt against
// the key /pubkey publishes over that same channel, and says in plain words what the labels say.
// The Agreement, the setup and every conversation stay in this tab's memory. Nothing is written
// to localStorage, sessionStorage or IndexedDB, and nothing goes anywhere but the enclave.

import { SecureClient } from "tinfoil";
import { checkTurn, loadSampleAgreement, sampleSetup } from "./common.js";

const $ = (id) => document.getElementById(id);
const realFetch = window.fetch.bind(window);

const state = {
  doFetch: null,      // client.fetch when verified, plain fetch when local
  base: null,         // the enclave's URL, or http://localhost:8080
  verified: false,
  pubkey: null,
  agreement: null,
  personId: null,
  histories: new Map(), // personId -> [{ role, content }], only turns that were answered
  lastPageSha: new Map(),
  pending: false,
};

// --- small DOM helpers (textContent only: model output is never parsed as HTML) -------------

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
  return e;
}
const status = (id, text, cls = "muted") => {
  $(id).className = `status ${cls}`;
  $(id).textContent = text;
};
const short = (hex) => (hex ? `${hex.slice(0, 12)}…` : "");

// --- 1. connect -----------------------------------------------------------------------------

async function connect() {
  const enclaveURL = $("enclave").value.trim().replace(/\/$/, "");
  const configRepo = $("repo").value.trim();
  status("cstatus", `Verifying ${enclaveURL}…`);
  const t0 = performance.now();
  const client = new SecureClient({ enclaveURL, configRepo, transport: "ehbp" });
  try {
    await client.ready();
    const doc = client.getVerificationDocument();
    if (!doc?.securityVerified) throw new Error("the verifier did not confirm this enclave");
    state.doFetch = client.fetch;
    state.base = client.getEnclaveURL();
    state.verified = true;
    await afterConnect(`Verified in ${Math.round(performance.now() - t0)} ms: release ${doc.releaseTag ?? "?"}, digest ${short(doc.releaseDigest)}.`);
  } catch (err) {
    state.doFetch = null;
    status("cstatus", `Not verified: ${err?.message ?? err}. Nothing was sent.`, "bad");
    refresh();
  }
}

async function connectLocal() {
  state.doFetch = realFetch;
  state.base = "http://localhost:8080";
  state.verified = false;
  await afterConnect("Local and unverified: plain fetch to http://localhost:8080, no attestation.", "warn");
}

async function afterConnect(text, cls = "ok") {
  try {
    const h = await (await state.doFetch(`${state.base}/health`)).json();
    state.pubkey = await (await post("/pubkey", {})).json();
    status("cstatus", `${text} Orchestrator ${h.version}, page ${h.page_version}, signing key ${h.key_source}.`, cls);
  } catch (err) {
    state.doFetch = null;
    status("cstatus", `Connected, but the orchestrator did not answer: ${err?.message ?? err}`, "bad");
  }
  refresh();
}

const post = (path, body) => state.doFetch(`${state.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// --- 2. the Agreement -----------------------------------------------------------------------

function loadAgreement(a, from) {
  if (!a || a.format !== "family-ai-agreement") {
    status("astatus", "That is not a Family AI Agreement export. Run the builder's draft-to-export script on your draft first.", "bad");
    return;
  }
  state.agreement = a;
  state.personId = null;
  state.histories.clear();
  state.lastPageSha.clear();
  $("log").replaceChildren();
  $("pageText").classList.add("hidden");
  const names = a.members.map((m) => m.name).join(", ");
  status("astatus", `${a.familyName || "Your family"} (${from}): ${names}. ${a.completed ? "Completed." : "Not completed yet: the orchestrator will refuse it."}`, a.completed ? "ok" : "warn");
  buildSetup();
  refresh();
}

async function loadSample() {
  try {
    loadAgreement(await loadSampleAgreement(), "the synthetic sample");
  } catch (err) {
    status("astatus", `Could not load the sample: ${err?.message ?? err}`, "bad");
  }
}

function loadText(text, from) {
  try {
    loadAgreement(JSON.parse(text.replace(/^﻿/, "")), from);
  } catch (err) {
    status("astatus", `That is not JSON: ${err?.message ?? err}`, "bad");
  }
}

// --- 3. setup -------------------------------------------------------------------------------

function buildSetup() {
  const sample = state.agreement.familyId === "eed52348-89b4-4208-8def-0247db9358e4" ? sampleSetup().people : {};
  $("tz").value = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  $("aiName").value = "";
  const rows = state.agreement.members.map((m) => {
    const known = sample[m.id] ?? {};
    const pronouns = el("select", { "data-id": m.id, "data-k": "pronouns" }, ...["they", "she", "he"].map((p) => el("option", { value: p }, p)));
    pronouns.value = known.pronouns ?? "they";
    const age = el("input", { type: "number", min: "2", max: "120", "data-id": m.id, "data-k": "age", placeholder: "optional" });
    if (known.age) age.value = String(known.age);
    return el("tr", {}, el("td", {}, m.name), el("td", {}, m.band), el("td", {}, pronouns), el("td", {}, age));
  });
  $("people").replaceChildren(...rows);
  $("setupCard").classList.remove("hidden");
}

function currentSetup() {
  const people = {};
  for (const input of $("people").querySelectorAll("[data-id]")) {
    const id = input.getAttribute("data-id");
    const k = input.getAttribute("data-k");
    people[id] ??= {};
    if (k === "pronouns") people[id].pronouns = input.value;
    if (k === "age" && input.value) people[id].age = Number(input.value);
  }
  const aiName = $("aiName").value.trim();
  return { format: "kitchentableai-setup", version: 1, timeZone: $("tz").value.trim(), retentionDays: 30, ...(aiName ? { aiName } : {}), people };
}

// --- 4. who, and the page --------------------------------------------------------------------

function buildWho() {
  const chips = state.agreement.members.map((m) =>
    el("button", { class: `chip${m.id === state.personId ? " on" : ""}`, onclick: () => pick(m.id) }, `${m.name} (${m.band})`),
  );
  $("who").replaceChildren(...chips);
}

function pick(id) {
  state.personId = id;
  $("pageText").classList.add("hidden");
  renderLog();
  refresh();
  $("msg").focus();
}

async function seePage() {
  const pre = $("pageText");
  pre.classList.remove("hidden");
  pre.textContent = "Asking the enclave for the compiled page…";
  try {
    const r = await post("/page", { agreement: state.agreement, setup: currentSetup(), personId: state.personId });
    const body = await r.json();
    if (!r.ok || !body.ok) {
      pre.textContent = `The orchestrator refused: ${body.error ?? `HTTP ${r.status}`}`;
      return;
    }
    const last = state.lastPageSha.get(state.personId);
    const same = last ? (last === body.sha256 ? "This is the page the last reply ran under." : "This page differs from the one the last reply ran under (the setup or the date changed).") : "";
    pre.textContent = `Page ${body.version}, sha256 ${short(body.sha256)}. ${same}\n\n${body.text}`;
  } catch (err) {
    pre.textContent = `Could not fetch the page: ${err?.message ?? err}`;
  }
}

// --- the chat ----------------------------------------------------------------------------------

/** What the labels in a signed envelope say, in plain words. No words of the chat are in it. */
function describe(env, check, timing) {
  const out = [];
  out.push(`Model ${env.model ?? "none"}${env.fallback_used ? " (the fallback: the main model did not answer)" : ""}; page ${env.page?.version ?? "–"} ${short(env.page?.sha256)}.`);
  const j = env.judge;
  if (!j) out.push("No judge: an adult's reply is not held.");
  else if (j.result === "skipped_crisis") out.push("Judge skipped: a crisis never waits for the judge.");
  else if (j.result === "gave_up") out.push(`Judge gave up after ${j.attempts} tries (${(j.failures ?? []).join(", ")}); nothing was shown.`);
  else out.push(`Judge ${j.result}: message "${j.message}", reply "${j.reply}", ${j.attempts} ${j.attempts === 1 ? "try" : "tries"}, ${j.ms} ms.`);
  const f = env.floor ?? {};
  if (f.out_of_hours) out.push("Out of hours: no model was asked.");
  if (f.crisis) out.push(`Crisis ${f.crisis.kind}, found by the ${f.crisis_source === "judge" ? "judge" : `regex ("${f.crisis.label}")`}.`);
  if (f.added?.length) out.push(`The floor added: ${f.added.join(", ")}.`);
  if (f.homework_reminder) out.push("The homework reminder went with the message.");
  if (f.honesty?.length) out.push(`The honesty check corrected: ${f.honesty.join(", ")}.`);
  out.push(env.alert?.wanted ? "A parent alert is wanted; this build does not deliver alerts yet." : "No parent alert.");
  const u = env.usage?.chat;
  if (u) out.push(`Tokens: ${u.prompt_tokens} in${u.prompt_tokens_details?.cached_tokens ? ` (${u.prompt_tokens_details.cached_tokens} cached)` : ""}, ${u.completion_tokens} out.`);
  if (timing) out.push(`${timing.total_ms} ms inside the enclave (model ${timing.model_ms ?? "–"}, judge ${timing.judge_ms ?? "–"}).`);
  out.push(check ? (check.ok ? `Envelope and receipt verified with the enclave's key (${check.keySource}).` : `SIGNATURE CHECK FAILED: ${check.notes.join("; ")}`) : "Signatures not checked in this browser.");
  return out;
}

const OUTCOME = {
  cleared: "checked by the judge",
  replaced: "replaced by the judge",
  gave_up: "not answered",
  crisis: "crisis help",
  crisis_out_of_hours: "crisis help, out of hours",
  crisis_no_model: "crisis help, no model",
  out_of_hours: "out of hours",
  adult: "an adult's reply",
};

function renderLog() {
  const items = (state.histories.get(state.personId) ?? []).flatMap((t) => t.view ?? []);
  $("log").replaceChildren(...items);
  window.scrollTo({ top: document.body.scrollHeight });
}

function push(turn) {
  const h = state.histories.get(state.personId) ?? [];
  h.push(turn);
  state.histories.set(state.personId, h);
  renderLog();
}

async function send(text) {
  const message = (text ?? $("msg").value).trim();
  if (!message || state.pending) return;
  const personId = state.personId;
  const history = (state.histories.get(personId) ?? []).filter((t) => t.role).map(({ role, content }) => ({ role, content }));
  state.pending = true;
  refresh();
  status("sstatus", "Waiting for the reply…");
  if (text === undefined) $("msg").value = "";
  const mine = { view: [el("div", { class: "msg me" }, message)] };
  push(mine);
  try {
    const r = await post("/turn", { agreement: state.agreement, setup: currentSetup(), personId, history, message });
    const body = await r.json();
    if (!r.ok || !body.ok) {
      mine.view.push(el("div", { class: "msg note" }, `Not sent to a model: ${body.error ?? `HTTP ${r.status}`}`));
      renderLog();
      status("sstatus", body.failed_closed ? "The orchestrator failed closed: fix the Agreement or the setup and try again." : "", "bad");
      return;
    }
    let check = null;
    try {
      check = await checkTurn(body, state.pubkey);
    } catch {}
    const env = check?.envelope ?? JSON.parse(body.envelope.payload);
    if (env.page?.sha256) state.lastPageSha.set(personId, env.page.sha256);
    const judged = body.outcome === "cleared" || body.outcome === "replaced";
    const meta = el("div", { class: "meta" }, `${OUTCOME[body.outcome] ?? body.outcome}${judged ? ", held until checked" : ""} · ${check?.ok ? "signed" : check ? "SIGNATURE FAILED" : "unsigned here"}`);
    if (body.retry) meta.append(el("button", { onclick: () => send(message) }, "Send again"));
    const labels = el("details", {}, el("summary", {}, "What the labels say"), el("ul", {}, ...describe(env, check, body.timing).map((l) => el("li", {}, l))));
    const bubble = el("div", { class: "msg ai" }, body.reply, meta, labels);
    if (body.retry) {
      // Not answered: the message is kept for a resend and stays out of the history.
      mine.view.push(bubble);
      renderLog();
    } else {
      Object.assign(mine, { role: "user", content: message });
      push({ role: "assistant", content: body.reply, view: [bubble] });
    }
    status("sstatus", "");
  } catch (err) {
    mine.view.push(el("div", { class: "msg note" }, `Could not reach the enclave: ${err?.message ?? err}`));
    renderLog();
    status("sstatus", "", "bad");
  } finally {
    state.pending = false;
    refresh();
  }
}

// --- wiring -------------------------------------------------------------------------------------

function refresh() {
  const ready = Boolean(state.doFetch && state.agreement);
  $("whoCard").classList.toggle("hidden", !state.agreement);
  if (state.agreement) buildWho();
  const canChat = ready && state.personId && !state.pending;
  $("msg").disabled = !canChat;
  $("send").disabled = !canChat;
  $("seePage").disabled = !(ready && state.personId);
  $("clear").disabled = !state.personId;
  const who = state.agreement?.members.find((m) => m.id === state.personId);
  $("msg").placeholder = !state.doFetch ? "Connect first" : !state.agreement ? "Load an Agreement" : !who ? "Pick who is chatting" : `Write as ${who.name}`;
}

$("connect").onclick = connect;
$("local").onclick = connectLocal;
$("sample").onclick = loadSample;
$("loadPaste").onclick = () => loadText($("paste").value, "pasted");
$("file").onchange = async (e) => {
  const f = e.target.files?.[0];
  if (f) loadText(await f.text(), f.name);
  e.target.value = "";
};
$("seePage").onclick = seePage;
$("clear").onclick = () => {
  state.histories.delete(state.personId);
  renderLog();
};
$("send").onclick = () => send();
$("msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
refresh();

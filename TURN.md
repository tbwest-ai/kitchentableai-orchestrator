# One turn, end to end (v0.2.0)

Phase 1's first slice: a person's message in, the reply they may see out, compiled from their
family's real Agreement, with the deterministic floor around the model and, for a kid, an
independent judge holding the reply. Everything here runs inside the attested container; the
only host it can reach is `inference.tinfoil.sh`.

## The request

`POST /turn`, JSON:

```json
{
  "agreement": { "format": "family-ai-agreement", "version": 1, "...": "the builder's export" },
  "setup":     { "format": "kitchentableai-setup", "version": 1, "timeZone": "America/New_York", "...": "" },
  "personId":  "id3",
  "history":   [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "message":   "What is 7 times 8?"
}
```

- **`agreement`** is the Family AI Agreement builder's declared export, version 1, exactly as the
  builder's `exportAgreement(draft)` writes it. The builder resolved every person's rules, custom
  rules, AI settings and hours already; this service reads them and checks every row id against
  the content model in `agreement/content-model.json`.
- **`setup`** is what the builder does not collect and the product's "Finish setting up the AI"
  step will: the family's **time zone** (required: hours cannot be held without it), an optional
  name for the AI and who chose it, how many days chats are kept (default 30), optional family
  lines (`notSure`, `friend`, `parentsPromise`), the parents' member ids (default: the adults),
  an optional X25519 `familyPublicKey`, and per person `pronouns` (she, he or they; they by
  default), `age`, `homework` (`think-first` or `explain-and-check`; by band by default),
  `homeworkClause`, `webSearch`, `uploads` and `transcripts`.
- **`history`** is the conversation so far, oldest first, kept on the person's device. It is
  trimmed to the last 20 messages and 24,000 characters, and always starts with the person.
- The **clock** is the container's. Nothing in the request can move a kid's hours.
- **`pass`** (since v0.4.0) is the family's pass, below. `/page` takes the same one.

## The lock (v0.4.0)

Only an invited family's device can run a turn or read a page. The family's account (the family
app's server, the control plane) signs a short-lived **pass** for one device, one person and one
exact Agreement and setup, and the device sends it in the request body, inside the encrypted
channel. `lib/access.mjs` checks it against the Ed25519 public keys in the measured config
(`ACCESS_PUBLIC_KEYS`), so anyone can read which account server may admit a family, and this
service holds no secret for it.

```
pass    = base64url(payload JSON) + "." + base64url(Ed25519 signature over the first part's ASCII)
payload = { "v": 1, "aud": "kitchentableai-orchestrator", "fam": "...", "dev": "...", "pid": "id3",
            "ah": "<hex sha256 of canonicalJson({ agreement, setup })>", "iat": 1762300000, "exp": 1762303600 }
```

- **`pid`** is the person: a kid cannot run a parent's page with a kid's pass.
- **`ah`** binds the exact Agreement and setup, so a device cannot edit its own rules. The control
  plane hashes with the same `canonicalJson` (keys sorted, undefined left out).
- A pass lives at most 12 hours (`policy/access-policy.json`); the app asks for a fresh one with
  the Agreement, so a parent's change reaches the device on its next pass.
- A refused pass is a **401 with `failed_closed: true`**, a `code` (`no_pass`, `bad_pass`,
  `bad_signature`, `not_yet`, `expired`, `too_long`, `wrong_person`, `agreement_changed`,
  `locked`) and plain words for the device to show.
- **The synthetic sample family** (`agreement/sample-export.json`, the builder's own Rivera
  fixture) needs no pass, so the public check page and a verifier can still try a turn.
- **Limits**, a cost guard for the founding test: 400 turns a day per family, by the family's own
  date, and 20 a minute per device; the sample family shares 100 a day. Only a turn that would
  reach a model counts. Past a limit the reply says so, and **a crisis past a limit still gets the
  crisis reply, 988 included**. The envelope says which limit (`floor.limited`) and whom the lock
  admitted (`access`: the control plane's opaque family and device ids, or the sample).
- `ACCESS=open` admits anyone. It is for a local run, and for the deployed config until the
  family app issues passes; `/health` reports the mode (`open`, `passes` or `sample-only`) and how
  many keys, so a verifier sees which one is running.
- `scripts/make-access-key.mjs` makes the key pair (the private half goes only in the family
  app's server settings); `scripts/mint-pass.mjs` makes a pass by hand for a test.

## What happens, in order

| Step | What | Floor item |
|---|---|---|
| 1 | The Agreement and setup are validated. Anything missing, malformed, unfinished or unknown is a **422 with `failed_closed: true`**, and no model is called. | 1 |
| 2 | The crisis patterns read the message, before every gate. | 7 |
| 3 | Hours, if the hours setting applies to this person, in the family's time zone. Out of hours: no model; the reply says when the hours start and to ask a parent by first name. A crisis out of hours never reaches it: the crisis check has already answered with the crisis reply, 988 included. | 2 |
| 3b | The lock's limits (since v0.4.0): past the family's daily limit or the device's burst limit, no model; the reply says so. A crisis past a limit has already been answered with the crisis reply. | the lock |
| 4 | The page is compiled (`lib/compile.mjs`, v2, five layers) with today's date. The homework reminder goes next to a schoolwork message. The band's model answers (`policy/model-policy.json`; GLM 5.3 at `low` for every band), with `gpt-oss-120b` as the fallback. | 3, 13, 15 |
| 5 | **A kid's reply is held** until `gpt-oss-safeguard-120b` has labeled the message and the reply. It is **replaced only on a safety label on the reply**: sexual, dangerous, companion drift, secrecy from parents. 3-second timeout, one retry, give up at 6 seconds and ask the kid to send it again. An empty verdict is not cleared. **A crisis never waits for the judge.** Adults are not judged. The judge's label on the message (danger, abuse, self-harm, homework…) is recorded in the envelope and **never adds words to the reply** (since v0.3.2: it read a fire and a school bully as danger and abuse). | judge, decision 18 |
| 6 | The honesty check replaces a false promise ("I'm sending a message to your parent") or a false storage or deletion claim with the true sentence. Then, only when the measured crisis patterns matched the message, the crisis floor adds what the reply is missing: the parents by first name and 988; on abuse, 988 and an adult outside the home, never the parents; on distress, the parents by name. The page itself keeps 988 for self-harm, not wanting to be alive, abuse at home and real danger, sends ordinary trouble (a bully, a bad day) to the parents and a teacher, and sends an emergency happening now to 911. | 7, 9 |
| 7 | The envelope is signed. The topic is sealed to the family's key when the setup carries one. | 14 |

## The response

```json
{
  "ok": true,
  "reply": "That one's for you to work out. Here's a hint: ...",
  "held": true,
  "outcome": "cleared",
  "retry": false,
  "envelope": { "alg": "Ed25519", "payload": "{...}", "signature_b64": "...", "key_source": "attested-key", "key_id": "tinfoil:turn-signing", "public_key_spki_hex": "..." },
  "receipt":  { "alg": "Ed25519", "payload": "{...}", "signature_b64": "...", "...": "" },
  "sealed": null,
  "timing": { "total_ms": 1830, "model_ms": 920, "judge_ms": 880 }
}
```

`outcome` is one of `cleared`, `replaced`, `gave_up` (kid), `crisis`, `crisis_out_of_hours`,
`crisis_no_model`, `out_of_hours`, `adult`.

**The envelope is labels and counts, never words.** It carries the turn id and time, the family's
and person's ids, the band, which page version and page hash, which model and whether the
fallback answered, the outcome, the floor's findings (crisis kind and pattern label, which help
sentences were added, whether the homework reminder went, which honesty corrections were made,
whether it was out of hours), the judge's labels, attempts and milliseconds, whether an alert was
wanted, and token counts. No message, no reply, no page text, no names, and no hash of a message
(a short message's hash can be guessed). The tests check that the envelope of a turn contains none
of the message's or the reply's words.

**The receipt** is a second signature, over the turn id and the reply's SHA-256, for the device
that stores the conversation. It lets a later build check that an assistant turn in `history`
really came from this service.

Every signature is Ed25519 over the exact bytes of `payload`, by the key `/pubkey` publishes and,
since v0.1.2, by the attested key the enclave generated (`key_source: attested-key`).

## Not in this build, and so never claimed by the page

The compiled page only says what this build makes true (`capabilities` in `lib/compile.mjs`, all
off here):

- **No tools.** Tell my parent, my hours, my Agreement and search come in Phase 3. The page says
  the AI cannot send a message to anyone, and the honesty check holds it to that.
- **No parent alerts are delivered.** The envelope says when the family's alert setting wants one;
  nothing sends it yet, so the page does not say a parent is alerted.
- **No attachments, no breaks, no allowances.**
- **No control plane.** The device sends the Agreement with each turn. That means a device could
  send an Agreement of its own making; the product fetches the Agreement from the control plane by
  a short-lived token instead (Phase 2). Until then this instance serves the founder's own family
  through the test chat (`web/chat.html`) and no other.
- **History is trusted as sent.** The receipt makes checking it possible; this build does not yet
  check it.
- **The connectivity check** (`{ "prompt": "..." }`, a raw model call outside the floor) is off in
  the measured config since v0.3.0. Every model call goes through the Agreement.

## The compiled page on request

`POST /page` with `{ agreement, setup, personId }` returns `{ text, sha256, version }`: the page a
turn for that person would run under right now, compiled the same way with today's date, so its
`sha256` is the one the next turn's envelope reports. No model is called. Nothing on the page is
secret from the family (decision 6), and this is what the Control Center's "What the AI is told"
will show. It fails closed exactly as `/turn` does.

## The test chat (v0.3.0)

`web/chat.html`, served by `npm run web` on http://localhost:8097/chat.html, is for the founder's
own family before the product has an app. It verifies the enclave with Tinfoil's SDK, loads an
Agreement export (a file, a paste, or the synthetic sample), asks for the setup the builder does
not collect (time zone, the AI's name, pronouns, ages), and sends one person's turns over the
verified channel. Every reply shows its outcome and, under "What the labels say", the signed
envelope in plain words, with both signatures checked against `/pubkey`. "See what the AI is told"
shows the page from `/page`. The Agreement and the chats live in the tab's memory only: nothing is
written to browser storage. A turn the judge gave up on stays out of the history and can be sent
again. The export comes from the builder's own draft with a script in the builder's repository
(`scripts/draft-to-export.ts`).

## Copy that is a draft

The out-of-hours reply is the founder's (2026-11-04, "Use version A"): "It's outside your AI hours
right now. Your hours today start at 3:30pm. If you need help before then, ask Dana or Marco.",
with "They ended at 7:00pm and start again tomorrow at 3:30pm." after the hours, and no 988.

These sentences are ours and wait on the founder's words: the limit replies (`limitReply` in
`lib/turn.mjs`: "That's all the AI for today. It starts again tomorrow. If you need help before
then, ask Dana or Marco." and "That's a lot of messages in one minute. Wait a moment, then try
again."), the pass refusals (`PASS_ERRORS` in `lib/access.mjs`), the crisis and distress sentences
(`lib/crisis.mjs`), the honesty corrections
(`lib/honesty.mjs`), the judge's replacements and the give-up lines, including the gentler ones on
a secret or on distress (`lib/judge.mjs`), and the
default not-sure and friend lines (`lib/compile.mjs`). The compiled page's own words are the v2
template the founder approved on 2026-10-23 and 2026-11-02, with its band guide and refusal
examples in `agreement/band-guide.json`.

## Where the words come from

`agreement/content-model.json` and `agreement/band-guide.json` are snapshots of the Family AI
Agreement builder's content model and the founder's band guide, taken by a script in the
builder's (private) repository. The snapshot records the commit it came from, and `/health`
reports it, so a page compiled in the enclave can be traced to the words the family saw.

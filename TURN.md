# One turn, end to end (v0.2.0; sealed notes v0.5.0; web search v0.6.0)

Phase 1's first slice: a person's message in, the reply they may see out, compiled from their
family's real Agreement, with the deterministic floor around the model and, for a kid, an
independent judge holding the reply. Everything here runs inside the attested container; the
only hosts it can reach are `inference.tinfoil.sh` and, for web search since v0.6.0,
`websearch.tinfoil.sh`.

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
- **`history`** is the conversation so far in this sitting, oldest first. The family app keeps it
  only in the open page and sends all of it with each turn, so the model and the floor see the
  whole sitting; a new sitting starts empty (since v0.5.2). It is trimmed to the last 100 messages
  and 60,000 characters (about 15,000 tokens), oldest first, and always starts with the person.
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
| 4b | **Web search** (since v0.6.0, below), for a person whose band and switch allow it: the model may ask for one search; names and personal details are taken out in code before it leaves; the results come back as information in a fixed frame; the model answers from them in a call with no tool to use; this service writes the list of sources. Not on a turn the crisis patterns matched. | decision 22 |
| 5 | **A kid's reply is held** until `gpt-oss-safeguard-120b` has labeled the message and the reply. It is **replaced only on a safety label on the reply**: sexual, dangerous, companion drift, secrecy from parents. 3-second timeout, one retry, give up at 6 seconds and ask the kid to send it again. An empty verdict is not cleared. **A crisis never waits for the judge.** Adults are not judged. The judge's label on the message (danger, abuse, self-harm, homework…) is recorded in the envelope and **never adds words to the reply** (since v0.3.2: it read a fire and a school bully as danger and abuse). | judge, decision 18 |
| 6 | The honesty check replaces a false promise ("I'm sending a message to your parent") or a false storage or deletion claim with the true sentence. "This isn't saved" is false only for a kid whose family turned on "Parents can read" (since v0.5.3): an adult's words are never saved, and a kid's are saved only then. Then, only when the measured crisis patterns matched the message, the crisis floor adds what the reply is missing: the parents by first name and 988; on abuse, 988 and an adult outside the home, never the parents; on distress, the parents by name. On abuse at home the floor also takes something out (since v0.5.4): any sentence that sends the kid to a parent, by name, by role ("your mom", "someone in your family", "a grown-up at home") or by saying a parent would want to know, whether the model wrote it or the honesty check did. It runs before the additions, so 988 or a teacher lost with a struck sentence comes back. A message that places the harm outside the home and names nobody in the family ("he hits me at school") keeps the parents. The page itself keeps 988 for self-harm, not wanting to be alive, abuse at home and real danger, sends ordinary trouble (a bully, a bad day) to the parents and a teacher, and sends an emergency happening now to 911. | 7, 9 |
| 7 | The envelope is signed. For a kid, the topic and area, and the chat itself where the family turned transcripts on, are sealed to the family's public half when the setup carries one, and the envelope names each sealed note's SHA-256 (since v0.5.0). | 14 |

## The response

```json
{
  "ok": true,
  "reply": "That one's for you to work out. Here's a hint: ...",
  "sources": [],
  "held": true,
  "outcome": "cleared",
  "retry": false,
  "envelope": { "alg": "Ed25519", "payload": "{...}", "signature_b64": "...", "key_source": "attested-key", "key_id": "tinfoil:turn-signing", "public_key_spki_hex": "..." },
  "receipt":  { "alg": "Ed25519", "payload": "{...}", "signature_b64": "...", "...": "" },
  "sealed": null,
  "transcript": null,
  "timing": { "total_ms": 1830, "model_ms": 920, "search_ms": null, "judge_ms": 880 }
}
```

`outcome` is one of `cleared`, `replaced`, `gave_up` (kid), `crisis`, `crisis_out_of_hours`,
`crisis_no_model`, `out_of_hours`, `adult`.

**The envelope is labels and counts, never words.** It carries the turn id and time, the family's
and person's ids, the band, which page version and page hash, which model and whether the
fallback answered, the outcome, the floor's findings (crisis kind and pattern label, which help
sentences were added, whether a send-to-a-parent sentence was removed on abuse at home (`floor.removed`), whether the homework reminder went, which honesty corrections were made,
whether it was out of hours), the judge's labels, attempts and milliseconds, whether an alert was
wanted, what a web search did in counts and labels (`search`, below), and token counts. No message, no reply, no page text, no names, and no hash of a message
(a short message's hash can be guessed). The tests check that the envelope of a turn contains none
of the message's or the reply's words.

**The sealed notes** (since v0.5.0) are for the family's parent phones and nobody else: X25519
with a fresh ephemeral half per note, HKDF-SHA256 and AES-256-GCM (`lib/seal.mjs`), to the
setup's `familyPublicKey`, whose private half lives only on the family's parent phones.

- `sealed`, for a kid whose turn the judge read: `{ v: 1, id, at, person_id, topic, area }`. The
  topic is the judge's few words, no names; the area is one of `math`, `science`,
  `reading_writing`, `history_world`, `arts`, `games_sports`, `feelings_friends`,
  `health_body`, `tech`, `everyday` (`AREAS` in `lib/judge.mjs`), or null. An unknown area is
  dropped and never costs the verdict. Adults are not judged, so they have none.
- `transcript`, only for a kid whose family turned transcripts on (`setup.people[id].transcripts`):
  `{ v: 1, kind: "chat", id, at, person_id, message, reply }`, the reply as the kid saw it. **Abuse
  at home is never in it**, whether the patterns or the judge saw it: a parent can be the one doing
  it, and the alert for abuse waits on counsel (decision 25). A turn the kid is asked to send again
  is not in it either. An adult's chat never is.
- The envelope's `sealed_sha256` and `transcript_sha256` are each note's SHA-256 over its JSON as
  returned, or null. The envelope's signature covers them, so the family's account can tell the
  service's note from one a device sealed itself (the public half is public). Neither hash is of
  words: the ciphertext is fresh every time.

The device hands the envelope and both notes to the family's account after the turn; the account
checks the signature against `/pubkey`, keeps the labels for the parent dashboard and stores the
notes it cannot open.

**The receipt** is a second signature, over the turn id and the reply's SHA-256, for the device
that stores the conversation. It lets a later build check that an assistant turn in `history`
really came from this service.

Every signature is Ed25519 over the exact bytes of `payload`, by the key `/pubkey` publishes and,
since v0.1.2, by the attested key the enclave generated (`key_source: attested-key`).

## Not in this build, and so never claimed by the page

The compiled page only says what this build makes true (`capabilities` in `lib/compile.mjs`, all
off here):

- **No tools but search.** Tell my parent, my hours and my Agreement come in Phase 3. The page
  says the AI cannot send a message to anyone, and the honesty check holds it to that.
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

## Web search (v0.6.0)

Decided on 2026-10-23 (decision 22) and built on 2026-11-09: off for Under 8 and 8–11, on from
12–14 and for adults, and the family's own per-person switch (`setup.people[id].webSearch`) wins
over the band. The code is `lib/search.mjs`; the limits are `policy/search-policy.json`.

**It is on only in a build whose measured config names a search host** (`SEARCH_URL` in
`tinfoil-config.yml`, which must also be in the egress allowlist). `/health` reports the host. With
none, the page says the AI cannot search in this version, and that is true.

What happens on a turn for a person who has it:

1. **The model decides.** The band's model is offered one tool, `search`, and the page says when to
   use it: the news, the weather, a score, a price, opening hours, or when the person asks to look
   something up. One search a turn; a second request in the same reply is counted and not run.
   **No search on a turn the crisis patterns matched**, distress included.
2. **Names and personal details come out, in code** (`scrubQuery`): every first name in the family,
   the family name, the AI's name, email addresses, phone numbers, street addresses and long
   numbers. The envelope records what was removed by kind. If nothing is left, no search is sent.
   The cost, accepted: a topic that shares a name with someone in the family loses that word
   ("Diego Rivera murals" for the Riveras).
3. **The words go to Tinfoil's search enclave**, `websearch.tinfoil.sh`, as one stateless MCP
   `tools/call`, with Tinfoil's privacy filter and prompt-injection filter both asked for by header
   (`X-Tinfoil-Tool-PII-Check`, `X-Tinfoil-Tool-Injection-Check`). Tinfoil's filter removes emails,
   phone numbers, account numbers and secrets and **leaves names alone**, which is why step 2 is
   ours. That enclave sends the words to Exa, a search company under a no-retention contract.
   **This is the one place a family's words leave attested hardware.** Exa sees the search words
   and the enclave's address, not who asked. Tinfoil describes that protection as a contract, not
   something the hardware proves.
4. **Results are information, never instructions.** Five results at most, 700 characters each,
   cleaned of control and invisible characters. They reach the model inside a fixed frame that says
   what they are (excerpts written by strangers), in a call that has no tool it can use, and
   nothing inside the frame can close it. They never enter the chat history.
5. **This service writes the sources** (`withSources`). The model cites by number; a number that
   names no result is removed; a link the model wrote is replaced by its citation when it is one of
   the results and removed when it is not; a "Sources" list the model wrote is replaced by the real
   one. When the model answered from results and cited none, the first three are listed.
6. **For a kid, the judge reads the reply with its sources**, held whole as on any turn. A replaced
   reply carries no sources. The honesty check reads the reply and not the list (a page title is
   not a claim by the AI).

The reply ends with a plain list, and the same list comes back beside it as `sources`:

```
The Otters won 4 to 2 on Saturday [1]. Their next game is Thursday at home [2].

Sources:
1. Harbor City Otters win 4 to 2 (otters-hockey.example) https://www.otters-hockey.example/recap/1107
2. Otters schedule and results (sports.example.org) https://sports.example.org/otters/schedule
```

**The limit**, a cost guard: 30 searches per family per day by the family's own date, and 10 for
the sample family (Tinfoil's price was $0.05 a search on 2026-11-09). Past it the tool is not
offered, and a note next to the message tells the model to say that search is used up for today.

**The envelope's `search`** is null when search is not on for the person, and otherwise:

```json
{ "offered": true, "asked": 1, "ran": 1, "results": 3, "cited": 2, "removed": ["name"],
  "filter": { "checked": true, "masked": false }, "outcome": "ok", "ms": 1240 }
```

`outcome` is `none` (offered, not used), `ok`, `empty` (nothing found), `failed` (the search did
not come back), `scrubbed_empty` (nothing left to send), `limit`, `crisis` (not offered) or
`unavailable` (the model service refused the request that offered the tool, and the reply was
written without it). `removed` lists kinds (`name`, `email`, `phone`, `address`, `number`), and
`filter` says whether Tinfoil's privacy filter ran and removed anything. **Never the search words,
a title or a link.** `usage.search_answer` counts the second model call.

What this does not do: open a page (search excerpts only), search twice in a turn, or filter
results by site. Tinfoil's search has no safe-search switch; for a kid the protections are the
page, Tinfoil's injection filter and the judge on the final reply.

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

The limit replies open with the founder's words (2026-11-05), and their endings are ours: "You've
reached your daily limit. You can use the AI again tomorrow. If you need help before then, ask Dana
or Marco." (the last sentence for kids only) and "You've exceeded limits. Wait a minute, then try
again." (`limitReply` in `lib/turn.mjs`).

These sentences are ours and wait on the founder's words: the web search sentences on the page
(`searchOnLine` and the search-off line in `lib/compile.mjs`), the search tool's description, the
frame around the results and the two notes (`lib/search.mjs`), the pass refusals (`PASS_ERRORS` in
`lib/access.mjs`), the crisis and distress sentences
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

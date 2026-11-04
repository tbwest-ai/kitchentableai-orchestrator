# KitchenTableAI orchestrator

A small HTTP service that runs inside an attested [Tinfoil container](https://docs.tinfoil.sh/containers/overview).
A family's device sends one person's message with the family's AI Agreement; the service compiles
that person's page, keeps the deterministic floor around the model, holds a kid's reply until an
independent judge has read it, and returns the reply with a signed envelope of labels, never
words. Its source is published under AGPL-3.0 so anyone can check that claim against the image a
browser verifies.

**v0.2.0 is Phase 1's first slice: one turn, end to end, from a real Agreement.** What it does,
in order, what it returns and what it does not do yet is in [TURN.md](TURN.md). The code is in
`lib/`: `agreement.mjs` (the export and setup, failing closed), `compile.mjs` (the page, v2),
`crisis.mjs`, `homework.mjs`, `honesty.mjs` and `hours.mjs` (the floor), `judge.mjs` (the
judge and its tail), `turn.mjs` (the order), `sign.mjs` and `seal.mjs`. Which model answers
each age band is configuration, in `policy/model-policy.json`.

**v0.3.0 adds a test chat for the founder's own family** (`web/chat.html`; TURN.md says what it
does) and `POST /page`, the compiled page on request. The spike's raw connectivity check is off:
every model call now goes through the Agreement, the floor and the judge.

The rest of this README is the go/no-go spike (v0.1.0 to v0.1.2, 2026-10-23 to 2026-11-02), kept
for the record: all three of its exit tests passed on a real instance, and the steps below are how
a release still reaches it.

## The spike: can our own orchestrator run in an enclave a family's browser can verify?

The decision it served was taken on 2026-10-23: the attested orchestrator replaces the plan's
relay, and if the spike had failed the fallback was a launch with a client-built request for
under-12s only. The spike had `/health`, `/turn` (one prompt in, the model's reply plus a
signature out; in v0.2.0 that is the connectivity check) and `/pubkey`.

### The three exit tests

| # | Test | What passing looks like | Where it runs |
|---|------|-------------------------|---------------|
| 1 | **A browser verifies the container and calls it.** | `web/index.html` shows `securityVerified: true`, the measurement, and a reply from `/turn` over the encrypted channel. | The founder's browser, against the deployed instance. |
| 2 | **The container reaches Tinfoil's inference API through an egress allowlist that names only `inference.tinfoil.sh`, with the API key as a Tinfoil-managed secret.** | `/turn` returns `ok: true` with a `glm-5-3` reply. If the allowlist is wrong, `/turn` returns `inference unreachable` with the socket error code. | The deployed instance; checked with `tinfoil http post` and from the page. |
| 3 | **The container signs a reply with a key a client can verify.** | The page shows "signature verified" and `key_source`: `attested-key` if the beta works, otherwise `managed-secret`. | The deployed instance; checked in the page with WebCrypto Ed25519. |

Exit test 2 as written says "reasoning off". GLM 5.3 cannot turn reasoning off: Tinfoil's
docs (read 2026-10-23) say reasoning is always on and `enable_thinking` is not honoured;
`reasoning_effort: "low"` is the floor, and that is what the service sends. `gemma4-31b`
accepts `"none"`. The model and the effort are environment values in `tinfoil-config.yml`,
so changing either is a config release, not a code change.

## What is here

```
lab/cloud-orchestrator/
├── server.mjs                 the service: Node 24, standard library only
├── TURN.md                    one turn: the request, the order, the envelope, what is not built yet
├── lib/                       the compiler, the floor, the judge, the turn, signing and sealing
├── agreement/                 snapshots of the builder's content model and the band guide
├── policy/model-policy.json   which model answers each age band; the judge and its tail
├── package.json, package-lock.json   scripts; two dev dependencies (the tinfoil SDK and esbuild,
│                              pinned exactly) used only to bundle the test page. The image installs nothing.
├── Dockerfile                 digest-pinned node:24.14.1-alpine3.23, runs as `node`
├── .dockerignore              only package.json, server.mjs, lib/, agreement/ and policy/ reach the image
├── tinfoil-config.yml         the measured config: allowlist, env, secret names, shim paths
├── LICENSE                    AGPL-3.0
├── .github/workflows/         for the PUBLIC repository (inert here):
│   ├── build-image.yml          reproducible build, pushes to GHCR, fails if two builds differ
│   ├── tinfoil-release.yml      tags a version and dispatches the publish workflow
│   └── tinfoil-release-publish.yml  measures, attests and publishes (measure-image-action)
├── scripts/
│   ├── dev.mjs                  local run: mock inference + service + both pages
│   ├── build-image.mjs          builds twice with BuildKit and compares the digests
│   └── make-signing-key.mjs     makes the Ed25519 key for the managed-secret fallback
├── test/
│   ├── orchestrator.test.mjs    the HTTP contract: health, pubkey, a turn, the page, the connectivity check, key sources
│   ├── compile.test.mjs, floor.test.mjs, turn.test.mjs, page.test.mjs   the page, each floor item, whole turns, /page
│   ├── helpers.mjs, fixtures/   the builder's own Rivera export, a setup, a scripted model and judge
│   └── mock-inference.mjs       a stand-in for inference.tinfoil.sh (local only)
└── web/
    ├── index.html, app.js       the browser check page (runs the `tinfoil` SDK's verifier)
    ├── chat.html, chat.js       the test chat for the founder's own family (v0.3.0)
    ├── common.js                what both pages share: the sample family, signature checks
    ├── vendor/entry.mjs         what the page bundle exports (SecureClient); the bundle itself is
    │                            built by `npm run bundle-web` and not committed
    └── serve.mjs                serves the pages on http://localhost:8097, and the sample family
```

The public repository is this folder's contents at its root. Its name must not contain the
word this product used to use for the Agreement; `kitchentableai-orchestrator` is the name
used throughout this README.

## Run it locally, no account needed

```bash
cd lab/cloud-orchestrator
npm install     # once: the two dev dependencies that build the page bundle
npm test        # 52 tests: the HTTP contract, the page, every floor item, whole turns
npm run dev     # bundles the page, then: mock inference on 8081, the service on 8080,
                # the pages on http://localhost:8097 (the check) and /chat.html (the test chat)
```

On either page, "Local, unverified" talks to the local service with plain `fetch` (no
attestation, an ephemeral key). On the check page, "Send one turn" sends one message as Maya of
the synthetic sample family and checks both signatures. "Control: verify websearch.tinfoil.sh" runs the real verifier in your browser
against one of Tinfoil's own containers, built with the same release workflow as ours. That
proves the browser side of exit test 1 before anything is deployed: on 2026-10-23, from the
desktop app's Chromium, it verified in 799 ms with all five steps green and one host
contacted. "Check Ed25519 support" tells you whether this browser's WebCrypto can verify the
signature at all.

The page loads the SDK from `web/vendor/tinfoil.js`, bundled from the pinned dev dependency
(a CDN import of the package was tried first and failed in the browser on a dependency's
version range). Production will bundle the SDK the same way.

## How a browser verifies a container (what the SDK actually does)

Read from the `tinfoil` npm package, version 1.3.0 (published 2026-10-21), and tried against
`websearch.tinfoil.sh` on 2026-10-23:

1. `new SecureClient({ enclaveURL, configRepo })` sends one POST to
   `https://atc.tinfoil.sh/attestation` naming the enclave and the config repository, and
   gets back a bundle: the enclave's hardware attestation report, the AMD VCEK certificate,
   the release digest and tag, the Sigstore bundle for that release, and the enclave's TLS
   certificate.
2. In the browser it verifies the AMD report against the VCEK, verifies the Sigstore bundle
   against an embedded trusted root (no call to Sigstore's servers), checks the release
   predicate names `configRepo`, compares the measured launch value with the attested one,
   and checks the TLS certificate carries the attested HPKE key. Any failure throws before a
   byte of data is sent.
3. Requests then go over EHBP: each body is HPKE-encrypted to the attested key, and each
   response comes back encrypted to the client. Browsers cannot pin TLS certificates, so
   EHBP is the only transport the SDK offers in a browser.
4. The enclave's shim terminates EHBP and forwards plain HTTP to `upstream-port`. Tinfoil's
   own container services (`confidential-websearch`, `confidential-pii-cpu`) contain no HPKE
   code, so our service needs none either. Checked on 2026-10-23: an encrypted POST to the
   websearch container's `/health` through the SDK came back 200 with an
   `Ehbp-Response-Nonce` header and decrypted to `OK`.
5. Hosts contacted: `atc.tinfoil.sh` and the enclave. Nothing else.

**What the measurement covers.** The release artefact `tinfoil-deployment.json` (read from
`tinfoil-containers-hello-world` v0.0.5) carries the config bytes verbatim and puts
`tinfoil-config-hash=<sha256>` on the measured kernel command line. So the image digest, the
environment values, the secret *names* and the egress allowlist are all under the
attestation. Secret *values* are not, and they are visible to Tinfoil's infrastructure at
deploy time (the beta "private secrets" feature changes that; not used here).

**The V3 caveat, and why attested keys are off by default.** Attested keys, fresh attestation
and private secrets use "V3 attestation", in beta. Tinfoil's feature-status page lists V3
verification for the Go SDK, the Swift SDK, the CLI and the proxy, and not the JavaScript
SDK; the JavaScript verifier in 1.3.0 knows the `sev-snp-guest/v1`, `sev-snp-guest/v2` and
`snp-tdx-multiplatform/v1` predicate formats and nothing newer. Tinfoil's websearch container
(CVM 0.14.15, released 2026-10-22) still verified as v2 from the SDK. Whether declaring
`attested-keys` moves an instance to a format the browser SDK cannot read is unknown, so the
config ships with that block commented out: pass tests 1 and 2 first, then try it (step 11).

## Reproducible image

```bash
npm run build-image           # two no-cache builds; prints REPRODUCIBLE or NOT REPRODUCIBLE
npm run build-image -- --once # one build, prints its digest
```

What the digest needs to come out the same every time, each of which the Dockerfile keeps:

- the base image pinned by digest (`node:24.14.1-alpine3.23@sha256:8510330d…`), not by tag;
- no package installs, so no network and no resolver reaches the build;
- BuildKit with `SOURCE_DATE_EPOCH=0` and the image exporter's `rewrite-timestamp=true`, so the
  image config's `created` field and every file's mtime in the layer are fixed;
- `--provenance=false --sbom=false`, because those attestations carry timestamps and would
  change the index digest on every build;
- one platform (`linux/amd64`), so there is one manifest and its digest is the one a registry
  reports after `docker push` and the one `tinfoil-config.yml` pins.

`.github/workflows/build-image.yml` does the same in GitHub Actions and refuses to report a
digest unless a second no-cache build matches the first.

## The founder's steps, in order

Everything below needs an account, a card or a decision, so it is yours. `OWNER` is your
GitHub user or organisation; `ORG` is the Tinfoil organisation slug (it becomes part of the
container's hostname). Tinfoil's CLI ships Linux and macOS builds only (v0.19.12 on
2026-10-23: no Windows asset), so the CLI steps run in WSL (Ubuntu) on this machine; the
`gh`, `node` and `docker` steps run anywhere.

**1. Create the public repository and push this folder to it.**

```bash
gh repo create OWNER/kitchentableai-orchestrator --public --description "KitchenTableAI orchestrator: runs inside an attested Tinfoil container. AGPL-3.0." --clone
cd kitchentableai-orchestrator
# copy the contents of lab/cloud-orchestrator here (everything, including .github and .gitignore)
git add -A
git commit -m "Orchestrator spike: service, reproducible image, measured config, browser check"
git push -u origin main
```

Before the push, read `git status` once: no `.pem`, no `node_modules`, nothing from any
`.env` file. The hygiene rules at the end of this README apply to every commit there.

**2. Build and push the image.** From the repository's Actions tab run **Build Image** with
version `v0.1.0`, or:

```bash
gh workflow run build-image.yml --repo OWNER/kitchentableai-orchestrator -f version=v0.1.0
gh run watch --repo OWNER/kitchentableai-orchestrator
```

The run summary prints `Image: ghcr.io/OWNER/kitchentableai-orchestrator@sha256:…` and says
whether the second build matched. Copy the digest. (Local alternative: `npm run build-image`
prints the same digest if Docker is available; pushing from the laptop needs
`docker login ghcr.io` with a token that has `write:packages`, which the Actions path avoids.)

**3. Pin the digest.** In `tinfoil-config.yml` replace `OWNER` and the all-zero digest on the
`image:` line, then commit and push to `main`. The package GHCR creates is private by
default; make it public (GitHub → Packages → the package → Package settings → Change
visibility) or add registry credentials in Tinfoil's dashboard. Public is simpler and the
image is AGPL anyway.

**4. The Tinfoil account, organisation, keys and GitHub App.**

1. https://tinfoil.sh → **Get Started** → sign up → **Dashboard**.
2. Account switcher (top right) → **Create organization** → name it; the slug is `ORG`.
3. **Billing** → add credits (inference is paid per token; the spike needs a few cents).
   Container pricing is not published; see step 12.
4. **API keys** → **Create API key** → name `orchestrator-spike`, set a spend limit (for
   example $5). Copy it once; it goes into a Tinfoil secret in step 7 and nowhere else.
5. **Admin Keys** → **Create admin key** → name `cli`. The CLI logs in with it.
6. **Containers** → connect the Tinfoil GitHub App to `OWNER/kitchentableai-orchestrator`
   (the dashboard discovers the config repository through the App).

**5. Install the CLI in WSL and log in.**

```bash
curl -fsSL https://github.com/tinfoilsh/tinfoil-cli/raw/main/install.sh | sh
tinfoil --version          # 0.19.0 or newer is required for tag-pinned verified requests
tinfoil login              # paste the admin key when prompted
tinfoil whoami
```

**6. Publish the measured release.**

```bash
tinfoil repo build run OWNER/kitchentableai-orchestrator --version v0.1.0
tinfoil repo build status OWNER/kitchentableai-orchestrator --version v0.1.0
```

Two workflows run: the tag, then the measurement and publication. Wait until the GitHub
release `v0.1.0` carries `tinfoil-deployment.json` and `tinfoil.hash`. (`gh workflow run
tinfoil-release.yml --repo OWNER/kitchentableai-orchestrator -f version=v0.1.0` does the same.)

**7. Create the two secrets.** Values come in through stdin or a file, never as a command
argument, so they stay out of shell history.

```bash
read -s TINFOIL_API_KEY && printf '%s' "$TINFOIL_API_KEY" | tinfoil secret create TINFOIL_API_KEY --value-file - && unset TINFOIL_API_KEY
node scripts/make-signing-key.mjs signing-key.pem      # prints the public key's SPKI hex: keep it
tinfoil secret create SIGNING_KEY_PEM --value-file signing-key.pem
rm signing-key.pem
tinfoil secret list
```

**8. Create the instance and wait for Running.**

```bash
tinfoil container create orchestrator-spike \
  --repo OWNER/kitchentableai-orchestrator \
  --tag v0.1.0 \
  --secret TINFOIL_API_KEY --secret SIGNING_KEY_PEM
tinfoil container get orchestrator-spike     # Pending → Deploying → Starting → Running, 2–10 min
```

Its hostname is `orchestrator-spike.ORG.containers.tinfoil.dev`.

**9. Exit test 2 from the CLI** (verified connection, tag-pinned):

```bash
H=orchestrator-spike.ORG.containers.tinfoil.dev
R=OWNER/kitchentableai-orchestrator@v0.1.0
tinfoil http get  -e $H -r $R https://$H/health
tinfoil http post -e $H -r $R https://$H/turn -H "Content-Type: application/json" -b '{"prompt":"Say hello in one sentence."}'
```

Pass: `/health` shows `api_key_present: true` and `key_source: managed-secret`; `/turn`
returns `ok: true`, a reply and `model: glm-5-3`. Fail: `inference unreachable` with
`ENOTFOUND`, `ETIMEDOUT` or `ECONNREFUSED` means the allowlist did not let the call out; HTTP
401 from inference means the key; HTTP 404 from the enclave means a path missing from `shim.paths`.

**10. Exit tests 1 and 3 from the browser.**

```bash
cd lab/cloud-orchestrator && npm install && npm run web     # http://localhost:8097
```

Enter the container URL and `OWNER/kitchentableai-orchestrator` **without** a tag (the browser SDK
1.3.0 returns HTTP 400 from the attestation service for `repo@tag`; it verifies the repository's
latest release and reports its tag and digest, which the page shows), click **1. Verify the container**, then **2. Send one turn**, then **Copy evidence JSON**
and paste it into the dated results note in `company/`. Also click **Check Ed25519 support**
once. Pass: every verification step `success`, a reply, "signature verified
(managed-secret)". If the Verify step fails, the error names the step; the most likely ones
are a CORS refusal (set `shim.origins` or serve the page from the enclave) and an
attestation format the SDK does not know.

**11. Optional: the attested key (beta).** In `tinfoil-config.yml` uncomment `keys:
[turn-signing]` and the `attested-keys:` block, commit, push, then:

```bash
tinfoil repo build run OWNER/kitchentableai-orchestrator --version v0.1.1
tinfoil container update orchestrator-spike --tag v0.1.1
```

Repeat step 10. Pass: `key_source: attested-key`. If the browser verification now fails
where it passed in step 10, that is the finding (the V3 caveat above) and the question for
Tinfoil; `tinfoil container update orchestrator-spike --tag v0.1.0` rolls back.

**12. Stop the instance when a test session ends.** Containers are always-on and their price
is not published. A Stopped instance keeps its configuration, does not count toward the
limit, and comes back with `deploy`.

```bash
tinfoil container stop orchestrator-spike
tinfoil container get orchestrator-spike       # Stopped
tinfoil container deploy orchestrator-spike    # next session: brings it back on the same tag
```

When the spike is over for good: `tinfoil container delete orchestrator-spike`, then
`tinfoil secret delete SIGNING_KEY_PEM` and `tinfoil secret delete TINFOIL_API_KEY`, and
delete the `orchestrator-spike` API key in the dashboard.

## Questions for Tinfoil (contact@tinfoil.sh)

1. Does the JavaScript SDK verify a container that declares `attested-keys` (V3 attestation)
   from a browser, and if not, when? The feature-status page lists Go, Swift, the CLI and the
   proxy for V3.
2. Confirm the egress allowlist is part of the measurement (the release artefact puts the
   config hash on the kernel command line, so it appears to be).
3. Container pricing per size and hour, and whether a Stopped instance costs anything.
4. Their written position on a service used by children (outstanding since 2026-09-29).
5. A Windows build of the CLI, or a statement that WSL is the supported route.
6. The default CORS behaviour of the shim when `origins` is unset.

## Hygiene for the public repository

Everything in this folder is published under AGPL-3.0, so: no household member's name, no
founder name in fixtures or tests, the product's old word for the Agreement nowhere (not in
file names either), nothing copied from any `.env` file, no keys (`*.pem` is ignored). Logs
never carry a prompt, a reply or a key. The system prompt is a fixed connectivity line. When
the Agreement compiler moves in, the same rules apply to its fixtures.

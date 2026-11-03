// SPDX-License-Identifier: AGPL-3.0-only
// Builds the image twice with BuildKit, both times without cache, and reports whether the
// two manifest digests are identical. That is the reproducibility check Tinfoil's digest
// pinning deserves: the digest in tinfoil-config.yml should be one anybody can rebuild.
//
//   node scripts/build-image.mjs                 # two local builds, compare digests
//   node scripts/build-image.mjs --once          # one build, print its digest
//
// What it relies on (and the Dockerfile explains why):
//   SOURCE_DATE_EPOCH=0, --output type=oci,...,rewrite-timestamp=true, --provenance=false,
//   --sbom=false, --platform linux/amd64, a digest-pinned base image, no package installs.
// The OCI archive's index.json names the single manifest's digest; that digest is what a
// registry reports after `docker push` of the same build (RepoDigests), so it is the value
// that goes into tinfoil-config.yml.
//
// Needs Docker with buildx. A `docker-container` builder is created if the current one
// cannot export OCI archives with rewritten timestamps.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const once = process.argv.includes("--once");
const BUILDER = "kitchentableai-repro";

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function ensureBuilder() {
  const list = sh("docker", ["buildx", "ls"]);
  if (!list.includes(BUILDER)) {
    console.log(`creating buildx builder ${BUILDER} (docker-container driver)`);
    sh("docker", ["buildx", "create", "--name", BUILDER, "--driver", "docker-container"]);
  }
}

function buildOnce(label) {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-oci-"));
  const archive = join(dir, "image.tar");
  const t0 = Date.now();
  sh(
    "docker",
    [
      "buildx", "build",
      "--builder", BUILDER,
      "--platform", "linux/amd64",
      "--no-cache",
      "--provenance=false",
      "--sbom=false",
      "--output", `type=oci,dest=${archive},rewrite-timestamp=true`,
      "-t", "kitchentableai-orchestrator:spike",
      root,
    ],
    { env: { ...process.env, SOURCE_DATE_EPOCH: "0" }, stdio: ["ignore", "inherit", "inherit"] },
  );
  // Read the manifest digest out of the OCI layout. Relative paths and a cwd, because the
  // tar on Windows reads a drive-letter colon as a remote host.
  execFileSync("tar", ["-xf", "image.tar", "index.json"], { cwd: dir });
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  const digest = index.manifests[0].digest;
  rmSync(dir, { recursive: true, force: true });
  console.log(`${label}: ${digest} (${Math.round((Date.now() - t0) / 1000)}s)`);
  return digest;
}

ensureBuilder();
const a = buildOnce("build 1");
if (once) process.exit(0);
const b = buildOnce("build 2");
if (a === b) {
  console.log(`REPRODUCIBLE: both builds produced ${a}`);
} else {
  console.log(`NOT REPRODUCIBLE: ${a} vs ${b}`);
  process.exit(1);
}

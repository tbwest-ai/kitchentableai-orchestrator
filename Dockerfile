# KitchenTableAI orchestrator. SPDX-License-Identifier: AGPL-3.0-only
#
# Built for a reproducible digest. What that needs (verified locally with scripts/build-image.mjs):
#   1. The base image pinned by digest, not by tag. The tag is kept for readability only.
#   2. No package installs. The service has no dependencies, so no network reaches the build.
#   3. BuildKit with SOURCE_DATE_EPOCH=0 and the image exporter's rewrite-timestamp=true, so
#      the image config's "created" field and every file's mtime in the layer tar are fixed.
#   4. --provenance=false --sbom=false, because those attestations carry timestamps and would
#      change the index digest on every build.
#   5. One platform (linux/amd64, what Tinfoil's enclaves run), so there is one manifest.
#
# node:24.14.1-alpine3.23, index digest read from Docker Hub on 2026-10-23.
FROM node:24.14.1-alpine3.23@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
# The compiler, the floor and the judge; the content model and band guide they read; the model policy.
COPY --chown=node:node lib ./lib
COPY --chown=node:node agreement ./agreement
COPY --chown=node:node policy ./policy

# The enclave runs the container with zero capabilities and a read-only root filesystem.
# Nothing here writes to disk, and the process runs as the unprivileged `node` user.
USER node
EXPOSE 8080

# Docker-level check for local runs. Tinfoil ignores a Dockerfile HEALTHCHECK; the same
# command is declared again in tinfoil-config.yml, which is what the enclave boot waits for.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "server.mjs"]

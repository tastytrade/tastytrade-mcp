# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# tastytrade MCP server.
#
# YOU MUST RUN THIS CONTAINER WITH `-i`.
#
#   docker run -i --rm --env-file .env tastytrade-mcp-server
#
# This is a *stdio* MCP server: it speaks the protocol over stdin/stdout and
# has no HTTP port and no daemon. Without `-i` (or `-it`) Docker does not
# attach stdin, the transport reads EOF immediately, and the container exits
# right away with no output. That is the single most common mistake when
# wiring this image into an MCP client, and it looks identical to a crash.
# `-d` / `--detach` is meaningless here for the same reason.
#
# No credentials are baked into any layer. Supply them at run time with
# `--env-file` or `-e` (see server.json for ready-to-paste client config).
#
# ---- Hardened invocation --------------------------------------------------
#
# The image needs no writable filesystem, no Linux capability, and no
# privilege escalation. Every flag below was verified against this image by
# running a real MCP session through it, not by inspection:
#
#   docker run -i --rm \
#     --read-only \
#     --cap-drop ALL \
#     --security-opt no-new-privileges \
#     --user 1000:1000 \
#     --pids-limit 256 \
#     --memory 512m \
#     --env-file .env \
#     tastytrade-mcp-server
#
# It DOES need outbound HTTPS to whatever TASTYTRADE_API_URL points at, so
# `--network none` breaks it. Restricting egress to the broker host is the
# right control if your runtime can express it.
#
# Why each flag, briefly, so the list is auditable rather than cargo-culted:
#   --read-only              the server writes nothing to disk; the only
#                            filesystem access it makes is reading its own code
#                            and the vendored docs.
#   --cap-drop ALL           it binds no port and touches no device, so it needs
#                            no Linux capability at all.
#   --security-opt
#     no-new-privileges      nothing in the image is setuid; this closes the
#                            escalation path anyway.
#   --user 1000:1000         matches the USER below. Set it explicitly so an
#                            operator who overrides the entrypoint does not
#                            silently get root.
#   --pids-limit / --memory  a runaway agent driving this server is a plausible
#                            failure; bound it rather than the host.
#
# Preflight the container before wiring it into a client — the doctor ships in
# the image, so no clone is required:
#   docker run --rm --env-file .env --entrypoint node \
#     tastytrade-mcp-server dist/doctor.js
#
# Build for both supported architectures:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t tastytrade-mcp-server .
# ---------------------------------------------------------------------------

# One base reference for both stages, so they cannot drift apart, and so an
# operator can pin the base by digest without editing this file:
#   docker build --build-arg NODE_IMAGE=node:22-alpine@sha256:… .
# It is a tag by default deliberately: a hard-pinned digest with no automation
# to bump it silently freezes the image on an unpatched base, which is the
# worse failure for a long-lived published image.
ARG NODE_IMAGE=node:22-alpine

# ---- stage 1: build (devDependencies + TypeScript toolchain present) ------
FROM ${NODE_IMAGE} AS build

WORKDIR /app

# Install from the lockfile first, before copying source, so the dependency
# layer stays cached across source-only edits.
#
# `--ignore-scripts` blocks dependency lifecycle scripts (preinstall /
# install / postinstall) from executing during the image build. This tree has
# no native modules and needs none of them, so the only thing that could run
# there is a compromised transitive package — the standard npm supply-chain
# attack. If a future dependency genuinely requires a build step, this build
# fails loudly instead of running unreviewed code.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip devDependencies in place. Copying the pruned tree into the runtime
# stage avoids a second network install there, and guarantees the runtime tree
# resolves from the same lockfile that was just built against.
RUN npm prune --omit=dev


# ---- stage 2: runtime (no toolchain, no devDependencies) ------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="tastytrade MCP server"
LABEL org.opencontainers.image.description="Model Context Protocol server for the tastytrade brokerage API, with dry-run-gated order flow."
LABEL org.opencontainers.image.source="https://github.com/tastytrade/tastytrade-mcp"
LABEL org.opencontainers.image.licenses="MIT"

# The MCP registry resolves an OCI package to its server entry through this
# label and REJECTS a submission that lacks it. It must equal server.json's
# `name` exactly; the test suite pins the two together so they
# cannot drift. Not an org.opencontainers.* key, so it is spelled out in full.
LABEL io.modelcontextprotocol.server.name="io.github.tastytrade/tastytrade-mcp"

ENV NODE_ENV=production

# Remove the package managers and the OS package manager from the runtime
# image. The server is a single `node` process that installs nothing and
# downloads nothing, so npm / npx / corepack / yarn / apk are pure attack
# surface: each one is a ready-made "fetch and execute arbitrary code"
# primitive for anything that gets execution inside this container.
#
# `/lib/apk/db` is deliberately KEPT. That is the package database every SBOM
# and vulnerability scanner reads to enumerate the OS packages in the image;
# deleting it would make the image scan clean by making it unscannable, which
# hides CVEs instead of removing them.
#
# The self-checks are part of the build: if a future base image moves these
# paths, the build fails here rather than silently shipping npm again.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /opt/yarn-v* \
      /usr/local/include/node \
      /sbin/apk \
      /etc/apk \
      /var/cache/apk \
  && ! command -v npm \
  && ! command -v npx \
  && ! command -v yarn \
  && ! command -v apk \
  && test -f /lib/apk/db/installed \
  && node --version

WORKDIR /app

# Copied as root, NOT chowned to the runtime user. The server only ever READS
# its own code, so leaving the tree root-owned means the unprivileged process
# cannot rewrite dist/index.js — a container that keeps running after a
# compromise cannot persist a modified server into its own writable layer.
# (`--read-only` makes this belt-and-braces; the ownership holds even when an
# operator forgets that flag.)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# LICENSE travels with the image: MIT requires the copyright and permission
# notice to be included in all copies and substantial portions, and a published
# image is a copy. (There is no NOTICE file — that is an Apache-2.0 §4(d)
# construct, and none of tastytrade's own repositories ships one.)
COPY package.json LICENSE ./

# RUNTIME DEPENDENCY, not documentation. Several static MCP resources
# (streaming-reference, order-flow-reference, symbology-reference) readFileSync
# markdown out of this directory at module load, resolving it relative to
# dist/resources/static as ../../../tastytrade-llms-txt-docs/docs. Leave it out
# and the server throws ENOENT before it ever serves a request.
COPY tastytrade-llms-txt-docs ./tastytrade-llms-txt-docs

# uid:gid of the `node` user the official images ship. Numeric on purpose:
# Kubernetes `runAsNonRoot` refuses an image whose USER is a name it cannot
# resolve to a uid, so `USER node` would fail admission on exactly the
# clusters that check.
USER 1000:1000

# No EXPOSE and no HEALTHCHECK on purpose: there is no port to publish and
# nothing to poll. The process is healthy exactly as long as its stdio peer
# stays attached, which a HEALTHCHECK cannot observe — any probe here would
# either always pass (`node --version`, which proves nothing about the
# session) or hold stdin open and corrupt the protocol stream. A decorative
# HEALTHCHECK on a stdio server is worse than none: it reports "healthy" for
# a server that has already lost its client.
ENTRYPOINT ["node", "dist/index.js"]

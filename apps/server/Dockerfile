# OpenClerq server image: clerq-server (the gateway as a daemon), the clerq command line
# and the calculation engine, on Debian, running as a user that is not root.
#
# Build it from the repository root, which is the build context (the context is trimmed
# by .dockerignore). Needs BuildKit, which is Docker's default builder from version 23:
#
#   docker build -f apps/server/Dockerfile -t openclerq .
#
# Run it:
#
#   docker run -d --name openclerq -p 127.0.0.1:18790:18790 -v openclerq-data:/data openclerq
#
# docs/SERVER.md says what to do with it from there. The binaries are compiled by
# scripts/build-binary.js, the same script the release tarballs use, for the architecture
# this image is built for (TARGETARCH), so a build on an arm64 host makes an arm64 image
# and nothing is emulated.

# ---- the calculation engine
FROM rust:1-bookworm AS calc
WORKDIR /src/packages/calculation-core
COPY packages/calculation-core/ ./
RUN cargo build --release --locked

# ---- the workspace, and the Bun-compiled binaries
FROM node:24-bookworm AS build
ARG TARGETARCH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
COPY --from=calc /src/packages/calculation-core/target/release/clerq-calc /calc/clerq-calc
RUN case "$TARGETARCH" in \
      amd64) bun_arch=x64 ;; \
      arm64) bun_arch=arm64 ;; \
      *) echo "Unsupported architecture '$TARGETARCH'. Build with BuildKit (docker build or docker buildx build) for linux/amd64 or linux/arm64." >&2; exit 1 ;; \
    esac \
 && target="bun-linux-$bun_arch" \
 && pnpm --filter '@clerq/server...' --filter '@clerq/cli...' build \
 && node scripts/build-binary.js --entry apps/server/src/main.ts --name clerq-server \
      --target "$target" --calc /calc/clerq-calc --skip-build \
 && node scripts/build-binary.js --entry apps/cli/src/main.ts --name clerq \
      --target "$target" --no-calc --skip-build \
 && mkdir /out \
 && cp "apps/server/dist/$target/clerq-server" "apps/server/dist/$target/clerq-calc" \
       "apps/cli/dist/$target/clerq" /out/

# ---- what runs
FROM debian:bookworm-slim AS runtime

# git and openssh-client: automations work in git worktrees and reach remotes over ssh.
# procps: the start-up cleanup of a crashed run's processes reads `ps`.
# ca-certificates: TLS to the forges and the model providers.
# tini: the init process (PID 1), which reaps the processes agents leave behind.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client procps tini \
 && rm -rf /var/lib/apt/lists/*

# uid 10001 has a passwd entry and /data as its home, which ssh and git look up. /data is
# made and owned here, before VOLUME, so that a new volume starts out writable by it.
RUN groupadd --gid 10001 openclerq \
 && useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home --shell /bin/sh openclerq \
 && install -d -o 10001 -g 10001 -m 0700 /data

# clerq-calc sits next to clerq-server, where the server looks for it.
COPY --from=build /out/ /usr/local/bin/

# The whole data directory is $HOME/.clerq: database, backups, token, vault, clones.
ENV HOME=/data \
    CLERQ_HOST=0.0.0.0 \
    CLERQ_PORT=18790
WORKDIR /data
VOLUME /data
EXPOSE 18790

# A migration after an upgrade can be slow, hence the long start period.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["clerq-server", "healthcheck"]

USER 10001:10001
ENTRYPOINT ["tini", "--", "clerq-server"]
CMD ["run"]

# Last, so that a new version or commit does not rebuild the layers above.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="OpenClerq server" \
      org.opencontainers.image.description="The OpenClerq gateway as a headless server, with the clerq command line" \
      org.opencontainers.image.source="https://github.com/paxamedia/OpenClerq" \
      org.opencontainers.image.documentation="https://github.com/paxamedia/OpenClerq/blob/main/docs/SERVER.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

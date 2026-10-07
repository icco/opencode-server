FROM golang:1.27.1-trixie AS golang

FROM golang AS yq
ARG YQ_VERSION=v4.53.6
RUN CGO_ENABLED=0 GOBIN=/out go install "github.com/mikefarah/yq/v4@${YQ_VERSION}"

FROM node:26.10.0-trixie-slim AS tools

COPY --from=golang /usr/local/go /usr/local/go
COPY --from=yq /out/yq /usr/local/bin/yq
COPY --from=grafana/mcp-grafana:2.0.0@sha256:2ed63c4d9d67557c8ea6cc6988743ddd9008e248bd9842e760fec378a0b61062 /app/mcp-grafana /usr/local/bin/mcp-grafana

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash-completion build-essential ca-certificates curl fd-find file fzf \
      gettext-base gh git git-lfs jq less moreutils openssh-client openssl \
      procps python3 python3-pip python3-venv ripgrep rsync shellcheck \
      silversearcher-ag tini tmux tree unzip vim wget xz-utils zip zoxide zsh \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd

ARG OPENCODE_VERSION=2.0.24
ARG TYPESCRIPT_VERSION=7.0.2
ARG PNPM_VERSION=12.6.0
ARG TARGETARCH
ENV PNPM_HOME=/opt/pnpm
ENV PATH=${PNPM_HOME}/bin:${PATH}
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac \
    && mkdir -p /opt/pnpm-cli "$PNPM_HOME" \
    && curl --fail --silent --show-error --location \
      "https://registry.npmjs.org/@pnpm/exe.linux-${arch}/-/exe.linux-${arch}-${PNPM_VERSION}.tgz" \
      | tar -xz --strip-components=1 -C /opt/pnpm-cli \
    && ln -s /opt/pnpm-cli/pnpm /usr/local/bin/pnpm \
    && pnpm --allow-build=@opencode/cli add --global \
      "@opencode/cli@${OPENCODE_VERSION}" "typescript@${TYPESCRIPT_VERSION}" \
    && opencode --version

FROM tools AS config
WORKDIR /build
COPY package.json pnpm-lock.yaml opencode.json orchestra.jsonc ./
COPY scripts/build-config.mjs ./scripts/build-config.mjs
RUN pnpm install --frozen-lockfile --ignore-scripts --no-optional \
    && node scripts/build-config.mjs /build/runtime.json

FROM tools

ENV HOME=/data \
    PNPM_HOME=/data/.local/share/pnpm \
    GOPATH=/data/go \
    PATH=/usr/local/go/bin:/data/go/bin:/data/.local/share/pnpm/bin:/data/.local/share/pnpm:${PATH} \
    XDG_CONFIG_HOME=/data/.config \
    XDG_DATA_HOME=/data/.local/share \
    XDG_STATE_HOME=/data/.local/state \
    XDG_CACHE_HOME=/data/.cache \
    OPENCODE_CONFIG=/etc/opencode/opencode.json \
    OPENCODE_HEADLESS=1 \
    OPENCODE_CLIENT=app \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

COPY --from=config /build/runtime.json /etc/opencode/opencode.json
COPY orchestra.jsonc /etc/opencode/orchestra.jsonc
COPY instructions.md /etc/opencode/instructions.md
COPY --chmod=755 entrypoint.sh healthcheck.sh /usr/local/bin/
RUN mkdir -p /data/workspace /data/.config/opencode "$PNPM_HOME" \
    && usermod --home /data node \
    && chown -R node:node /data

USER node
WORKDIR /data/workspace
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]

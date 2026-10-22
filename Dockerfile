FROM golang:1.27.3-trixie AS golang

FROM golang AS yq
ARG YQ_VERSION=v4.54.1
RUN CGO_ENABLED=0 GOBIN=/out go install "github.com/mikefarah/yq/v4@${YQ_VERSION}"

FROM golang AS gotools
ARG TASK_VERSION=v3.54.0
ARG GOLANGCI_LINT_VERSION=v2.15.0
RUN CGO_ENABLED=0 GOBIN=/out go install "github.com/go-task/task/v3/cmd/task@${TASK_VERSION}" \
    && CGO_ENABLED=0 GOBIN=/out go install "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${GOLANGCI_LINT_VERSION}"

FROM node:26.12.1-trixie-slim AS tools

COPY --from=golang /usr/local/go /usr/local/go
COPY --from=yq /out/yq /usr/local/bin/yq
COPY --from=gotools /out/task /out/golangci-lint /usr/local/bin/
COPY --from=grafana/mcp-grafana:2.1.1@sha256:71a3f4e6f412d253611314233df709ec2571fb50e39742d23fa2940f670646dc /app/mcp-grafana /usr/local/bin/mcp-grafana

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash-completion build-essential ca-certificates curl fd-find file fzf \
      gettext-base gh git git-lfs jq less moreutils openssh-client openssl \
      procps python3 python3-pip python3-venv ripgrep rsync shellcheck \
      silversearcher-ag tini tmux tree unzip vim wget xz-utils zip zoxide zsh \
    && apt-get install -y --no-install-recommends --only-upgrade ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

ARG OPENCODE_VERSION=2.1.3
ARG OPENCHAMBER_VERSION=2.5.0
ARG TYPESCRIPT_VERSION=7.0.2
ARG PNPM_VERSION=12.15.0
ARG CLAUDE_CODE_VERSION=2.1.309
ARG TARGETARCH
ENV PNPM_HOME=/opt/pnpm
ENV PATH=${PNPM_HOME}/bin:${PATH}
COPY pnpm-workspace.yaml /opt/pnpm-config/pnpm/config.yaml
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac \
    && mkdir -p /opt/pnpm-cli "$PNPM_HOME" \
    && curl --fail --silent --show-error --location \
      "https://registry.npmjs.org/@pnpm/exe.linux-${arch}/-/exe.linux-${arch}-${PNPM_VERSION}.tgz" \
      | tar -xz --strip-components=1 -C /opt/pnpm-cli \
    && ln -s /opt/pnpm-cli/pnpm /usr/local/bin/pnpm \
    && XDG_CONFIG_HOME=/opt/pnpm-config pnpm --allow-build=@opencode/cli --allow-build=node-pty --allow-build=@anthropic-ai/claude-code add --global \
      "@opencode/cli@${OPENCODE_VERSION}" "@openchamber/web@${OPENCHAMBER_VERSION}" "typescript@${TYPESCRIPT_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && opencode --version \
    && openchamber --version \
    && claude --version

FROM tools AS config
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml opencode.jsonc ./
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
    OPENCODE_CLIENT=app \
    DISABLE_AUTOUPDATER=1 \
    OPENCHAMBER_CHATS_DIR=/data/workspace/.chats

COPY --from=config /build/runtime.json /etc/opencode/opencode.json
COPY AGENTS.md /etc/opencode/AGENTS.md
COPY config/quota-toast.jsonc /etc/opencode/quota-toast.jsonc
COPY skills /etc/opencode/skills
COPY --chmod=755 entrypoint.sh healthcheck.sh openchamber-healthcheck.sh /usr/local/bin/
RUN mkdir -p /data/workspace /data/.config/opencode "$PNPM_HOME" \
    && usermod --home /data node \
    && chown -R node:node /data

USER node
WORKDIR /data/workspace
EXPOSE 4096 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]

FROM golang:1.27.1-bookworm AS golang

FROM golang AS yq
ARG YQ_VERSION=v4.53.6
RUN CGO_ENABLED=0 GOBIN=/out go install "github.com/mikefarah/yq/v4@${YQ_VERSION}"

FROM node:26-bookworm-slim

COPY --from=golang /usr/local/go /usr/local/go
COPY --from=yq /out/yq /usr/local/bin/yq

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash-completion build-essential ca-certificates curl fd-find file fzf \
      gettext-base gh git git-lfs jq less moreutils openssh-client openssl \
      procps python3 python3-pip python3-venv ripgrep rsync shellcheck \
      silversearcher-ag tini tmux tree unzip vim wget xz-utils zip zoxide zsh \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd

ARG OPENCODE_VERSION=1.18.31
ARG TYPESCRIPT_VERSION=7.0.2
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" "typescript@${TYPESCRIPT_VERSION}" \
    && npm cache clean --force \
    && opencode --version

ENV HOME=/data \
    GOPATH=/data/go \
    PATH=/usr/local/go/bin:/data/go/bin:${PATH} \
    XDG_CONFIG_HOME=/data/.config \
    XDG_DATA_HOME=/data/.local/share \
    XDG_STATE_HOME=/data/.local/state \
    XDG_CACHE_HOME=/data/.cache \
    OPENCODE_CONFIG=/etc/opencode/opencode.json \
    OPENCODE_HEADLESS=1 \
    OPENCODE_CLIENT=app \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

COPY opencode.json /etc/opencode/opencode.json
COPY --chmod=755 entrypoint.sh healthcheck.sh /usr/local/bin/
RUN mkdir -p /data/workspace /data/.config/opencode \
    && usermod --home /data node \
    && chown -R node:node /data

USER node
WORKDIR /data/workspace
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["opencode", "web", "--hostname", "0.0.0.0", "--port", "4096"]

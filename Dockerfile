FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git openssh-client python3 \
      python3-pip python3-venv ripgrep tini unzip \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=1.18.31
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && opencode --version

ENV HOME=/data \
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
    && chown -R node:node /data

USER node
WORKDIR /data/workspace
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["opencode", "web", "--hostname", "0.0.0.0", "--port", "4096"]

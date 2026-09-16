# Curated Ubuntu coding base for OpenCode Cloudflare Containers.
# Always build linux/amd64 (Cloudflare Containers).
# Target: ≤2GB compressed / ≤5GB unpacked; standard-2 disk is 12GB.
FROM --platform=linux/amd64 ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    MISE_DATA_DIR=/opt/mise \
    MISE_CONFIG_DIR=/etc/mise \
    MISE_CACHE_DIR=/var/cache/mise \
    MISE_YES=1 \
    MISE_TRUSTED_CONFIG_PATHS=/etc/mise/config.toml \
    PATH="/opt/mise/shims:/opt/rust/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# --- apt base tools ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      zsh \
      git \
      git-lfs \
      curl \
      wget \
      jq \
      unzip \
      zip \
      tar \
      openssh-client \
      ca-certificates \
      build-essential \
      pkg-config \
      make \
      cmake \
      sqlite3 \
      ripgrep \
      fd-find \
      fzf \
      tini \
      gnupg \
      software-properties-common \
    && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/*

# --- mise (toolchain manager) ---
# Pin installer; tools versions live in /etc/mise/config.toml (copied from mise.toml).
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh \
    && mise --version

COPY mise.toml /etc/mise/config.toml
RUN mise trust /etc/mise/config.toml || true

# Install pinned toolchains into /opt/mise (shared, root-owned; shims on PATH).
# Drop Java/Gradle first if image size exceeds Cloudflare limits (see README).
RUN mise install \
    && mise reshim \
    && node --version \
    && corepack enable \
    && corepack prepare pnpm@latest --activate \
    && corepack prepare yarn@stable --activate \
    && python3 --version \
    && python3 -m pip --version \
    && uv --version \
    && go version \
    && java -version \
    && mvn -version \
    && gradle -version \
    && bun --version \
    && gh --version \
    && mise ls \
    && chmod -R a+rX /opt/mise /etc/mise \
    && mise trust /etc/mise/config.toml || true


# --- Rust (shared /opt/rust; not under /root) ---
ENV RUSTUP_HOME=/opt/rust/rustup     CARGO_HOME=/opt/rust/cargo
ARG RUST_VERSION=1.89.0
RUN curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs       | sh -s -- -y --default-toolchain "${RUST_VERSION}" --profile minimal --no-modify-path     && chmod -R a+rwX /opt/rust     && ln -sf /opt/rust/cargo/bin/rustc /usr/local/bin/rustc     && ln -sf /opt/rust/cargo/bin/cargo /usr/local/bin/cargo     && ln -sf /opt/rust/cargo/bin/rustup /usr/local/bin/rustup     && rustc --version     && cargo --version

# --- opencode-ai (pinned) ---
ARG OPENCODE_VERSION=1.18.31
RUN npm install -g --allow-scripts=opencode-ai "opencode-ai@${OPENCODE_VERSION}" \
    && opencode --version

# --- non-root user ---
# ubuntu:24.04 ships with UID/GID 1000 as user "ubuntu"; rename to "dev".
RUN set -eux; \
    if getent passwd dev >/dev/null; then \
      echo "user dev already exists"; \
    elif getent passwd 1000 >/dev/null; then \
      EXISTING="$(getent passwd 1000 | cut -d: -f1)"; \
      usermod -l dev "$EXISTING"; \
      if [ -d /home/"$EXISTING" ] && [ ! -d /home/dev ]; then \
        mv /home/"$EXISTING" /home/dev; \
      fi; \
      mkdir -p /home/dev; \
      usermod -d /home/dev -s /bin/bash dev; \
      GEXISTING="$(getent group 1000 | cut -d: -f1 || true)"; \
      if [ -n "$GEXISTING" ] && [ "$GEXISTING" != "dev" ]; then \
        groupmod -n dev "$GEXISTING" || true; \
      fi; \
    else \
      useradd -m -s /bin/bash -u 1000 -U dev; \
    fi; \
    mkdir -p /home/dev/.config/opencode /home/dev/.local/share/opencode; \
    printf '%s\n' 'export PATH="/opt/mise/shims:/home/dev/.local/bin:$PATH"' > /home/dev/.profile; \
    printf '%s\n' 'export PATH="/opt/mise/shims:/home/dev/.local/bin:$PATH"' > /home/dev/.bashrc; \
    printf '%s\n' '[ -f "$HOME/.profile" ] && . "$HOME/.profile"' > /home/dev/.bash_profile; \
    chown -R dev:dev /home/dev

USER dev
WORKDIR /home/dev

# Ensure mise shims + user local bins are on PATH for interactive shells
ENV PATH="/opt/mise/shims:/opt/rust/cargo/bin:/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME=/home/dev

COPY --chown=dev:dev opencode.json /home/dev/.config/opencode/opencode.json
COPY --chown=dev:dev startup.sh /home/dev/startup.sh
COPY --chown=dev:dev keepalive.js /home/dev/keepalive.js
# Keep toolchain pins only under /etc/mise (trusted). Avoid untrusted ~/mise.toml breaking shims.
RUN chmod +x /home/dev/startup.sh

EXPOSE 4096
# Keep bash ENTRYPOINT (do not use cloudflare/sandbox base — wrong ENTRYPOINT).
ENTRYPOINT ["/bin/bash", "/home/dev/startup.sh"]

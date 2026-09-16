FROM node:20-alpine

# Install dependencies (git for cloning repos, curl for health checks)
RUN apk add --no-cache git curl bash

# Install OpenCode globally
RUN npm install -g opencode-ai

# Create dev user with workspace
RUN adduser -D -s /bin/bash dev
USER dev
WORKDIR /home/dev

# Create required directories
RUN mkdir -p /home/dev/.config/opencode \
             /home/dev/.local/share/opencode

# Copy OpenCode config (uses Zen as provider)
COPY --chown=dev:dev opencode.json /home/dev/.config/opencode/opencode.json

# Copy startup script (clones repos and starts server)
COPY --chown=dev:dev startup.sh /home/dev/startup.sh
RUN chmod +x /home/dev/startup.sh

EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD curl -f http://localhost:4096/global/health || exit 1

ENTRYPOINT ["/home/dev/startup.sh"]

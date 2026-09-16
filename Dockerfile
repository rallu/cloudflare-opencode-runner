FROM node:20-alpine

RUN apk add --no-cache git curl bash
RUN npm install -g opencode-ai
RUN adduser -D -s /bin/bash dev
USER dev
WORKDIR /home/dev
RUN mkdir -p /home/dev/.config/opencode \
             /home/dev/.local/share/opencode
COPY --chown=dev:dev opencode.json /home/dev/.config/opencode/opencode.json
COPY --chown=dev:dev startup.sh /home/dev/startup.sh
COPY --chown=dev:dev keepalive.js /home/dev/keepalive.js
RUN chmod +x /home/dev/startup.sh
EXPOSE 4096
ENTRYPOINT ["/bin/bash", "/home/dev/startup.sh"]

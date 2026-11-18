# Chipnet demo relayer (docs/decisions/0009-chipnet-relayer.md): pays the fee and dust of claims made from the page.
# No key is ever copied into this image: the relayer's own chipnet key is mounted read-only at run time, and the
# process refuses to start without it or on any network but chipnet. Node 22 runs the TypeScript sources directly.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY config/ config/
COPY src/ src/
COPY deployments/ deployments/
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8081/api/relay/healthz || exit 1
CMD ["node", "src/relay/main.ts"]

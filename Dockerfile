# One static container: the claim page and the public epoch files, built from a clean tree and served by nginx.
# It holds no keys, signs nothing and has no server code: the page reads the chain itself.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vite build

FROM nginx:1.27-alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY deploy/nginx.conf /etc/nginx/conf.d/tuai.conf
COPY --from=build /app/dist /usr/share/nginx/html
# Run as the unprivileged nginx user on port 8080, with every writable path under /tmp (the root file system is read-only).
RUN sed -i -e 's|^pid .*|pid /tmp/nginx.pid;|' -e '/^user /d' /etc/nginx/nginx.conf
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

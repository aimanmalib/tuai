#!/usr/bin/env bash
# Deploy the tuai claim page as one static container behind the host's reverse proxy.
#   deploy/deploy.sh              build HEAD from a clean `git archive`, run it, install the route, verify
#   deploy/deploy.sh --rollback   run the previous image again (held by the stopped `tuai-undur` container)
#   deploy/deploy.sh --status     container, tags, rollback image and the public health code
# Verification: /healthz through the public URL (retried), then the read-only browser checks (e2e/live.spec.ts,
# Chromium desktop and WebKit iPhone 13) against the public URL. A failed browser check rolls back.
# Host values live in deploy/hos.env (not tracked; see deploy/hos.env.example). The page container holds no keys.
# Relayer (docs/decisions/0009-chipnet-relayer.md): with TUAI_RELAY_KEY_FILE set and TUAI_RELAY_OFF not 1, a second
# container `tuai-relay` runs with that chipnet key mounted read-only; otherwise it is stopped and the page falls back
# to the CLI command. Switch off: TUAI_RELAY_OFF=1 in deploy/hos.env, then deploy/deploy.sh.
set -euo pipefail
# The script calls itself again to roll back, after moving into deploy/: keep a path that still works from there.
SELF="$(realpath "$0")"
cd "$(dirname "$SELF")"
[ -r hos.env ] || { echo "deploy/hos.env missing (copy hos.env.example)"; exit 1; }
# shellcheck disable=SC1091
. ./hos.env
: "${TUAI_NETWORK:?}" "${TUAI_DOMAIN:?}" "${PROXY_CONTAINER:?}" "${PROXY_DYNAMIC_DIR:?}" "${CERT_RESOLVER:?}"
BUILD_CMD=${BUILD_CMD:-docker build}
MIN_FREE_GB=${MIN_FREE_GB:-8}
BROWSER_CMD=${BROWSER_CMD:-}
TUAI_RELAY_KEY_FILE=${TUAI_RELAY_KEY_FILE:-}
TUAI_RELAY_OFF=${TUAI_RELAY_OFF:-0}
export TUAI_NETWORK TUAI_RELAY_KEY_FILE TUAI_RELAY_OFF
DC="docker compose -f compose.yaml"
URL="https://$TUAI_DOMAIN"
HOLDER=tuai-undur

# Certificates use the HTTP-01 challenge: a name that does not resolve fails it.
dns_ok() { getent ahosts "$TUAI_DOMAIN" >/dev/null; }
health_code() { curl -s -m 20 -o /dev/null -w '%{http_code}' "$URL/healthz" || true; }

hold_previous() {  # $1 = image ID the replaced container ran: keep it by ID in a stopped container
  local prev id=${1:-}
  prev=$(cat PREVIOUS_TAG 2>/dev/null) || { echo "note: first deploy, no rollback image yet"; return 0; }
  [ -n "$id" ] || id=$(docker image inspect -f '{{.Id}}' "tuai:$prev" 2>/dev/null) || id=""
  [ -n "$id" ] || { echo "WARNING: rollback image tuai:$prev not found; --rollback will fail" >&2; return 1; }
  docker rm -fv "$HOLDER" >/dev/null 2>&1 || true
  docker tag "$id" "tuai:$prev"
  docker create --name "$HOLDER" --network none --restart no --label "sasateguh.tag=$prev" "tuai:$prev" >/dev/null
  echo "rollback image held: tuai:$prev (${id:7:12})"
}

relay_wanted() { [ -n "$TUAI_RELAY_KEY_FILE" ] && [ -r "$TUAI_RELAY_KEY_FILE" ] && [ "$TUAI_RELAY_OFF" != 1 ]; }

relay_up() {  # $1 = tag: run the relayer image of that tag, or stop the relayer when it is off or has no such image
  if relay_wanted && docker image inspect "tuai-relay:$1" >/dev/null 2>&1; then
    TUAI_TAG=$1 $DC --profile relay up -d --force-recreate tuai-relay
  else
    $DC --profile relay rm -sfv tuai-relay >/dev/null 2>&1 || true
    echo "relayer: off (page shows the CLI command)"
  fi
}

browser_check() {  # read-only checks, two engines, against the public URL
  (cd .. && E2E_BASE_URL="$URL" $BROWSER_CMD npx playwright test --reporter=line)
}

mode=${1:-deploy}
case "$mode" in
  --status)
    $DC --profile relay ps
    echo "current $(cat CURRENT_TAG 2>/dev/null || echo -) · previous $(cat PREVIOUS_TAG 2>/dev/null || echo -)"
    docker inspect -f 'rollback holder: {{index .Config.Labels "sasateguh.tag"}}' "$HOLDER" 2>/dev/null || echo "rollback holder: none"
    echo "public /healthz $(health_code)"; exit 0 ;;
  --rollback)
    dns_ok || { echo "$TUAI_DOMAIN does not resolve, nothing was changed"; exit 1; }
    TAG=$(cat PREVIOUS_TAG 2>/dev/null) || { echo "no PREVIOUS_TAG"; exit 1; }
    if ! docker image inspect "tuai:$TAG" >/dev/null 2>&1; then
      id=$(docker inspect -f '{{.Image}}' "$HOLDER" 2>/dev/null) || { echo "image tuai:$TAG is gone"; exit 1; }
      docker tag "$id" "tuai:$TAG"
    fi
    [ -r CURRENT_TAG ] && cp CURRENT_TAG PREVIOUS_TAG ;;
  deploy)
    dns_ok || { echo "$TUAI_DOMAIN does not resolve: create the DNS record first, nothing was changed"; exit 1; }
    [ -z "$(git -C .. status --porcelain)" ] || { echo "working tree not clean: commit first (the image is built from HEAD)"; exit 1; }
    free=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
    [ "$free" -ge "$MIN_FREE_GB" ] || { echo "less than ${MIN_FREE_GB} GB free on /, stopping"; exit 1; }
    TAG=$(git -C .. rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M)
    ctx=$(mktemp -d); trap 'rm -rf "$ctx"' EXIT
    git -C .. archive HEAD | tar -x -C "$ctx"   # clean tree: untracked and ignored files never reach the image
    $BUILD_CMD -t "tuai:$TAG" "$ctx"
    if relay_wanted; then $BUILD_CMD -t "tuai-relay:$TAG" -f "$ctx/deploy/relay.Dockerfile" "$ctx"; fi
    [ -r CURRENT_TAG ] && cp CURRENT_TAG PREVIOUS_TAG ;;
  *) echo "usage: deploy.sh [--rollback|--status]"; exit 2 ;;
esac

old_id=$(docker inspect -f '{{.Image}}' tuai 2>/dev/null || true)
TUAI_TAG=$TAG $DC up -d --force-recreate tuai
relay_up "$TAG"
echo "$TAG" > CURRENT_TAG

route=$(mktemp)
sed -e "s|@DOMAIN@|$TUAI_DOMAIN|g" -e "s|@CERT_RESOLVER@|$CERT_RESOLVER|g" traefik.yaml.tmpl > "$route"
chmod 644 "$route"
docker cp "$route" "$PROXY_CONTAINER:$PROXY_DYNAMIC_DIR/tuai.yaml"; rm -f "$route"

for _ in $(seq 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' tuai)" = healthy ] && break; sleep 3; done
no_rollback=0; [ "$mode" = --rollback ] || hold_previous "$old_id" || no_rollback=1

# Keep only the current and previous images of this project; the host disk is shared.
for repo in tuai tuai-relay; do
  docker images "$repo" --format '{{.Tag}}' | grep -vxF -e "$TAG" -e "$(cat PREVIOUS_TAG 2>/dev/null || echo -)" \
    | sed "s/^/$repo:/" | xargs -r docker rmi >/dev/null 2>&1 || true
done

# A new route or certificate can take a little while: wait and retry before calling it a failure.
code=000
for _ in $(seq 9); do code=$(health_code); [ "$code" = 200 ] && break; sleep 10; done
echo "tag $TAG · public /healthz $code"
[ "$code" = 200 ] || { echo "public health is not 200: check the certificate and route; undo with deploy/deploy.sh --rollback"; exit 1; }

if [ "$mode" = deploy ] && ! browser_check; then
  if [ -r PREVIOUS_TAG ] && [ "$no_rollback" = 0 ]; then echo "browser check failed: rolling back"; exec "$SELF" --rollback; fi
  echo "browser check failed and there is no previous image to return to"; exit 1
fi
[ "$no_rollback" = 0 ] || { echo "live, but no rollback image is held (warning above)"; exit 1; }

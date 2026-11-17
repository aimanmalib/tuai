#!/usr/bin/env bash
# Offline gate: lint, typecheck, unit and contract tests, contract compile check, web build when present.
# No network access is needed; contracts are exercised on the CashScript mock network.
set -euo pipefail
cd "$(dirname "$0")/.."

# Tests that run git in temporary folders must not inherit a hook's repository.
while IFS= read -r v; do unset "$v"; done < <(env | grep -oE '^GIT_[A-Z_]+' || true)

export NO_COLOR=1
echo "== lint";        npx eslint . --max-warnings 0
echo "== typecheck";   npx tsc --noEmit -p tsconfig.json
echo "== contracts";   npx tsx scripts/compile-contracts.ts --check
echo "== tests";       npx vitest run --reporter=dot
if [ -f web/index.html ] || [ -f index.html ]; then
  echo "== web build"; npx vite build
fi
echo "gate passed"

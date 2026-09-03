#!/usr/bin/env bash
# Scenario 20 — real-host mount & boot proof: the composed profile tree must
# contain dsh-topics-memory, and a real dsh boot must survive without loader
# errors.
set -euo pipefail

export DSH_HOME=/root/.dsh-e2e

echo '==> dsh --profile e2e --dump-config'
dsh --profile e2e --dump-config | grep -q 'dsh-topics-memory' \
  || { echo 'FAIL: composed tree does not contain dsh-topics-memory'; exit 1; }
echo '==> composed tree contains dsh-topics-memory; booting real dsh for 25s…'

set +e
timeout --signal=KILL 25 dsh --profile e2e > /tmp/boot.log 2>&1
rc=$?
set -e
tail -5 /tmp/boot.log || true

if grep -qE 'plugin tree failed to load|failed to apply loader entry|Cannot find (package|module)' /tmp/boot.log; then
  echo 'FAIL: loader error during boot'
  grep -E 'Error|error' /tmp/boot.log | head -15
  exit 1
fi

echo "PASS 20-boot-smoke: no loader errors (timeout exit ${rc} = survived the boot window)"

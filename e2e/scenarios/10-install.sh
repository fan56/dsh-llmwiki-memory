#!/usr/bin/env bash
# Scenario 10 — packaging & install: the packed tarball installs into a
# scratch profile through the host's own plugin command (pnpm forward), and
# the profile manifest records the plugin.
set -euo pipefail

export DSH_HOME=/root/.dsh-e2e
rm -rf "$DSH_HOME"

TARBALL="$(ls /dist/*.tgz)"
echo "==> dsh plugin --profile e2e add $TARBALL"
dsh plugin --profile e2e add "$TARBALL"

grep -q '@aiwayds/dsh-llmwiki-memory' "$DSH_HOME/profiles/e2e/package.json" \
  || { echo 'FAIL: profile package.json has no dsh-llmwiki-memory dependency'; exit 1; }

echo "PASS 10-install: tarball installed into the scratch profile"

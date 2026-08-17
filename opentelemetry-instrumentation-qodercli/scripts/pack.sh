#!/usr/bin/env bash
# pack.sh — Build and produce a deployable tarball.
#
# Output: dist/otel-qodercli-hook.tar.gz   (suitable for OSS upload)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$PKG_DIR/otel-qodercli-hook.tar.gz"

cd "$PKG_DIR"

echo "==> Building..."
npm install --silent
npm run build --silent

echo "==> Producing tarball..."
tar --exclude="node_modules" --exclude=".git" --exclude="*.tar.gz" \
    -czf "$OUT" \
    bin/ dist/ scripts/ package.json package-lock.json README.md 2>/dev/null || \
tar --exclude="node_modules" --exclude=".git" --exclude="*.tar.gz" \
    -czf "$OUT" \
    bin/ dist/ scripts/ package.json README.md

echo "    ✅ $(du -h "$OUT" | cut -f1)  $OUT"

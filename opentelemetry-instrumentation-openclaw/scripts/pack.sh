#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="opentelemetry-instrumentation-openclaw"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${PROJECT_DIR}/release"

cd "$PROJECT_DIR"

echo "==> Installing dependencies..."
npm ci --ignore-scripts

echo "==> Checking package-lock.json for internal registry URLs..."
if grep -q "registry.anpm.alibaba-inc.com" "$PROJECT_DIR/package-lock.json"; then
  echo "ERROR: package-lock.json contains internal registry URLs (registry.anpm.alibaba-inc.com)."
  echo "       Please regenerate with: rm -rf node_modules package-lock.json && npm install"
  exit 1
fi
echo "    OK — no internal registry URLs found."

echo "==> Building TypeScript..."
npm run build

echo "==> Preparing release directory..."
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/staging/${PLUGIN_NAME}"

cp -r dist             "$OUTPUT_DIR/staging/${PLUGIN_NAME}/"
cp    package.json     "$OUTPUT_DIR/staging/${PLUGIN_NAME}/"
cp    package-lock.json "$OUTPUT_DIR/staging/${PLUGIN_NAME}/"
cp    openclaw.plugin.json "$OUTPUT_DIR/staging/${PLUGIN_NAME}/"
cp    index.ts         "$OUTPUT_DIR/staging/${PLUGIN_NAME}/"
[ -f tsconfig.json ] && cp tsconfig.json "$OUTPUT_DIR/staging/${PLUGIN_NAME}/"

echo "==> Stripping macOS extended attributes..."
if command -v xattr &>/dev/null; then
  xattr -cr "$OUTPUT_DIR/staging/${PLUGIN_NAME}" 2>/dev/null || true
fi

echo "==> Creating tarball..."
COPYFILE_DISABLE=1 tar -czf "$OUTPUT_DIR/${PLUGIN_NAME}.tar.gz" \
  --no-xattrs \
  -C "$OUTPUT_DIR/staging" \
  "${PLUGIN_NAME}" 2>/dev/null || \
COPYFILE_DISABLE=1 tar -czf "$OUTPUT_DIR/${PLUGIN_NAME}.tar.gz" \
  -C "$OUTPUT_DIR/staging" \
  "${PLUGIN_NAME}"

rm -rf "$OUTPUT_DIR/staging"

TARBALL="$OUTPUT_DIR/${PLUGIN_NAME}.tar.gz"
SIZE=$(du -sh "$TARBALL" | cut -f1)

echo ""
echo "✅ Tarball created:"
echo "   Path: ${TARBALL}"
echo "   Size: ${SIZE}"
echo ""
echo "Upload this file and install.sh to your OSS bucket, then users can run:"
echo "   curl -fsSL https://<your-oss>/install.sh | bash -s -- \\"
echo "     --endpoint \"...\" \\"
echo "     --x-arms-license-key \"...\" \\"
echo "     --x-arms-project \"...\" \\"
echo "     --x-cms-workspace \"...\" \\"
echo "     --serviceName \"...\""

#!/usr/bin/env bash
# pack.sh — Pack otel-codex-hook into an OSS tarball
#
# Usage:
#   bash scripts/pack.sh
#
# Output: dist/otel-codex-hook.tar.gz
#
# Upload to OSS (requires ak/sk):
#   ossutil cp dist/otel-codex-hook.tar.gz \
#     oss://arms-apm-cn-hangzhou-pre/opentelemetry-instrumentation-codex/otel-codex-hook.tar.gz \
#     --acl public-read
#
# Verify after upload:
#   curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-codex/otel-codex-hook.tar.gz -o /dev/null -w "%{http_code}\n"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PKG_DIR/dist"
PLUGIN_NAME="otel-codex-hook"
OUTPUT="$DIST_DIR/${PLUGIN_NAME}.tar.gz"

echo "📦 Packing $PLUGIN_NAME ..."
echo ""

mkdir -p "$DIST_DIR"

PACK_TMPDIR=$(mktemp -d)
trap 'rm -rf "$PACK_TMPDIR"' EXIT

cd "$PKG_DIR"

if [[ "$(uname -s)" == "Darwin" ]]; then
  CP_FLAGS="-rX"
else
  CP_FLAGS="-r"
fi

cp $CP_FLAGS bin dist package.json README.md "$PACK_TMPDIR/"
# LICENSE is optional
[ -f LICENSE ] && cp $CP_FLAGS LICENSE "$PACK_TMPDIR/"
mkdir -p "$PACK_TMPDIR/scripts"
cp $CP_FLAGS scripts/install.sh scripts/uninstall.sh "$PACK_TMPDIR/scripts/"

xattr -cr "$PACK_TMPDIR" 2>/dev/null || true

COPYFILE_DISABLE=1 tar -czf "$OUTPUT" -C "$PACK_TMPDIR" .

SIZE=$(du -sh "$OUTPUT" | cut -f1)
echo "✅ Done: $OUTPUT ($SIZE)"
echo ""
echo "Next — upload to OSS:"
echo ""
echo "  # ossutil"
echo "  ossutil cp $OUTPUT \\"
echo "    oss://arms-apm-cn-hangzhou-pre/opentelemetry-instrumentation-codex/${PLUGIN_NAME}.tar.gz \\"
echo "    --acl public-read"
echo ""
echo "  # aliyun CLI"
echo "  aliyun oss cp $OUTPUT \\"
echo "    oss://arms-apm-cn-hangzhou-pre/opentelemetry-instrumentation-codex/${PLUGIN_NAME}.tar.gz \\"
echo "    --acl public-read"
echo ""
echo "Verify (HTTP 200 = success):"
echo "  curl -o /dev/null -sI https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-codex/${PLUGIN_NAME}.tar.gz | head -1"
echo ""

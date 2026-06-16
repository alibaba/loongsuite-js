#!/usr/bin/env bash
# pack.sh — 打包 otel-claude-hook 为 OSS tarball
#
# 用法：
#   bash scripts/pack.sh
#
# 输出：dist/otel-claude-hook.tar.gz
#
# 上传到 OSS（需要 ak/sk，让有权限的人执行）：
#   ossutil cp dist/otel-claude-hook.tar.gz \
#     oss://arms-apm-cn-hangzhou-pre/opentelemetry-instrumentation-claude/otel-claude-hook.tar.gz \
#     --acl public-read
#
# 上传后验证：
#   curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-claude/otel-claude-hook.tar.gz -o /dev/null -w "%{http_code}\n"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PKG_DIR/dist"
PLUGIN_NAME="otel-claude-hook"
OUTPUT="$DIST_DIR/${PLUGIN_NAME}.tar.gz"

echo "📦 打包 $PLUGIN_NAME ..."
echo ""

# 创建 dist 目录
mkdir -p "$DIST_DIR"

# 打包：先复制到临时目录再清除 xattr，避免安全扫描工具写入的
# com.apple.provenance、FileXRayCachedResultInEA 等随 tarball 带到 Linux
PACK_TMPDIR=$(mktemp -d)
trap 'rm -rf "$PACK_TMPDIR"' EXIT

cd "$PKG_DIR"

# macOS 的 cp -X 从复制阶段就不带 xattr
if [[ "$(uname -s)" == "Darwin" ]]; then
  CP_FLAGS="-rX"
else
  CP_FLAGS="-r"
fi

cp $CP_FLAGS bin src package.json README.md LICENSE "$PACK_TMPDIR/"
mkdir -p "$PACK_TMPDIR/scripts"
cp $CP_FLAGS scripts/install.sh scripts/setup-alias.sh scripts/uninstall.sh "$PACK_TMPDIR/scripts/"

# 双保险：清除所有残留 xattr
xattr -cr "$PACK_TMPDIR" 2>/dev/null || true

COPYFILE_DISABLE=1 tar -czf "$OUTPUT" -C "$PACK_TMPDIR" .

SIZE=$(du -sh "$OUTPUT" | cut -f1)
echo "✅ 打包完成: $OUTPUT ($SIZE)"
echo ""
echo "下一步 — 上传到 OSS（需要有 OSS 写权限的账号执行）："
echo ""
echo "  # 方式 1：ossutil（推荐）"
echo "  ossutil cp $OUTPUT \\"
echo "    oss://arms-apm-cn-hangzhou-pre/opentelemetry-instrumentation-claude/${PLUGIN_NAME}.tar.gz \\"
echo "    --acl public-read"
echo ""
echo "  # 方式 2：aliyun CLI"
echo "  aliyun oss cp $OUTPUT \\"
echo "    oss://arms-apm-cn-hangzhou-pre/opentelemetry-instrumentation-claude/${PLUGIN_NAME}.tar.gz \\"
echo "    --acl public-read"
echo ""
echo "上传后验证（HTTP 200 = 成功）："
echo "  curl -o /dev/null -sI https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-claude/${PLUGIN_NAME}.tar.gz | head -1"
echo ""
echo "更新后一行安装命令："
echo "  curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-claude/remote-install.sh | bash"

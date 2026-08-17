#!/usr/bin/env bash
# install.sh — Source-based installation for otel-qodercli-hook.
#
# Steps:
#   1. npm install + npm run build   (build dist/)
#   2. Globally install the package so otel-qodercli-hook is on PATH
#      (falls back to a wrapper in ~/.local/bin if global install lacks perms)
#   3. otel-qodercli-hook install --user   (writes ~/.qoder/settings.json hooks)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=============================================="
echo " otel-qodercli-hook — OpenTelemetry for qodercli"
echo "=============================================="
echo ""

cd "$PKG_DIR"

echo "==> Installing Node.js dependencies..."
npm install --silent
echo "    ✅ Dependencies installed"
echo ""

echo "==> Building TypeScript..."
npm run build --silent
echo "    ✅ dist/ built"
echo ""

echo "==> Registering otel-qodercli-hook globally..."
if npm install -g . --silent 2>/dev/null; then
  echo "    ✅ Installed globally via npm install -g"
elif npm link --silent 2>/dev/null; then
  echo "    ✅ Linked globally via npm link"
else
  echo "    ⚠️  Global install failed; installing wrapper to ~/.local/bin"
  LOCAL_BIN="$HOME/.local/bin"
  mkdir -p "$LOCAL_BIN"
  cat > "$LOCAL_BIN/otel-qodercli-hook" <<WRAPPER
#!/usr/bin/env bash
exec node "$PKG_DIR/bin/otel-qodercli-hook" "\$@"
WRAPPER
  chmod +x "$LOCAL_BIN/otel-qodercli-hook"
  echo "    ✅ Wrapper installed at \$LOCAL_BIN/otel-qodercli-hook"
  echo "       Make sure \$LOCAL_BIN is on your PATH."
fi
echo ""

echo "==> Registering hooks in ~/.qoder/settings.json..."
otel-qodercli-hook install --user
echo ""

echo "=============================================="
echo " ✅ Installation complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo "  1. export OTEL_EXPORTER_OTLP_ENDPOINT='https://your-otlp-endpoint'"
echo "  2. export OTEL_EXPORTER_OTLP_HEADERS='x-api-key=...'"
echo "  3. export OTEL_SERVICE_NAME='my-qodercli-agent'  # optional"
echo "  4. Run 'qodercli' as usual; traces will export on each turn."
echo ""
echo "Verify: otel-qodercli-hook check-env"
echo "Show config: otel-qodercli-hook show-config"
echo "Uninstall: otel-qodercli-hook uninstall"

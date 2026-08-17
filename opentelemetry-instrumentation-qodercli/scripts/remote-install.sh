#!/usr/bin/env bash
# remote-install.sh — One-line install via curl | bash.
#
# Usage:
#   curl -fsSL https://<your-host>/remote-install.sh | bash -s -- \
#     --endpoint "https://<otlp-endpoint>" \
#     --headers "x-arms-license-key=...,x-arms-project=...,x-cms-workspace=..." \
#     --service-name "my-qodercli-agent"
#
# Optional flags:
#   --debug              QODERCLI_TELEMETRY_DEBUG=1 (console output)

set -euo pipefail

ENDPOINT=""
HEADERS=""
SERVICE_NAME=""
DEBUG=0

while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --headers) HEADERS="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --debug) DEBUG=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo "==> Installing @loongsuite/opentelemetry-instrumentation-qodercli (npm global)..."
npm install -g @loongsuite/opentelemetry-instrumentation-qodercli

echo "==> Registering hooks in ~/.qoder/settings.json..."
otel-qodercli-hook install --user

# Append OTLP config to shell rcs.
write_rc() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  # Constitution C7: ensure trailing newline
  if [ -s "$rc" ] && [ "$(tail -c1 "$rc" | wc -l)" -eq 0 ]; then
    echo "" >> "$rc"
  fi
  # Strip any prior block we wrote.
  sed -i.bak '/# BEGIN otel-qodercli-hook/,/# END otel-qodercli-hook/d' "$rc" 2>/dev/null || true
  cat >> "$rc" <<EOF
# BEGIN otel-qodercli-hook
export OTEL_EXPORTER_OTLP_ENDPOINT="$ENDPOINT"
EOF
  if [ -n "$HEADERS" ]; then
    echo "export OTEL_EXPORTER_OTLP_HEADERS=\"$HEADERS\"" >> "$rc"
  fi
  if [ -n "$SERVICE_NAME" ]; then
    echo "export OTEL_SERVICE_NAME=\"$SERVICE_NAME\"" >> "$rc"
  fi
  if [ "$DEBUG" -eq 1 ]; then
    echo "export QODERCLI_TELEMETRY_DEBUG=1" >> "$rc"
  fi
  echo "# END otel-qodercli-hook" >> "$rc"
}

if [ -n "$ENDPOINT" ] || [ "$DEBUG" -eq 1 ]; then
  echo "==> Writing OTLP config into shell rc files..."
  write_rc "$HOME/.bashrc"
  write_rc "$HOME/.zshrc"
fi

echo ""
echo "✅ Installation complete!"
echo "   Run 'source ~/.bashrc' (or ~/.zshrc) and use qodercli as normal."
echo "   Verify: otel-qodercli-hook check-env"

#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# opentelemetry-instrumentation-openclaw local test installer
#
# Install plugin from a local tar.gz package for testing.
#
# Usage:
#   bash ./scripts/install-local-test.sh
#   bash ./scripts/install-local-test.sh --serviceName "my-openclaw-cms"
#   bash ./scripts/install-local-test.sh --plugin-file "/path/to/opentelemetry-instrumentation-openclaw.tar.gz"
# ---------------------------------------------------------------------------
set -euo pipefail

PLUGIN_NAME="opentelemetry-instrumentation-openclaw"
DIAG_PLUGIN_NAME="diagnostics-otel"
DEFAULT_PLUGIN_FILE="./release/opentelemetry-instrumentation-openclaw.tar.gz"

# ── Defaults (can be overridden by CLI args) ──
ENDPOINT=""
LICENSE_KEY=""
ARMS_PROJECT=""
CMS_WORKSPACE=""
SERVICE_NAME="openclaw-cms"
PLUGIN_FILE="${DEFAULT_PLUGIN_FILE}"
INSTALL_DIR=""
ENABLE_METRICS=true
KEEP_CONFIG=false

# ── Color helpers ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }

usage() {
  cat <<EOF
Usage:
  bash ./scripts/install-local-test.sh [options]

Options:
  --endpoint <url>                  OTEL endpoint
  --x-arms-license-key <value>      ARMS license key
  --x-arms-project <value>          ARMS project
  --x-cms-workspace <value>         CMS workspace
  --serviceName <value>             service name
  --plugin-file <path>              local plugin tar.gz path
  --install-dir <path>              install directory override
  --disable-metrics                 skip diagnostics-otel setup
  --keep-config                     preserve existing plugin config in openclaw.json
  --help                            show this help

Current defaults:
  --endpoint "${ENDPOINT}"
  --x-arms-license-key "${LICENSE_KEY}"
  --x-arms-project "${ARMS_PROJECT}"
  --x-cms-workspace "${CMS_WORKSPACE}"
  --serviceName "${SERVICE_NAME}"
  --plugin-file "${PLUGIN_FILE}"
EOF
}

need_value() {
  if [[ $# -lt 2 ]] || [[ "$2" == --* ]]; then
    error "Option $1 requires a value"
    exit 1
  fi
}

# ── Parse arguments ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint)           need_value "$@"; ENDPOINT="$2";      shift 2 ;;
    --x-arms-license-key) need_value "$@"; LICENSE_KEY="$2";   shift 2 ;;
    --x-arms-project)     need_value "$@"; ARMS_PROJECT="$2";  shift 2 ;;
    --x-cms-workspace)    need_value "$@"; CMS_WORKSPACE="$2"; shift 2 ;;
    --serviceName)        need_value "$@"; SERVICE_NAME="$2";  shift 2 ;;
    --plugin-file)        need_value "$@"; PLUGIN_FILE="$2";   shift 2 ;;
    --install-dir)        need_value "$@"; INSTALL_DIR="$2";   shift 2 ;;
    --disable-metrics)    ENABLE_METRICS=false; shift ;;
    --keep-config)        KEEP_CONFIG=true; shift ;;
    --help|-h)            usage; exit 0 ;;
    *)
      error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

# ── Validate non-empty config ──
if [[ "$KEEP_CONFIG" != true ]]; then
  MISSING=()
  [[ -z "$ENDPOINT" ]]     && MISSING+=("--endpoint")
  [[ -z "$SERVICE_NAME" ]] && MISSING+=("--serviceName")
  if [[ ${#MISSING[@]} -gt 0 ]]; then
    error "Missing required parameters: ${MISSING[*]}"
    exit 1
  fi
fi

if [[ ! -f "$PLUGIN_FILE" ]]; then
  error "Local plugin package not found: $PLUGIN_FILE"
  exit 1
fi

# ── Check prerequisites ──
info "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Please install Node.js >= 18 first."
  exit 1
fi
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  error "Node.js >= 18 is required (current: $(node --version))"
  exit 1
fi
ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  error "npm is not installed."
  exit 1
fi
ok "npm $(npm --version)"

if ! command -v python3 &>/dev/null; then
  error "python3 is required but not found. Please install Python 3."
  exit 1
fi
ok "python3 $(python3 --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

OPENCLAW_CMD="openclaw"
if ! command -v "$OPENCLAW_CMD" &>/dev/null; then
  error "OpenClaw CLI not found. Please install OpenClaw first before installing this plugin."
  exit 1
fi
ok "OpenClaw CLI found"

# ── Detect OpenClaw version for hooks compatibility ──
OPENCLAW_VERSION=$("$OPENCLAW_CMD" --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
NEEDS_HOOKS=false
if [[ -n "$OPENCLAW_VERSION" ]]; then
  OC_MAJOR=$(echo "$OPENCLAW_VERSION" | cut -d. -f1)
  OC_MINOR=$(echo "$OPENCLAW_VERSION" | cut -d. -f2)
  OC_PATCH=$(echo "$OPENCLAW_VERSION" | cut -d. -f3)
  OC_NUM=$((OC_MAJOR * 10000 + OC_MINOR * 100 + OC_PATCH))
  if [[ $OC_NUM -ge 20260425 ]]; then
    NEEDS_HOOKS=true
  fi
  ok "OpenClaw $OPENCLAW_VERSION (hooks.allowConversationAccess: $([ "$NEEDS_HOOKS" = true ] && echo 'supported' || echo 'not supported, skipping'))"
else
  NEEDS_HOOKS=true
  warn "Could not detect OpenClaw version, assuming hooks.allowConversationAccess is supported"
fi

# ── Check endpoint connectivity ──
if [[ -n "$ENDPOINT" ]]; then
  info "Checking endpoint connectivity: ${ENDPOINT}"
  ENDPOINT_HTTP_CODE=$(curl -o /dev/null -s -w "%{http_code}" "$ENDPOINT" -m 10 2>/dev/null || echo "000")
  if [[ "$ENDPOINT_HTTP_CODE" == "000" ]]; then
    error "Endpoint is unreachable (HTTP code: 000)."
    error "Please check your network connectivity to: ${ENDPOINT}"
    exit 1
  fi
  ok "Endpoint reachable (HTTP ${ENDPOINT_HTTP_CODE})"
elif [[ "$KEEP_CONFIG" == true ]]; then
  info "Skipping endpoint check (--keep-config: using existing config)"
fi

# ── Determine install directory ──
if [[ -n "$INSTALL_DIR" ]]; then
  TARGET_DIR="$INSTALL_DIR"
elif [[ -n "${OPENCLAW_STATE_DIR:-}" ]] && [[ -d "$OPENCLAW_STATE_DIR" ]]; then
  TARGET_DIR="${OPENCLAW_STATE_DIR}/extensions/${PLUGIN_NAME}"
elif [[ -d "$HOME/.openclaw" ]]; then
  TARGET_DIR="$HOME/.openclaw/extensions/${PLUGIN_NAME}"
else
  TARGET_DIR="/opt/${PLUGIN_NAME}"
fi
info "Install directory: ${TARGET_DIR}"

# ── Clean previous installation ──
if [[ -d "$TARGET_DIR" ]]; then
  if [[ -z "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
    info "Target directory exists but is empty, skipping cleanup."
  elif [[ -f "$TARGET_DIR/package.json" ]] || [[ -f "$TARGET_DIR/openclaw.plugin.json" ]]; then
    info "Removing previous installation..."
    rm -rf "$TARGET_DIR"
  else
    error "Target directory exists but does not look like a plugin installation: ${TARGET_DIR}"
    exit 1
  fi
fi
mkdir -p "$TARGET_DIR"

# ── Extract local package ──
info "Using local plugin package: ${PLUGIN_FILE}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
cp "$PLUGIN_FILE" "$TMP_DIR/plugin.tar.gz"
ok "Local package copied"

info "Extracting to ${TARGET_DIR}..."
tar -xzf "$TMP_DIR/plugin.tar.gz" -C "$TMP_DIR"
if [[ -d "$TMP_DIR/${PLUGIN_NAME}" ]]; then
  cp -rf "$TMP_DIR/${PLUGIN_NAME}/." "$TARGET_DIR/"
else
  cp -rf "$TMP_DIR/." "$TARGET_DIR/"
fi
ok "Extracted"

# ── Install npm dependencies ──
info "Installing npm dependencies (production only)..."
(cd "$TARGET_DIR" && npm install --omit=dev --ignore-scripts 2>&1) || {
  error "npm install failed in ${TARGET_DIR}"
  exit 1
}
ok "Dependencies installed"

# ── Optional diagnostics-otel setup ──
if [[ "$ENABLE_METRICS" == true ]]; then
  info "Ensuring ${DIAG_PLUGIN_NAME} is enabled in config..."
fi

# ── Determine openclaw.json path ──
if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
  CONFIG_PATH="${OPENCLAW_STATE_DIR}/openclaw.json"
elif [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
  CONFIG_PATH="$HOME/.openclaw/openclaw.json"
else
  CONFIG_PATH="$HOME/.openclaw/openclaw.json"
  mkdir -p "$(dirname "$CONFIG_PATH")"
fi
info "Updating config: ${CONFIG_PATH}"

python3 -c "
import json, sys, os

config_path = sys.argv[1]
plugin_name = sys.argv[2]
install_dir = sys.argv[3]
endpoint = sys.argv[4]
license_key = sys.argv[5]
arms_project = sys.argv[6]
cms_workspace = sys.argv[7]
service_name = sys.argv[8]
enable_metrics = sys.argv[9] == 'true'
diag_plugin_name = sys.argv[10]
needs_hooks = sys.argv[11] == 'true'
keep_config = sys.argv[12] == 'true'

config = {}
if os.path.exists(config_path):
    with open(config_path) as f:
        config = json.load(f)

config.setdefault('plugins', {})
plugins = config['plugins']
plugins.setdefault('allow', [])
if plugin_name not in plugins['allow']:
    plugins['allow'].append(plugin_name)

plugins.setdefault('load', {})
plugins['load'].setdefault('paths', [])
paths = plugins['load']['paths']
idx = next((i for i, p in enumerate(paths) if plugin_name in p), -1)
if idx >= 0:
    paths[idx] = install_dir
else:
    paths.append(install_dir)

plugins.setdefault('entries', {})
existing = plugins['entries'].get(plugin_name, {})

if keep_config and existing.get('config'):
    existing['enabled'] = True
    if needs_hooks:
        existing['hooks'] = {'allowConversationAccess': True}
    plugins['entries'][plugin_name] = existing
else:
    headers = {}
    if license_key: headers['x-arms-license-key'] = license_key
    if arms_project: headers['x-arms-project'] = arms_project
    if cms_workspace: headers['x-cms-workspace'] = cms_workspace
    entry = {
        'enabled': True,
        'config': {
            'endpoint': endpoint,
            'headers': headers,
            'serviceName': service_name,
            'debug': True
        }
    }
    if needs_hooks:
        entry['hooks'] = {'allowConversationAccess': True}
    plugins['entries'][plugin_name] = entry

if enable_metrics:
    if diag_plugin_name not in plugins['allow']:
        plugins['allow'].append(diag_plugin_name)
    plugins['entries'].setdefault(diag_plugin_name, {})
    plugins['entries'][diag_plugin_name]['enabled'] = True

    config.setdefault('diagnostics', {})
    config['diagnostics']['enabled'] = True
    config['diagnostics'].setdefault('otel', {})
    otel = config['diagnostics']['otel']
    otel['enabled'] = True
    otel['endpoint'] = endpoint
    otel.setdefault('protocol', 'http/protobuf')
    diag_headers = {}
    if license_key: diag_headers['x-arms-license-key'] = license_key
    if arms_project: diag_headers['x-arms-project'] = arms_project
    if cms_workspace: diag_headers['x-cms-workspace'] = cms_workspace
    otel['headers'] = diag_headers
    otel['serviceName'] = service_name
    otel['metrics'] = True
    otel.setdefault('traces', False)
    otel.setdefault('logs', False)

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" \
  "$CONFIG_PATH" \
  "$PLUGIN_NAME" \
  "$TARGET_DIR" \
  "$ENDPOINT" \
  "$LICENSE_KEY" \
  "$ARMS_PROJECT" \
  "$CMS_WORKSPACE" \
  "$SERVICE_NAME" \
  "$ENABLE_METRICS" \
  "$DIAG_PLUGIN_NAME" \
  "$NEEDS_HOOKS" \
  "$KEEP_CONFIG"

ok "Config updated"

# ── Restart gateway ──
info "Restarting OpenClaw gateway..."
if $OPENCLAW_CMD gateway restart 2>&1; then
  ok "Gateway restarted"
else
  warn "Gateway restart failed. Please restart manually: openclaw gateway restart"
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ opentelemetry-instrumentation-openclaw local test install complete${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo "  Plugin package: ${PLUGIN_FILE}"
echo "  Install dir:    ${TARGET_DIR}"
echo "  Config file:    ${CONFIG_PATH}"
echo "  Endpoint:       ${ENDPOINT}"
echo "  Service name:   ${SERVICE_NAME}"
echo ""

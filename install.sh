#!/usr/bin/env bash
# Klaude installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ihumaunkabir/klaude/main/install.sh | bash
#
# Installs the klaude-cli npm package into ~/.klaude/app (no sudo needed) and
# links the `klaude` command into ~/.local/bin.
#
# Environment variables:
#   KLAUDE_VERSION      version to install (default: latest)
#   KLAUDE_INSTALL_DIR  install location (default: ~/.klaude/app)
#   KLAUDE_BIN_DIR      where to link the command (default: ~/.local/bin)
#   KLAUDE_PACKAGE      package spec to install, overriding name and version
#                       (e.g. a local tarball; mainly for testing)

set -euo pipefail

PACKAGE="klaude-cli"
VERSION="${KLAUDE_VERSION:-latest}"
INSTALL_DIR="${KLAUDE_INSTALL_DIR:-$HOME/.klaude/app}"
BIN_DIR="${KLAUDE_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE_MAJOR=22

if [ -t 1 ]; then
  bold=$'\033[1m' red=$'\033[31m' green=$'\033[32m' yellow=$'\033[33m' reset=$'\033[0m'
else
  bold='' red='' green='' yellow='' reset=''
fi

info() { printf '%s\n' "${bold}==>${reset} $*"; }
warn() { printf '%s\n' "${yellow}warning:${reset} $*" >&2; }
die() {
  printf '%s\n' "${red}error:${reset} $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || die "Node.js ${MIN_NODE_MAJOR}+ is required. Install it from https://nodejs.org or with your package manager."
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node.js ${MIN_NODE_MAJOR}+ is required, found $(node -v)."
fi

spec="${KLAUDE_PACKAGE:-${PACKAGE}@${VERSION}}"
info "Installing ${spec} into ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
npm install --prefix "$INSTALL_DIR" --no-fund --no-audit --loglevel=error "$spec" >/dev/null

ln -sf "$INSTALL_DIR/node_modules/.bin/klaude" "$BIN_DIR/klaude"
installed="$("$BIN_DIR/klaude" --version)"
info "${green}Installed klaude ${installed}${reset} → ${BIN_DIR}/klaude"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "${BIN_DIR} is not on your PATH. Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    # shellcheck disable=SC2016 # $PATH is meant to be printed literally
    printf '\n    export PATH="%s:$PATH"\n\n' "$BIN_DIR"
    ;;
esac

if ! command -v ollama >/dev/null 2>&1; then
  warn "Ollama was not found. Install it from https://ollama.com, then pull a model, e.g.: ollama pull qwen3-coder"
fi

printf '%s\n' "Get started: ${bold}cd your-project && klaude${reset}"

#!/usr/bin/env bash
# qmd-gd one-shot installer — RUN THIS YOURSELF (the user), from the repo root.
#
#   bash scripts/install.sh [--yes] [--insecure-tls] [--dry-run]
#
# It collapses the manual setup into one command and handles the corporate-proxy
# TLS issues that break a vanilla `npm install` behind a TLS-intercepting proxy:
#
#   1. Resolves a CA bundle (QMD_CA_BUNDLE > NODE_EXTRA_CA_CERTS > SSL_CERT_FILE)
#      and exports NODE_EXTRA_CA_CERTS so npm's prebuild-install + node-gyp AND the
#      qmd runtime trust your proxy. No org-specific path is hardcoded — provide it
#      via QMD_CA_BUNDLE (the qmd-setup skill prompts the agent to supply it).
#   2. npm install -> npm run build -> npm link -> qmd skill install --global --yes.
#   3. NO model download: the default embedding model is vendored in-repo
#      (models/bge-small-en-v1.5-Q8_0.gguf), so embedding needs no network.
#
# Flags:
#   --yes           non-interactive (skips the skill-install confirmation prompts)
#   --insecure-tls  if `npm install` still fails with a cert error, retry it ONCE with
#                   TLS verification disabled for that single command (insecure — prefer
#                   a CA bundle). Without this flag, a cert failure prints the fix and stops.
#   --dry-run       print each step without executing (for review)
set -euo pipefail

YES=0; INSECURE=0; DRYRUN=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)       YES=1 ;;
    --insecure-tls) INSECURE=1 ;;
    --dry-run)      DRYRUN=1 ;;
    -h|--help)      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

say()  { printf '\n\033[1m==>\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
run()  { if [[ "$DRYRUN" == "1" ]]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }

# ── Node floor ──────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "install.sh: Node is not installed. qmd-gd needs Node >=20." >&2; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "install.sh: Node $(node -v) is too old; qmd-gd needs Node >=20." >&2; exit 1
fi
say "Node $(node -v) detected (>=20 OK)."

# ── CA bundle / proxy TLS ───────────────────────────────────────────────────
CA_BUNDLE="${QMD_CA_BUNDLE:-${NODE_EXTRA_CA_CERTS:-${SSL_CERT_FILE:-}}}"
if [[ -n "$CA_BUNDLE" && -f "$CA_BUNDLE" ]]; then
  export NODE_EXTRA_CA_CERTS="$CA_BUNDLE"
  export QMD_CA_BUNDLE="$CA_BUNDLE"
  say "Using CA bundle for Node TLS: $CA_BUNDLE"
  info "Exported NODE_EXTRA_CA_CERTS (npm install) and QMD_CA_BUNDLE (qmd runtime)."
elif [[ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}" ]]; then
  say "A proxy is set but no CA bundle was found."
  info "If npm install fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY, set QMD_CA_BUNDLE to your"
  info "corporate CA .pem and re-run:  QMD_CA_BUNDLE=/path/to/corp-ca.pem bash scripts/install.sh"
else
  say "No proxy/CA bundle configured (assuming direct network)."
fi

# ── npm install (with scoped insecure fallback) ─────────────────────────────
say "Installing dependencies (npm install)…"
INSTALL_LOG="$(mktemp)"
npm_install_ok=1
if [[ "$DRYRUN" == "1" ]]; then
  info "[dry-run] npm install"
elif npm install 2>&1 | tee "$INSTALL_LOG"; then
  npm_install_ok=1
else
  npm_install_ok=0
fi

if [[ "$npm_install_ok" == "0" ]]; then
  if grep -qiE 'UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_' "$INSTALL_LOG"; then
    if [[ "$INSECURE" == "1" ]]; then
      say "npm install hit a TLS cert error — retrying ONCE with verification disabled (insecure)."
      info "This is scoped to this single npm install only. Prefer fixing the CA bundle."
      NODE_TLS_REJECT_UNAUTHORIZED=0 npm install
    else
      rm -f "$INSTALL_LOG"
      echo "" >&2
      echo "install.sh: npm install failed with a TLS certificate error." >&2
      echo "  Fix (preferred):  QMD_CA_BUNDLE=/path/to/corp-ca.pem bash scripts/install.sh" >&2
      echo "  Or (insecure, this command only):  bash scripts/install.sh --insecure-tls" >&2
      exit 1
    fi
  else
    rm -f "$INSTALL_LOG"
    echo "install.sh: npm install failed (not a TLS error) — see output above." >&2
    exit 1
  fi
fi
rm -f "$INSTALL_LOG"

# ── build + link + skill install ────────────────────────────────────────────
say "Building (npm run build)…";        run npm run build
say "Linking the qmd CLI (npm link)…";   run npm link
say "Installing the bundled skills + agent (qmd skill install --global)…"
if [[ "$YES" == "1" ]]; then run qmd skill install --global --yes
else                         run qmd skill install --global; fi

# ── verify ──────────────────────────────────────────────────────────────────
say "Verifying (qmd doctor)…"
run qmd doctor || info "qmd doctor reported issues — review its output above."

say "Done."
if [[ -n "${QMD_CA_BUNDLE:-}" ]]; then
  info "To keep qmd working behind the proxy in future shells, add this to your shell profile:"
  info "    export QMD_CA_BUNDLE=\"$QMD_CA_BUNDLE\""
fi
info "Next: add a collection and embed —"
info "    qmd collection add ~/notes --name notes --mask '**/*.md'"
info "    qmd update && qmd embed"

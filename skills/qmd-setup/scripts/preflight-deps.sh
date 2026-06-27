#!/usr/bin/env bash
# RUN THIS YOURSELF (the user), in your own terminal — it makes outbound network
# requests (npm registry, HuggingFace, github.com). The Claude agent must NOT run it:
# in this environment the agent may reach only capitalone.com / github.com; the user
# reaches every other domain. The agent hands you this script and reads back your output.
#
# preflight-deps.sh — test every external service qmd-gd depends on, honoring
# internal-mirror / private-registry overrides. For each service the EFFECTIVE
# endpoint is the user-configured value if set, else the public default; we test
# that endpoint. Pass → proceed. Fail → print enough detail for a dev to root-cause
# (what was tried, HTTP code, the exact knob to set, an example, a repro command).
#
# Override knobs (the "optional URL for an internal service"):
#   - npm registry     : `npm config set registry <url>`  (or .npmrc / NPM_CONFIG_REGISTRY)
#   - HuggingFace      : HF_ENDPOINT=<url>   (or QMD_EMBED_MODEL=/local/file.gguf to skip it)
#   - native prebuilts : npm_config_better_sqlite3_binary_host_mirror=<url>, or build from
#                        source (`npm install --build-from-source`); node-llama-cpp prebuilts
#                        come from GitHub releases — build locally if that host is blocked.
#
# Exit 0 if all REQUIRED services pass, 1 otherwise. Run after `npm install` for the
# functional native-deps check; the network checks work any time.
set -uo pipefail

FAIL=0
ok()     { printf '  [ok]   %s\n' "$1"; }
bad()    { printf '  [FAIL] %s\n' "$1"; FAIL=1; }
warn()   { printf '  [warn] %s\n' "$1"; }
detail() { printf '         %s\n' "$1"; }
hr()     { printf '\n— %s —\n' "$1"; }

# Categorize a URL: prints the HTTP code; returns 0 reachable (2xx/3xx),
# 2 reachable-but-auth (401/403), 1 blocked/unknown.
http_check() {
  local url="$1" code
  command -v curl >/dev/null 2>&1 || { printf 'no-curl'; return 1; }
  # curl's -w always prints the code (000 on connect failure), even when it exits nonzero.
  code="$(curl -sI -o /dev/null -w '%{http_code}' -L --max-time 12 "$url" 2>/dev/null)"
  [[ -z "$code" ]] && code="000"
  printf '%s' "$code"
  case "$code" in 2*|3*) return 0;; 401|403) return 2;; *) return 1;; esac
}

echo "qmd-gd dependency preflight — testing each external service at its effective endpoint."
echo "(Set the override env/config to point a service at your internal mirror; see header.)"

# ── 1) npm registry ────────────────────────────────────────────────────────
# Source of: all JS deps + the sqlite-vec platform packages (optionalDependencies).
hr "npm registry (JS deps + sqlite-vec platform packages)"
REG="$(npm config get registry 2>/dev/null || echo 'https://registry.npmjs.org/')"
case "$REG" in https://registry.npmjs.org*|https://registry.npmjs.com*) SRC="default";; *) SRC="configured (.npmrc/NPM_CONFIG_REGISTRY)";; esac
printf '  endpoint [%s]: %s\n' "$SRC" "$REG"
CODE="$(http_check "$REG")"; rc=$?
if   [[ $rc -eq 0 ]]; then ok "reachable (HTTP $CODE) — npm install can fetch packages."
elif [[ $rc -eq 2 ]]; then ok "reachable (HTTP $CODE, auth required — fine if your npm creds are configured)."
else
  bad "unreachable (HTTP $CODE) — npm install will fail."
  detail "Set your internal registry:  npm config set registry <artifactory-npm-url>"
  detail "  (or add 'registry=<url>' to ~/.npmrc, or export NPM_CONFIG_REGISTRY=<url>)"
  detail "Root-cause:  curl -sIL '$REG'   ;   npm ping"
fi

# ── 2) HuggingFace (embedding model weights) ───────────────────────────────
hr "HuggingFace (embedding model, ~333MB on first 'qmd embed')"
if [[ -n "${QMD_EMBED_MODEL:-}" && -f "${QMD_EMBED_MODEL:-}" ]]; then
  ok "skipped — QMD_EMBED_MODEL is a local file ($QMD_EMBED_MODEL); no HuggingFace needed."
else
  HF_HOST="${HF_ENDPOINT:-https://huggingface.co}"
  [[ -n "${HF_ENDPOINT:-}" ]] && HFSRC="configured (HF_ENDPOINT)" || HFSRC="default"
  HF_URL="$HF_HOST/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf"
  printf '  endpoint [%s]: %s\n' "$HFSRC" "$HF_HOST"
  CODE="$(http_check "$HF_URL")"; rc=$?
  if [[ $rc -eq 0 || $rc -eq 2 ]]; then ok "reachable (HTTP $CODE) — model download will work."
  else
    bad "unreachable (HTTP $CODE) — 'qmd embed' cannot download the embedding model."
    detail "Point at an internal mirror:  export HF_ENDPOINT=<your-hf-mirror-url>"
    detail "Or skip HuggingFace entirely:  export QMD_EMBED_MODEL=/abs/path/to/embeddinggemma-300M-Q8_0.gguf"
    detail "Or pre-stage:  copy the .gguf (+ its .etag) into ~/.cache/qmd/models/"
    detail "Root-cause:  curl -sIL '$HF_URL'"
  fi
fi

# ── 3) Native prebuilt host (GitHub releases: node-llama-cpp + better-sqlite3) ─
hr "native prebuilt binaries (node-llama-cpp, better-sqlite3 — fetched during npm install)"
detail "These download from GitHub release hosts, NOT the npm registry — an npm-only"
detail "Artifactory proxy may not cover them."
GH_URL="https://github.com"
CODE="$(http_check "$GH_URL")"; rc=$?
if [[ $rc -eq 0 || $rc -eq 2 ]]; then ok "github.com reachable (HTTP $CODE) — prebuilt download should work."
else
  warn "github.com unreachable (HTTP $CODE) — prebuilt fetch during npm install may fail."
  detail "better-sqlite3:  npm config set better_sqlite3_binary_host_mirror <mirror>  (or 'npm install --build-from-source')"
  detail "node-llama-cpp:  build locally if its prebuilt host is blocked (needs cmake + a C/C++ toolchain)"
fi
# Functional truth: did the native modules actually install + load?
if command -v qmd >/dev/null 2>&1; then
  if qmd status >/dev/null 2>&1; then
    ok "qmd opens the store — better-sqlite3 + sqlite-vec loaded successfully."
  else
    bad "qmd cannot open the store — native modules did not install/load. Run 'qmd doctor'."
    detail "Usually a blocked prebuilt host (above) or a Node ABI mismatch — try: npm rebuild"
  fi
else
  detail "(qmd not on PATH yet — re-run this after 'npm install && npm run build && npm link')"
fi

echo
if [[ "$FAIL" == "0" ]]; then
  echo "PREFLIGHT OK — all required service dependencies are reachable."
else
  echo "PREFLIGHT FAILED — fix the [FAIL] services above (set the internal URL), then re-run."
fi
exit "$FAIL"

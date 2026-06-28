#!/usr/bin/env bash
# RUN THIS YOURSELF (the user), in your own terminal — it makes outbound network
# requests (npm registry, prebuilt CDNs, nodejs.org). The Claude agent must NOT run
# it: in locked-down environments the agent may reach only an allowlisted set of
# domains, while you reach every other domain. The agent hands you this script and
# reads back your output.
#
# preflight-deps.sh — verify the network dependencies that `npm install` needs, the
# way Node actually sees them. Two trust stores are at play and they differ:
#   - curl uses the system trust store (or its --cacert bundle)
#   - Node (npm prebuild-install, node-gyp, and qmd's own fetch) uses its OWN store
# A curl check can PASS while Node fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY behind
# a TLS-intercepting proxy — so this script probes BOTH, and inspects response bodies
# (an HTML 403 block page is NOT "reachable").
#
# The default embedding model ships in-repo (models/bge-small-en-v1.5-Q8_0.gguf), so
# NO HuggingFace access is needed to embed. HuggingFace is only checked if you have
# pointed QMD_EMBED_MODEL/config at an hf: model.
#
# Override knobs:
#   - npm registry       : npm config set registry <url>  (or .npmrc / NPM_CONFIG_REGISTRY)
#   - corporate CA (Node) : export QMD_CA_BUNDLE=/path/to/corp-ca.pem  (qmd's launcher
#                           feeds this to Node as NODE_EXTRA_CA_CERTS; you can also set
#                           NODE_EXTRA_CA_CERTS directly for npm install)
#   - native prebuilts   : npm_config_better_sqlite3_binary_host_mirror=<url>, or build
#                           from source (`npm install --build-from-source`)
#
# Exit 0 if all REQUIRED checks pass, 1 otherwise.
set -uo pipefail

FAIL=0
ok()     { printf '  [ok]   %s\n' "$1"; }
bad()    { printf '  [FAIL] %s\n' "$1"; FAIL=1; }
warn()   { printf '  [warn] %s\n' "$1"; }
detail() { printf '         %s\n' "$1"; }
hr()     { printf '\n— %s —\n' "$1"; }

# http_status <url> — curl HEAD; prints the HTTP code (000 on connect failure).
http_status() {
  command -v curl >/dev/null 2>&1 || { printf '000'; return 1; }
  local code
  code="$(curl -sI -o /dev/null -w '%{http_code}' -L --max-time 12 "$1" 2>/dev/null)"
  [[ -z "$code" ]] && code="000"
  printf '%s' "$code"
}

# artifact_check <url> — GET the first ~2KB and classify the RESPONSE BODY, not just
# the status. Prints one of: ok:<code> | html:<code> | http:<code> | down.
# An HTML body or content-type text/html (a proxy/captive-portal block page) is a
# FAILURE even on HTTP 200/403 — this is the false-positive the status-only check missed.
artifact_check() {
  command -v curl >/dev/null 2>&1 || { printf 'down'; return 1; }
  local url="$1" tmp meta code ct first
  tmp="$(mktemp)"
  meta="$(curl -s -L --max-time 20 -r 0-2047 -o "$tmp" -w '%{http_code}|%{content_type}' "$url" 2>/dev/null)"
  code="${meta%%|*}"; ct="$(printf '%s' "${meta#*|}" | tr 'A-Z' 'a-z')"
  first="$(head -c 64 "$tmp" 2>/dev/null | tr 'A-Z' 'a-z')"
  rm -f "$tmp"
  # A 404 means the origin responded (host reachable, this path/object just absent) —
  # expected for a bare CDN root probe. A proxy block would be a 403/block page, not a
  # forwarded 404, so don't treat a 404 (even an HTML one) as blocked.
  if [[ "$code" == "404" ]]; then printf 'up:404'; return 0; fi
  if [[ "$ct" == *text/html* || "$first" == *'<!doctype'* || "$first" == *'<html'* ]]; then
    printf 'html:%s' "$code"; return 0
  fi
  case "$code" in 2*|3*) printf 'ok:%s' "$code";; 000) printf 'down';; *) printf 'http:%s' "$code";; esac
}

# node_tls_probe <url> — HEAD the URL through NODE's trust store (the one npm/node-gyp/
# qmd use). Prints "ok", "cert", "fail", or "no-node". Exit-distinct so the caller can
# offer a Node-specific CA fix that a curl check would never trigger.
node_tls_probe() {
  command -v node >/dev/null 2>&1 || { printf 'no-node'; return 3; }
  node -e '
    fetch(process.argv[1], { method: "HEAD" })
      .then(() => { process.stdout.write("ok"); })
      .catch((e) => {
        const m = String((e && (e.cause?.code || e.code || e.message)) || e);
        process.stdout.write(/UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_|DEPTH_ZERO/.test(m) ? "cert" : "fail");
      });
  ' "$1" 2>/dev/null
}

echo "qmd-gd dependency preflight — verifying what 'npm install' needs (curl AND Node trust stores)."

# ── 1) npm registry ────────────────────────────────────────────────────────
hr "npm registry (JS deps + sqlite-vec platform packages)"
REG="$(npm config get registry 2>/dev/null || echo 'https://registry.npmjs.org/')"
case "$REG" in https://registry.npmjs.org*|https://registry.npmjs.com*) SRC="default";; *) SRC="configured";; esac
printf '  endpoint [%s]: %s\n' "$SRC" "$REG"
CODE="$(http_status "$REG")"
case "$CODE" in
  2*|3*|401|403) ok "reachable (HTTP $CODE).";;
  *) bad "unreachable (HTTP $CODE) — npm install will fail."
     detail "Set your internal registry:  npm config set registry <internal-npm-registry-url>";;
esac

# ── 2) prebuilt-binary hosts (NOT the npm registry) ─────────────────────────
hr "prebuilt-binary hosts (node-llama-cpp backend)"
detail "qmd's SQLite is Node's built-in node:sqlite — NO native build. The remaining native"
detail "pieces (sqlite-vec's .dylib, node-llama-cpp's N-API backend) install as prebuilt npm"
detail "packages, but node-llama-cpp may also fetch from the GitHub release CDN"
detail "(objects.githubusercontent.com) — an npm-only proxy may not cover it."
NODE_V="$(node -p 'process.version' 2>/dev/null || echo v20.0.0)"
for pair in \
  "objects.githubusercontent.com|https://objects.githubusercontent.com/" \
  "nodejs.org headers|https://nodejs.org/download/release/${NODE_V}/node-${NODE_V}-headers.tar.gz" ; do
  name="${pair%%|*}"; url="${pair#*|}"
  res="$(artifact_check "$url")"
  case "$res" in
    ok:*)   ok "$name reachable (HTTP ${res#ok:}, binary response).";;
    up:*)   ok "$name reachable (HTTP ${res#up:}; host responded — prebuilt fetch should work).";;
    html:*) bad "$name returned an HTML block page (HTTP ${res#html:}) — a proxy is intercepting it."
            detail "This is the failure a status-only check misses. Fix the proxy/CA (see TLS check below).";;
    http:*) warn "$name HTTP ${res#http:} — may be fine (some hosts 403 a bare path) if the TLS check passes.";;
    down)   warn "$name unreachable — node-llama-cpp's prebuilt backend fetch may fail."
            detail "If blocked, node-llama-cpp can build from source (needs cmake + a C/C++ toolchain).";;
  esac
done

# ── 3) Node TLS trust (the store npm/node-gyp/qmd actually use) ──────────────
hr "Node TLS trust store (UNABLE_TO_GET_ISSUER_CERT class)"
if [[ -n "${NODE_EXTRA_CA_CERTS:-}" ]]; then detail "NODE_EXTRA_CA_CERTS is set: ${NODE_EXTRA_CA_CERTS}"
elif [[ -n "${QMD_CA_BUNDLE:-}" ]]; then detail "QMD_CA_BUNDLE is set: ${QMD_CA_BUNDLE} (qmd's launcher will feed this to Node)"
else detail "no CA bundle configured (NODE_EXTRA_CA_CERTS / QMD_CA_BUNDLE unset)"; fi
TLS_BAD=0
for url in "$REG" "https://objects.githubusercontent.com/"; do
  res="$(node_tls_probe "$url")"
  case "$res" in
    ok)      ok "Node completed TLS to $url";;
    cert)    TLS_BAD=1; bad "Node TLS FAILED to $url (UNABLE_TO_GET_ISSUER_CERT class).";;
    no-node) warn "node not on PATH — cannot run the Node TLS probe (install Node >=22.13 first)."; break;;
    *)       warn "Node could not reach $url (non-cert error; could be network/proxy).";;
  esac
done
if [[ "$TLS_BAD" == "1" ]]; then
  detail "npm install (prebuild-install + node-gyp) and 'qmd pull' will hit the same error."
  detail "Point Node at your corporate CA bundle, then re-run:"
  detail "  export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem   # for npm install"
  detail "  export QMD_CA_BUNDLE=/path/to/corp-ca.pem          # qmd reuses this at runtime"
  detail "Last resort for npm install only:  NODE_TLS_REJECT_UNAUTHORIZED=0 npm install   (insecure)"
fi

# ── 4) embedding model ──────────────────────────────────────────────────────
hr "embedding model"
EMBED="${QMD_EMBED_MODEL:-}"
if [[ -z "$EMBED" ]]; then
  ok "default model is vendored in-repo (models/bge-small-en-v1.5-Q8_0.gguf) — no network needed."
elif [[ -f "$EMBED" ]]; then
  ok "QMD_EMBED_MODEL is a local file ($EMBED) — no network needed."
elif [[ "$EMBED" == hf:* ]]; then
  ref="${EMBED#hf:}"; repo="$(printf '%s' "$ref" | cut -d/ -f1-2)"; file="$(printf '%s' "$ref" | cut -d/ -f3-)"
  HF_URL="${HF_ENDPOINT:-https://huggingface.co}/$repo/resolve/main/$file"
  res="$(artifact_check "$HF_URL")"
  case "$res" in
    ok:*)   ok "configured hf: model reachable (HTTP ${res#ok:}).";;
    html:*) bad "hf: model returned an HTML block page (HTTP ${res#html:}) — proxy blocked."
            detail "Vendor a local .gguf and set QMD_EMBED_MODEL=/abs/path, or use the in-repo default (unset QMD_EMBED_MODEL).";;
    *)      bad "hf: model unreachable ($res). Use a local .gguf (QMD_EMBED_MODEL=/abs/path) or the in-repo default.";;
  esac
else
  warn "QMD_EMBED_MODEL=$EMBED is neither a local file nor an hf: URI."
fi

# ── 5) functional check (after npm install + build + link) ──────────────────
hr "functional check"
if command -v qmd >/dev/null 2>&1; then
  if qmd status >/dev/null 2>&1; then ok "qmd opens the store — node:sqlite + sqlite-vec loaded."
  else bad "qmd cannot open the store — sqlite-vec or node-llama-cpp did not install/load. Run 'qmd doctor'."
       detail "Usually a blocked prebuilt host (npm registry / release CDN); 'qmd doctor' names the failing piece."; fi
else
  detail "(qmd not on PATH yet — re-run after 'npm install && npm run build && npm link')"
fi

echo
if [[ "$FAIL" == "0" ]]; then echo "PREFLIGHT OK — required dependencies are reachable (curl + Node)."
else echo "PREFLIGHT FAILED — fix the [FAIL] items above, then re-run."; fi
exit "$FAIL"

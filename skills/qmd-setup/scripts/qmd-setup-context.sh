#!/usr/bin/env bash
# qmd-setup-context.sh — READ-ONLY status probe for the qmd-setup skill.
#
# Prints the current state of a qmd-gd install and the next command the USER
# should run. It NEVER mutates anything (no collection add / update / embed /
# install). The agent runs this to decide what to tell the user next.
#
# Usage: bash skills/qmd-setup/scripts/qmd-setup-context.sh
set -uo pipefail

section() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [ok]   %s\n' "$1"; }
todo() { printf '  [todo] %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }

# --- Locate the checkout ----------------------------------------------------
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)"

section "Checkout"
if [[ -z "$REPO_ROOT" ]]; then
  todo "Not inside a git checkout. cd into the qmd-gd repo before running setup."
else
  info "repo: $REPO_ROOT"
  case "$REPO_ROOT" in
    */.claude/worktrees/*)
      todo "This is a throwaway WORKTREE. Install the skill + CLI from the STABLE"
      todo "checkout (e.g. ~/repos/qmd-gd) so the ~/.claude/skills/qmd symlink does"
      todo "not point at a worktree that may be deleted."
      ;;
    *)
      ok "stable checkout"
      ;;
  esac
fi

# --- CLI availability -------------------------------------------------------
section "CLI"
if command -v qmd >/dev/null 2>&1; then
  ok "qmd on PATH ($(command -v qmd)) — $(qmd --version 2>/dev/null | head -1)"
  QMD_OK=1
else
  todo "qmd is not on PATH. Build + link it (see step 1 in the skill)."
  QMD_OK=0
fi

# --- Skill discovery (~/.claude/skills/qmd) ---------------------------------
section "Skill discovery"
CLAUDE_SKILL="$HOME/.claude/skills/qmd"
if [[ -e "$CLAUDE_SKILL" || -L "$CLAUDE_SKILL" ]]; then
  if [[ -L "$CLAUDE_SKILL" ]]; then
    ok "~/.claude/skills/qmd -> $(readlink "$CLAUDE_SKILL")"
  else
    ok "~/.claude/skills/qmd present (directory)"
  fi
else
  todo "qmd skill not installed for Claude. Run: qmd skill install --global"
fi

# --- Collections + index health (read-only) ---------------------------------
section "Collections & index"
if [[ "$QMD_OK" == "1" ]]; then
  COLLECTIONS="$(qmd collection list 2>/dev/null || true)"
  if [[ -z "$COLLECTIONS" || "$COLLECTIONS" == *"No collections"* ]]; then
    todo "No collections indexed yet. Add the repos to search (step 4)."
  else
    ok "collections:"
    printf '%s\n' "$COLLECTIONS" | sed 's/^/      /'
  fi
  info ""
  info "Index status:"
  qmd status 2>/dev/null | sed 's/^/      /' || todo "qmd status failed — run qmd doctor."
else
  info "(skipped — qmd not available yet)"
fi

# --- Embedding model: cache + download dependency (HuggingFace) -------------
# qmd-gd downloads ONE model — the embedding model (~333MB) — on first `qmd embed`
# /`qmd pull`. In a locked-down network HuggingFace may be blocked, so preflight the
# dependency here WITHOUT fetching the 333MB body (a HEAD request), and detect whether
# the model is already cached.
section "Embedding model (download dependency)"
CACHE_MODELS="${XDG_CACHE_HOME:-$HOME/.cache}/qmd/models"
if ls "$CACHE_MODELS"/*embeddinggemma* >/dev/null 2>&1; then
  ok "embedding model already cached in $CACHE_MODELS — no download needed."
elif [[ -n "${QMD_EMBED_MODEL:-}" && -f "${QMD_EMBED_MODEL:-}" ]]; then
  ok "QMD_EMBED_MODEL points at a local file ($QMD_EMBED_MODEL) — no download needed."
else
  todo "Embedding model not present (~333MB). It downloads on first 'qmd embed' / 'qmd pull'."
  HF_HOST="${HF_ENDPOINT:-https://huggingface.co}"
  MODEL_URL="$HF_HOST/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf"
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -sI -o /dev/null -w '%{http_code}' -L --max-time 12 "$MODEL_URL" 2>/dev/null || echo 000)"
    case "$code" in
      200|301|302) ok "HuggingFace reachable (HTTP $code via $HF_HOST) — auto-download should work." ;;
      000)         todo "Cannot reach $HF_HOST (timeout/blocked) — auto-download will FAIL on this network." ;;
      401|403)     todo "HuggingFace returned HTTP $code (auth/proxy block) — auto-download will likely fail." ;;
      *)           todo "HuggingFace returned HTTP $code — verify before relying on auto-download." ;;
    esac
  else
    info "curl not found — can't preflight; run 'qmd pull' to test the download directly."
  fi
  info "If blocked, use ONE of:"
  info "  (a) QMD_EMBED_MODEL=/abs/path/to/embeddinggemma.gguf   (pre-staged local file; no network)"
  info "  (b) copy the .gguf (+ its .etag) into $CACHE_MODELS"
  info "  (c) HF_ENDPOINT=<internal HuggingFace mirror>          (then 'qmd pull')"
fi
[[ "$QMD_OK" == "1" ]] && info "After the model is in place, 'qmd doctor' verifies the cache + device/GPU."

# --- Scheduled refresh (Duo) ------------------------------------------------
section "Scheduled refresh"
if command -v duo >/dev/null 2>&1; then
  ok "duo CLI present"
  info "Check Duo's Home view (or run 'duo cron list') for the 'qmd index refresh' job."
  info "Not scheduled yet? Register it (step 7). Manage it (run/pause/resume/edit) from Duo Home."
else
  info "duo CLI not found — register the refresh job from inside Duo (step 7)."
fi

printf '\nDone. The agent should now walk the user through the [todo] items in order.\n'

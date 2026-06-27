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

# --- Embedding model cache --------------------------------------------------
section "Embedding model"
if [[ "$QMD_OK" == "1" ]]; then
  info "Run 'qmd doctor' for full model-cache + device checks. qmd-gd downloads"
  info "ONLY the embedding model (no generative/reranker models)."
else
  info "(skipped — qmd not available yet)"
fi

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

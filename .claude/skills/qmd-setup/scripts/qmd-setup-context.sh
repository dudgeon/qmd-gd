#!/usr/bin/env bash
# qmd-setup-context.sh — READ-ONLY status probe for the qmd-setup skill.
#
# Prints the current state of a qmd-gd install and the next command the USER
# should run. It NEVER mutates anything (no collection add / update / embed /
# install). The agent runs this to decide what to tell the user next.
#
# Usage: bash .claude/skills/qmd-setup/scripts/qmd-setup-context.sh
set -uo pipefail

section() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [ok]   %s\n' "$1"; }
todo() { printf '  [todo] %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }

# --- Locate the qmd-gd folder -----------------------------------------------
# Derived from THIS script's own path, so it works for an unzipped download
# (no .git) exactly as well as a git clone. The script lives at
# <root>/.claude/skills/qmd-setup/scripts/qmd-setup-context.sh — four levels up.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." 2>/dev/null && pwd || true)"

section "Checkout"
if [[ -z "$REPO_ROOT" || ! -f "$REPO_ROOT/package.json" || ! -d "$REPO_ROOT/.claude/skills/qmd-setup" ]]; then
  todo "Could not locate the qmd-gd folder. Run this from inside the unzipped qmd-gd"
  todo "folder:  bash .claude/skills/qmd-setup/scripts/qmd-setup-context.sh"
  REPO_ROOT=""
else
  info "folder: $REPO_ROOT"
  case "$REPO_ROOT" in
    */.claude/worktrees/*)
      todo "This is a throwaway WORKTREE. Install the skill + CLI from the STABLE"
      todo "folder (e.g. the unzipped qmd-gd) so the ~/.claude/skills/qmd symlink"
      todo "does not point at a worktree that may be deleted."
      ;;
    *)
      ok "qmd-gd folder located"
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

# --- Skill discovery --------------------------------------------------------
# Skills live in this repo under .claude/skills/, so Claude Code auto-discovers
# them whenever it is opened in this folder (no install needed). The check below
# is only about making the qmd SEARCH skill available from OTHER folders too, via
# a global symlink at ~/.claude/skills/qmd.
section "Skill discovery"
if [[ -n "$REPO_ROOT" && -f "$REPO_ROOT/.claude/skills/qmd/SKILL.md" ]]; then
  ok "qmd + qmd-setup skills present in this checkout — auto-discovered when Claude Code opens here."
fi
CLAUDE_SKILL="$HOME/.claude/skills/qmd"
if [[ -e "$CLAUDE_SKILL" || -L "$CLAUDE_SKILL" ]]; then
  if [[ -L "$CLAUDE_SKILL" ]]; then
    ok "~/.claude/skills/qmd -> $(readlink "$CLAUDE_SKILL") (available in any folder)"
  else
    ok "~/.claude/skills/qmd present (directory)"
  fi
else
  todo "qmd search skill not global yet (optional). To use it outside this folder:"
  todo "    qmd skill install --global   # symlinks ~/.claude/skills/qmd -> this checkout"
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

# --- Embedding model --------------------------------------------------------
# The default embedding model is VENDORED in the repo (models/), so it ships in
# the zip and the default path needs NO download. Only a non-default hf: override
# needs the network; QMD_EMBED_MODEL pointing at a local file needs none.
section "Embedding model"
EMBED="${QMD_EMBED_MODEL:-}"
BUNDLED="$REPO_ROOT/models/bge-small-en-v1.5-Q8_0.gguf"
if [[ -n "$EMBED" && -f "$EMBED" ]]; then
  ok "QMD_EMBED_MODEL points at a local file ($EMBED) — no download needed."
elif [[ -n "$EMBED" && "$EMBED" == hf:* ]]; then
  todo "QMD_EMBED_MODEL is an hf: URI ($EMBED) — needs network. Test reachability first (USER runs):"
  todo "    bash .claude/skills/qmd-setup/scripts/preflight-deps.sh"
elif [[ -n "$REPO_ROOT" && -f "$BUNDLED" ]]; then
  ok "default model vendored in-repo (models/bge-small-en-v1.5-Q8_0.gguf) — embeds with NO network."
else
  todo "Default model missing from models/ — the extract may be incomplete; re-unzip the archive."
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

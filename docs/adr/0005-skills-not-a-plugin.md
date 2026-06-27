# ADR 0005 — Ship as plain skills (`.claude/skills/`), not a Claude Code plugin

**Status:** Accepted (2026-06-27)

## Context

Upstream qmd ships a `.claude-plugin/marketplace.json` so its skills install as a Claude Code
**plugin**. The target environment **disallows third-party Claude Code plugins** — but plain
**skills** are allowed. We also want a non-SWE user to start with the least ceremony: download
the repo, open it in Claude Code, and go.

Claude Code skill discovery (verified against the docs):

- A top-level `skills/` folder is **not** auto-discovered.
- `./.claude/skills/<name>/SKILL.md` **is** auto-discovered as a project skill — no install.
- `~/.claude/skills/<name>/SKILL.md` is auto-discovered globally.
- A plugin/marketplace requires an explicit `/plugin install` — not available here.
- GitHub "Download ZIP" does **not** preserve symlinks.

## Decision

Ship qmd-gd as **plain skills, not a plugin.** Remove `.claude-plugin/marketplace.json` and put
the skills under **`.claude/skills/`** (`qmd`, `qmd-setup`, `ask-qmd`), so Claude Code
auto-discovers them when the repo folder is opened — zero install, no plugin. For use from
*other* folders, `qmd skill install --global` creates a **live symlink**
`~/.claude/skills/<name>` → `<checkout>` (so a later `git pull` keeps it current). `qmd-setup`
is intentionally checkout-local — it only guides setup of this repo, so it is not symlinked
globally.

This pairs with ADR 0003 (no MCP): the interface is **the CLI plus these auto-discovered
skills**, and nothing requires an install step a locked-down environment would block.

## Alternatives considered

- **Keep the plugin / marketplace.** Rejected: third-party plugins are blocked in the target
  environment.
- **Keep skills in top-level `skills/` and rely on `qmd skill install`.** Rejected: that path is
  not auto-discovered, and `qmd-setup` must be available *before* the CLI is built
  (chicken-and-egg — it's the skill that guides building the CLI).
- **Ship a symlinked `.claude/skills/` in the repo.** Rejected: ZIP downloads flatten symlinks,
  so the skills are committed as **real files** under `.claude/skills/` instead.
- **Copy-install a bootstrap stub into `~/.agents/skills/` (upstream behavior).** Replaced by a
  live symlink to the checkout — no stale copy, `git pull` propagates updates.

## Consequences

- Open the repo in Claude Code → `qmd`, `qmd-setup`, and `ask-qmd` load with **no install**.
- `qmd skill install --global` is now a symlink, not a copy; the CLI's `.agents/skills` copy +
  bootstrap-stub machinery is removed. `qmd skill install --global` symlinks both `qmd` and
  `ask-qmd` (qmd-setup stays checkout-local).
- `.gitignore` tracks `.claude/skills/**` while still ignoring the rest of `.claude/`
  (worktrees, local settings).
- No `.claude-plugin/` manifest ships; the npm `files` list points at `.claude/skills/`.

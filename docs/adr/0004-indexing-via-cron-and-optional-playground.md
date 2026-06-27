# ADR 0004 — Indexing via cron + optional Duo playground; never auto-run by Claude

**Status:** Accepted (2026-06-26)

## Context

Keeping the index fresh means re-running `qmd update` (scan changed files) and `qmd embed`
(embed new/changed chunks). This is heavy, touches local state, and — for `embed` — runs the
local embedding model. Two standing rules apply:

- Claude must **never ad-hoc auto-run** index mutation (`qmd collection add/update/embed`).
- The environment permits **cron for indexing** but not for generative inference.

The user runs inside the Duo app, which already has a built-in scheduler
(`duo cron add/list/run/...`, persisted to `~/.claude/duo/cron-jobs.json`). Today every Duo
cron job launches an interactive Claude session; it explicitly blocks headless `-p`.

## Decision

Indexing is **user-configured automation**, triggered by a scheduler — not by Claude deciding
to mutate on its own. Primary mechanism: **Duo's scheduler running a plain shell command**.

Because batch re-index needs no LLM, we extend Duo (its own repo, `dudgeon/duo`) with a
**shell cron job type** (`duo cron add --run "qmd update && qmd embed"`) so the scheduler runs
the commands directly, with no Claude session involved (see the Duo shell-job PR). The same PR
adds native schedule-editing for shell jobs in Duo's Home view, so the user can
run/pause/resume and change periodicity without Claude. The `--catch-up` flag means a run due
while Duo was closed fires once on next launch — covering the daily-driver "closed overnight"
case. Until the PR lands, the interim `duo cron add --say "..."` Claude-session form schedules it.

A friendly `qmd-setup` skill (manual-invoke) sequences first-time setup and **prints** the
index-mutating commands for the user to run — it never auto-runs them.

## Alternatives considered

- **Claude triggers indexing with a per-run approval gate.** Rejected: keeps heavy, sandboxed
  work in the agent's hands and conflicts with the never-auto-run rule.
- **Routing the management actions (pause/resume/edit) through a Claude-driven playground.**
  Rejected as a mistake — these are deterministic cron mutations and have no business going
  through an LLM. Duo's Home view already drives them via the cron service directly.
- **An OS-level launchd agent for unattended refresh when Duo is closed.** Considered and
  dropped: Duo cron's `--catch-up` already refreshes on next launch, which covers the
  daily-Duo-user case, so a separate launchd mechanism was redundant complexity. (Revisit only
  if a "runs with Duo never opened" requirement appears.)
- **Manual-only (skill prints commands, no automation).** Supported as the floor, but cron is
  preferred so the index stays fresh without the user remembering.

## Cost & memory of the scheduled run (measured)

Re-running `qmd update && qmd embed` on a schedule is cheap because both steps are
**incremental** and self-skipping (measured on Node 22, macOS):

- **Unchanged corpus:** `qmd update` re-indexes 0 files; `qmd embed` reports "All content
  hashes already have embeddings" and **returns in ~0.2s without ever loading the model**
  (peak RSS ~108 MB — just CLI + DB). Nothing is recomputed when nothing changed.
- **Changed corpus:** only the changed files are re-indexed (content-hash diff) and only their
  chunks are re-embedded (embed-fingerprint diff) — e.g. 1 changed doc ≈ 1s, peak RSS ~636 MB
  while the model is loaded.
- **Memory release:** the CLI is a one-shot process — the model and llama.cpp contexts are
  freed on process exit. `bin/qmd` also sets `GGML_METAL_NO_RESIDENCY=1` on macOS so Metal does
  not keep the model resident between runs.
- **Catch-up:** Duo cron `--catch-up` re-runs a missed occurrence once on next launch, so the
  index stays fresh without anything running while Duo is closed.

So no gating logic is needed — `qmd update && qmd embed` is already the efficient pattern
(embed self-skips when there is nothing to do).

## Consequences

- The index refreshes on a schedule the user sets up once; Claude never initiates mutation, and
  management (run/pause/resume/edit) is deterministic and native in Duo's Home view.
- The Duo shell-job path runs `qmd embed` unattended (the *allowed* embedding model, not a
  generative LLM). Per the user's policy this is permitted; re-runs are incremental and free when
  the corpus is unchanged (see "Cost & memory" above). If policy ever disallows embed-on-timer,
  the scheduled job runs `qmd update` only and embedding moves to a manual trigger.
- Requires a small upstream change in the Duo repo; until it merges, the interim `--say` job
  covers scheduling. Scheduling lives entirely in Duo — qmd-gd ships no scheduler of its own.

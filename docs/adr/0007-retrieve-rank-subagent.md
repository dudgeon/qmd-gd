# ADR 0007 — Delegate the retrieve-and-rank loop to a Sonnet Task subagent

**Status:** Accepted (2026-06-27)

## Context

ADR 0002 delegates query expansion and reranking to the calling Claude agent. In
practice that agent is often **Opus** (expensive, slow per token), and the search
loop — author `lex:/vec:/hyde:`, run `qmd`, read candidates, rank them — is
mechanical, token-heavy work that does not need Opus-level reasoning. Run inline,
it also clutters the main agent's context with raw candidate dumps.

The `qmd` skill only ever *mentioned* delegating to a cheap subagent ("you may spawn
a Haiku subagent via the Task tool") — there was no actual subagent definition, and
`ask-qmd` ran the whole loop inline on whatever model was driving.

The locked-down environment forbids `claude -p` (headless Claude), but in-session
**Task-tool** subagents are allowed (ADR 0002), and project-local `.claude/agents/`
definitions are auto-discovered like skills — not a plugin (ADR 0005).

## Decision

Ship a real subagent, `.claude/agents/qmd-retrieve.md`, that owns the
**retrieve-and-rank** loop and returns a compact, cited shortlist (docid, `qmd://`
path, one-line why-relevant, key quote) — not a user-facing answer.

- **Model: Sonnet.** Cheaper/faster than Opus, strong enough to author queries and
  judge relevance by reading the sources.
- **Scope: the full loop**, plus a **detail mode** — the caller can re-invoke it with
  a docid to pull more content, so going deeper does not mean re-searching.
- **The caller keeps the user-facing answer and Duo actions.** The subagent returns
  ranked sources; `ask-qmd` (the main agent) composes the cited answer and drives the
  Duo open-source flow — those need conversation context and Duo tools.
- `qmd skill install --global` also symlinks the agent into `~/.claude/agents/`, and
  `ask-qmd` + the `qmd` skill point at it. The skills keep the inline loop as a
  fallback when the subagent is not available.

## Alternatives considered

- **Keep it inline (status quo).** Rejected: burns the expensive main model on
  mechanical work and clutters its context.
- **Haiku subagent.** Cheaper still, but Sonnet ranks subtler relevance better; chosen
  for quality. The agent's `model:` field makes switching a one-line change if cost
  wins.
- **A rank-only subagent** (main agent searches, subagent only judges). Rejected: it
  leaves the retrieval grunt work — query authoring, `qmd get` reads — on the main
  agent; full-loop delegation is the bigger win.

## Consequences

- `ask-qmd` is faster/cheaper under Opus and keeps a cleaner context (a shortlist, not
  raw dumps).
- One more moving part: a subagent invocation. If the environment restricts model
  selection (no Sonnet available), change the agent's `model:` field (e.g. to
  `inherit`).

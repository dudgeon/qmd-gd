# ADR 0002 — Delegate query expansion and reranking to the calling agent

**Status:** Accepted (2026-06-26) · the no-op-quarantine consequence below is superseded by [ADR 0006](0006-remove-vestigial-generative-surface.md)

## Context

Upstream qmd runs two **generative** models locally via `node-llama-cpp`:

- **Query expansion** (a 1.7B model) — turns the user's query into typed `lex:`/`vec:`/`hyde:`
  sub-queries before retrieval.
- **Reranking** (a 0.6B reranker) — re-scores the fused candidate set after retrieval.

The target environment forbids running generative LLMs locally. However, qmd is driven by an
already-running Claude agent (in Claude Code / Duo), and using *that* agent's inference is
allowed — as long as qmd never spawns a headless/`-p` Claude process itself.

Two enabling facts in the codebase:
- The agent can already author structured queries: `qmd query` accepts `intent:/lex:/vec:/hyde:`
  fields, and the bundled skill already says "you are a better query expander than the built-in
  model." `hyde:`/`vec:` texts go straight to the **embedding** model — no generative call.
- Retrieval already returns full RRF-fused candidates (with `--no-rerank`), carrying everything
  an agent needs to rerank: `docid`, `file`, `score`, `snippet`, `line`, `title`, `context`.

## Decision

Remove both generative models from every **default** code path and **invert the orchestration**:

1. **Expansion** is done by the calling agent up front, by authoring `lex:/vec:/hyde:` fields.
   qmd no longer calls the local expansion model — not in `hybridQuery` and not in
   `vectorSearchQuery` (the `qmd vsearch` path).
2. **Reranking** is done by the calling agent (optionally via a Haiku subagent through the Task
   tool — **never `claude -p`**) over the returned candidates. Reranking is **off by default**;
   `qmd query` returns RRF-fused candidates.

qmd-gd never invokes Claude. The skill (ADR 0003 area) teaches the loop:
**author structured query → `qmd query --format json` → read candidates / `qmd get` → rerank.**

## Alternatives considered

- **Drop expansion + rerank entirely, no agent involvement.** Simplest, but loses the quality
  lift that thoughtful expansion and reranking provide. Rejected — the agent can do both well.
- **Keep the local generative models behind an off-by-default flag for power users.** Rejected:
  policy forbids running them here, and dead generative code invites accidental use and bloats
  first-run downloads.
- **Have qmd shell out to `claude -p` for expansion/rerank.** Explicitly forbidden (no headless
  Claude). Rejected.

## Consequences

- No local generative inference runs in qmd-gd. First-run model download drops to embeddings
  only (~350 MB vs ~2.2 GB).
- `--no-rerank` becomes a no-op alias kept for back-compat. Under `--explain`, `rerankScore` is
  a constant `0` and `blendedScore == score` (pure RRF).
- The public SDK names `QMDStore.expandQuery` and `SearchOptions.rerank` are **quarantined as
  no-ops** rather than deleted, to avoid breaking the API surface. The internal generative code
  (`ensureGenerateModel`, `ensureRerankModel`, GBNF grammar) has now been removed.
  **Superseded by [ADR 0006](0006-remove-vestigial-generative-surface.md):** the quarantined
  no-op surface (`expandQuery`, `rerank`, `--no-rerank`, `chunkStrategy`) was subsequently
  deleted outright.
- Result quality now depends on the agent authoring good structured queries — which the skill
  already emphasizes and the agent is well-suited to do.

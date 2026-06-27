# ADR 0001 — Keep the local embedding model

**Status:** Accepted (2026-06-26)

## Context

qmd's semantic search depends on a text embedding model that must run at **both** index time
(embedding every chunk) and query time (embedding the query, `vec:`, and `hyde:` texts).
Upstream uses a local GGUF embedding model (`embeddinggemma-300M`) via `node-llama-cpp`.

The target environment forbids running "arbitrary LLM inference models." The operative policy
distinguishes **generative LLMs** from **embedding models**: local embedding models are
permitted, and there is existence proof of their use in other internal projects.

Embeddings are also the one inference step that **cannot** be delegated to the calling Claude
agent: the Claude API exposes no embeddings endpoint to the agent, and embedding thousands of
chunks through the agent loop is infeasible. Something must run a real embedding service.

## Decision

Keep the existing **local embedding model on its current default** (`embeddinggemma-300M` via
`node-llama-cpp`). It remains the only local model qmd-gd runs. No change to the embedding
code path; we simply stop running the *generative* models around it (see ADR 0002).

## Alternatives considered

- **Lighter local runtime (ONNX / transformers.js).** Friendlier install for non-SWEs (no
  native llama.cpp compile), still fully local/offline. Rejected for now to minimize fork
  divergence; revisit if first-run install proves too heavy for PM users.
- **Hosted embeddings API (Voyage/OpenAI/etc.).** Easiest runtime, no local model — but sends
  chunk text off-device and may run afoul of policy. Rejected; keep everything on-device.
- **No embeddings — BM25/FTS only.** Zero inference of any kind, but loses semantic search
  entirely (qmd degrades to a fast ranked multi-repo grep). Rejected; semantic recall is the
  core value over plain `grep`/`rg`.

## Consequences

- Semantic search is preserved; the engine stays fully on-device and offline-capable.
- First-run still downloads ~350 MB (embedding model only) and loads native llama.cpp with
  Metal/CPU. This is now the *entire* model footprint — down from ~2.2 GB once the generative
  models are dropped (ADR 0002).
- Query-time embedding is a small local inference that Claude's sandbox may gate; the skill
  documents `qmd search` (pure BM25, zero inference) as the fallback.
- Embedding on an unattended schedule (cron) is treated as permitted under the embedding
  carve-out; if policy disallows it, scheduled jobs run `qmd update` (scan only) and embedding
  moves to a manual/playground trigger (see ADR 0004).

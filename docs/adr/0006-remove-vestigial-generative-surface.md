# ADR 0006 — Delete removed-capability surface instead of quarantining it as no-ops

**Status:** Accepted (2026-06-27)

## Context

qmd-gd sheds upstream capability inconsistently. The MCP server (ADR 0003) and
AST/tree-sitter chunking were **deleted outright** — no command, no flag, no stub.
But when ADR 0002 removed the local generative models, it **quarantined** the
reranking/expansion surface as no-ops "to avoid breaking the API surface":

- `--no-rerank` (CLI) — parsed, ignored.
- `SearchOptions.rerank` (SDK) — accepted, ignored.
- `QMDStore.expandQuery()` — returns `[]`.
- `chunkStrategy` / `ChunkStrategy` — a single-value (`"regex"`) type threaded through
  the SDK and the chunkers but read by nothing (the AST/`"auto"` branch went with
  `src/ast.ts`). The chunkers also carried a sibling vestigial `filepath` param (the
  former AST file-type hint).

The result was doc/code drift: `src/index.ts`, `src/store.ts`, and `src/cli/qmd.ts`
still described "query expansion" and "candidates to rerank" as live behavior, and the
SDK/CLI surface advertised options that do nothing.

Two facts remove the original justification:

- **qmd-gd is a hard fork with no sync-back** to `tobi/qmd` — there is no upstream
  merge whose diff a stub would keep clean.
- **`private: true`, not published to npm** — there are effectively no external SDK
  consumers whose code a stub would keep compiling.

So "avoid breaking the API surface" protected an audience of zero, at the cost of a
surface that misrepresents what the engine does.

## Decision

Apply the ADR 0003 rule uniformly: a removed capability leaves **no** surface behind.

1. **Delete the dead generative surface:** the `--no-rerank` flag,
   `SearchOptions.rerank`, `QMDStore.expandQuery()`, and `ExpandQueryOptions`.
2. **Delete the vestigial chunking surface:** `chunkStrategy` / `ChunkStrategy` from the
   SDK (`SearchOptions`, `embed()`) and the internal chunkers, plus the dead `filepath`
   chunker params.
3. **Keep, but correctly document, the surface that still works** and was only
   mislabeled as rerank-related:
   - `candidateLimit` / `-C` — the RRF fusion candidate-pool size (not "candidates to
     rerank").
   - `--intent` / `intent` — steers snippet/chunk selection and disables the
     strong-signal bypass.
4. This **supersedes** the "quarantined as no-ops" consequence of ADR 0002.

## Alternatives considered

- **Keep them as documented no-ops (ADR 0002 status quo).** Rejected: the
  compatibility rationale assumed upstream sync or external SDK consumers; a private
  hard fork has neither, so the stubs only produce doc drift.
- **Deprecate + warn, remove in a later version.** Rejected: a deprecation cycle is
  ceremony for zero known callers.

## Consequences

- SDK callers using `expandQuery`/`rerank`/`chunkStrategy` break at the type level —
  acceptable; they were already no-ops, and this is a private fork.
- The CLI parser runs with `strict: false`, so a stray `--no-rerank` on the command
  line is now **silently ignored** rather than erroring — removal is non-breaking for
  any script that still passes it. The flag is simply undocumented and inert.
- `chunkStrategy` removal is purely internal: the type had a single value and was read
  by nothing, so chunking behavior is unchanged (regex/markdown for every file type).
- The same change corrects the stale "rerank/expansion" wording in `src/index.ts`,
  `src/store.ts`, `src/cli/qmd.ts`, `src/bench/bench.ts`, `src/maintenance.ts`, the
  README, and `CLAUDE.md`, and updates the SDK tests (`test/sdk.test.ts`,
  `test/store.test.ts`).
- The YAML `models.rerank` / `models.generate` keys remain **tolerated-but-ignored**
  in config (`ModelsConfig`) — that is config-file forward/back-compat, not API
  surface, and is out of scope for this ADR.

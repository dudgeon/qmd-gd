# Architecture Decision Records

This directory records the significant architecture decisions for the **qmd-gd** fork.

qmd-gd adapts upstream `qmd` for a locked-down environment where a non-SWE Product Manager
runs it inside Claude Code / the Duo app. The constraints (no MCP, no local *generative* LLM
inference, embeddings allowed, generative work delegated to the calling Claude agent without
`claude -p`, indexing via cron) drive the decisions below.

Each ADR uses: **Status · Context · Decision · Alternatives considered · Consequences**.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-keep-local-embedding-model.md) | Keep the local embedding model | Accepted |
| [0002](0002-delegate-generative-steps-to-the-agent.md) | Delegate query expansion and reranking to the calling agent | Accepted |
| [0003](0003-remove-mcp.md) | Remove the MCP server; CLI + skills are the interface | Accepted |
| [0004](0004-indexing-via-cron-and-optional-playground.md) | Indexing via cron + optional Duo playground; never auto-run by Claude | Accepted |
| [0005](0005-skills-not-a-plugin.md) | Ship as plain skills (`.claude/skills/`), not a Claude Code plugin | Accepted |
| [0006](0006-remove-vestigial-generative-surface.md) | Delete removed-capability surface instead of quarantining it as no-ops | Accepted |

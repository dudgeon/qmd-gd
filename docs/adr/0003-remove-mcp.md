# ADR 0003 — Remove the MCP server; CLI + skills are the interface

**Status:** Accepted (2026-06-26)

## Context

Upstream qmd ships an MCP server (`qmd mcp`, stdio + HTTP transports) exposing `query`, `get`,
`multi_get`, and `status` tools to MCP clients. The target environment **prohibits MCP servers**
of any kind, local or remote.

The MCP layer is a thin, fully-removable adapter: it lives in a single file
(`src/mcp/server.ts`) plus the `mcp` case in the CLI, and delegates to the same `QMDStore`
facade the CLI uses. The SDK (`src/index.ts`) does not import it. The CLI already does
everything MCP does — `qmd search`, `qmd query`, `qmd get`, `qmd multi-get`, `qmd status`.

## Decision

**Remove MCP entirely.** The CLI is the engine and the interface; a bundled **skill** teaches
the calling Claude agent how to drive it. An optional Duo playground may augment this for
visual search/monitoring, but it is never required.

Removal surface: delete `src/mcp/server.ts` and `test/mcp.test.ts`; remove the `mcp` CLI case
and its dynamic imports; remove the MCP stdout-quiet block in `bin/qmd`; drop the
`@modelcontextprotocol/sdk` dependency, the `inspector` npm script, and the `mcp` keyword;
scrub MCP references from README / CLAUDE.md / the skill.

## Alternatives considered

- **Keep MCP code dormant (disabled) in case the rule changes.** Rejected: dead transport code
  carries a banned dependency and invites accidental use; git history preserves it if needed.
- **Replace MCP with a plain local HTTP API (no MCP framing).** Rejected: a local server is the
  shape the environment is avoiding, and the CLI already covers every use case.

## Consequences

- One banned dependency (`@modelcontextprotocol/sdk`) leaves the tree; lockfiles regenerate.
- `qmd mcp` becomes an unknown command. Any external MCP client integration is dropped (none
  exists in the target environment).
- Core search logic in `src/store.ts` and the SDK in `src/index.ts` are untouched — the change
  is purely removing the transport adapter.

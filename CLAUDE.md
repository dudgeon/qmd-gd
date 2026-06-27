# QMD - Query Markup Documents (qmd-gd fork)

qmd-gd runs on **Node (>=22)** (`npm install`, `npm run build`, `npm link`). After a
Node major upgrade, run `npm rebuild` so native modules (better-sqlite3, sqlite-vec,
node-llama-cpp) match the new ABI.

qmd-gd ships its skills under `.claude/skills/` and the `qmd-retrieve` subagent under
`.claude/agents/` (no Claude Code plugin). When this folder is opened in Claude Code,
the bundled skills (`qmd`, `qmd-setup`, `ask-qmd`) and the `qmd-retrieve` subagent auto-load.

## Getting set up

When the user asks to **get set up / install qmd / "/setup" / "help me get started"**, read
and follow [`.claude/skills/qmd-setup/SKILL.md`](.claude/skills/qmd-setup/SKILL.md) step by
step. Two hard rules from that skill that you MUST honor:

- **Never run state-mutating commands for the user** (`npm install`, `qmd skill install`,
  `qmd collection add`, `qmd update`, `qmd embed`, `qmd pull`). Print them for the user to run.
- **Never contact an external network domain.** Only `capitalone.com` / `github.com` are
  reachable by you; the user runs anything that hits the npm registry, HuggingFace, or
  prebuilt hosts (including the preflight script) from their own terminal.

The only setup helper you may run yourself is the local, network-free probe
`.claude/skills/qmd-setup/scripts/qmd-setup-context.sh`.

## Commands

```sh
qmd collection add . --name <n>   # Create/index collection
qmd collection list [--json]      # List collections; --json adds scope (includeByDefault) + counts
qmd collection remove <name>      # Remove a collection by name
qmd collection rename <old> <new> # Rename a collection
qmd init                          # Create a project-local .qmd index
qmd ls [collection[/path]]        # List collections or files in a collection
qmd context add [path] "text"     # Add context for path (defaults to current dir)
qmd context list                  # List all contexts
qmd context check                 # Check for collections/paths missing context
qmd context rm <path>             # Remove context
qmd get <file>[:from[:count]]     # Get by path or docid (#abc123); optional line range
qmd multi-get <pattern>           # Get multiple docs by glob or comma-separated list
qmd status [--json]               # Index status (docs, vectors, freshness); --json for agents/dashboard
qmd doctor                        # Diagnose config, index, model, and device issues
qmd update                        # Re-index collections; configured update hooks run first
qmd embed                         # Generate vector embeddings (local embedding model)
qmd query <query>                 # Hybrid BM25 + vector (RRF); you author lex:/vec:/hyde: and rank candidates
qmd search <query>                # Full-text keyword search (BM25, no model)
qmd vsearch <query>               # Vector similarity search (no reranking)
qmd bench <fixture.json>          # Run search-quality benchmarks
```

## Collection Management

```sh
# List all collections
qmd collection list

# Create a collection with explicit name
qmd collection add ~/Documents/notes --name mynotes --mask '**/*.md'

# Remove a collection
qmd collection remove mynotes

# Rename a collection
qmd collection rename mynotes my-notes

# Show collection details
qmd collection show mynotes

# Set or clear the pre-update hook (runs before re-indexing on `qmd update`)
qmd collection update-cmd mynotes 'git pull --ff-only'
qmd collection update-cmd mynotes            # clear

# Include or exclude from default (unscoped) queries
qmd collection exclude mynotes
qmd collection include mynotes

# List all files in a collection
qmd ls mynotes

# List files with a path prefix
qmd ls journals/2025
qmd ls qmd://journals/2025
```

## Context Management

```sh
# Add context to current directory (auto-detects collection)
qmd context add "Description of these files"

# Add context to a specific path
qmd context add /subfolder "Description for subfolder"

# Add global context to all collections (system message)
qmd context add / "Always include this context"

# Add context using virtual paths
qmd context add qmd://journals/ "Context for entire journals collection"
qmd context add qmd://journals/2024 "Journal entries from 2024"

# List all contexts
qmd context list

# Check for collections or paths without context
qmd context check

# Remove context
qmd context rm qmd://journals/2024
qmd context rm /  # Remove global context
```

## Document IDs (docid)

Each document has a unique short ID (docid) - the first 6 characters of its content hash.
Docids are shown in search results as `#abc123` and can be used with `get` and `multi-get`:

```sh
# Search returns docid in results
qmd search "query" --json
# Output: [{"docid": "#abc123", "score": 0.85, "file": "docs/readme.md", ...}]

# Get document by docid
qmd get "#abc123"
qmd get abc123              # Leading # is optional

# Docids also work in multi-get comma-separated lists
qmd multi-get "#abc123, #def456"
```

## Options

```sh
# Search & retrieval
-c, --collection <name>  # Restrict search to collection(s) (repeatable)
-n <num>                 # Number of results
--all                    # Return all matches
--min-score <num>        # Minimum score threshold
--full                   # Show full document content
--intent <text>          # Describe what you're after to sharpen ranking (query)
--full-path              # Show on-disk paths instead of qmd:// URIs

# Get / multi-get
-l <num>                 # Maximum lines per file
--max-bytes <num>        # Skip files larger than this (default 64KB)
--no-line-numbers        # Disable line numbers (on by default for get/multi-get)

# Output format (search, query, multi-get)
--format <kind>          # cli (default) | json | csv | md | xml | files
                         # legacy --json/--csv/--md/--xml/--files still work as aliases
```

## Development

```sh
npx tsx src/cli/qmd.ts <command>   # Run from source (Node)
npm link                           # Install globally as 'qmd'
```

## Tests

All tests live in `test/`. Run everything:

```sh
npx vitest run --reporter=verbose test/
```

## Architecture

- SQLite FTS5 for full-text search (BM25)
- sqlite-vec for vector similarity search
- node-llama-cpp for **embeddings only** (embeddinggemma). qmd-gd runs no local generative models — query expansion and reranking are delegated to the calling Claude agent (see docs/adr/0002).
- Reciprocal Rank Fusion (RRF) for combining results
- Chunking is regex/markdown-only: 900 tokens/chunk with 15% overlap, prefers markdown headings as boundaries. There is no AST/code-aware chunking.

## Important: Do NOT run automatically

- Never run `qmd collection add`, `qmd embed`, or `qmd update` automatically
- Never modify the SQLite database directly
- Write out example commands for the user to run manually
- Index is stored at `~/.cache/qmd/index.sqlite`

## Do NOT compile

- The `qmd` file is a shell script that runs compiled JS from `dist/` - do not replace it
- `npm run build` compiles TypeScript to `dist/` via `tsc -p tsconfig.build.json`

## Changelog

- Add changelog entries under `## [Unreleased]` **as you make changes**.

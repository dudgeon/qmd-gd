# qmd-gd — Query Markup Documents

An on-device search engine for everything you need to remember. Index your markdown notes, meeting transcripts, documentation, and knowledge bases. Search with keywords or natural language. Ideal for your agentic flows.

**qmd-gd** is a fork of [qmd](https://github.com/tobi/qmd) reworked for locked-down environments that forbid MCP servers and local generative-LLM inference. It combines BM25 full-text search and on-device vector semantic search (RRF fusion), running locally via a single **embedding** model. There is **no MCP server** and **no local generative model**: query expansion and reranking are delegated to the calling Claude agent, which authors `lex:/vec:/hyde:` queries and ranks the returned candidates itself. qmd-gd never invokes Claude and never runs `claude -p`. See [`docs/adr/`](docs/adr/) for the rationale.

You can read more about qmd-gd's progress in the [CHANGELOG](CHANGELOG.md).

## Get started (recommended for non-developers)

qmd-gd is a **skills folder**, not a Claude Code plugin — there is nothing to install *into*
Claude Code.

1. On GitHub, click **Code → Download ZIP** and unzip it somewhere stable (e.g. `~/repos/qmd-gd`).
2. Open a terminal in that folder and start Claude Code (`claude`).
3. Say **"help me get set up"** (or run `/qmd-setup`). The bundled `qmd-setup` skill —
   auto-discovered because you opened this folder — walks you through building the CLI, adding
   folders to search, indexing, embedding, and (optionally) scheduling refresh. It prints each
   command for *you* to run; it never installs or downloads anything itself.

> Why it just works: the `qmd` and `qmd-setup` skills live under `.claude/skills/` in the repo,
> which Claude Code auto-discovers when opened here. To use the `qmd` **search** skill from your
> *other* projects too, run `qmd skill install --global` (a live symlink into `~/.claude/skills/qmd`).

## Quick Start (developers)

```sh
# qmd-gd is a skills folder — clone OR download the repo ZIP from GitHub, then build.
# Runs on Node (>=22). Non-developers: see "Get started" above and just say "help me get set up".
git clone https://github.com/dudgeon/qmd-gd && cd qmd-gd   # or: download the ZIP from GitHub and unzip
npm install && npm run build && npm link   # exposes `qmd` globally

# Create collections for your notes, docs, and meeting transcripts
qmd collection add ~/notes --name notes
qmd collection add ~/Documents/meetings --name meetings
qmd collection add ~/work/docs --name docs

# Add context to help with search results, each piece of context will be returned when matching sub documents are returned. This works as a tree. This is the key feature of QMD as it allows LLMs to make much better contextual choices when selecting documents. Don't sleep on it!
qmd context add qmd://notes "Personal notes and ideas"
qmd context add qmd://meetings "Meeting transcripts and notes"
qmd context add qmd://docs "Work documentation"

# Generate embeddings for semantic search
qmd embed

# Search across everything
qmd search "project timeline"           # Fast keyword search
qmd vsearch "how to deploy"             # Semantic search
qmd query "quarterly planning process"  # Hybrid BM25 + vector (RRF); you rank the candidates

# Get a specific document
qmd get "meetings/2024-01-15.md"

# Get a document by docid (shown in search results)
qmd get "#abc123"

# Get multiple documents by glob pattern
qmd multi-get "journals/2025-05*.md"

# Search within a specific collection
qmd search "API" -c notes

# Export all matches for an agent
qmd search "API" --all --files --min-score 0.3
```

### Using with AI Agents

QMD's `--json` and `--files` output formats are designed for agentic workflows:

```sh
# Get structured results for an LLM
qmd search "authentication" --json -n 10

# List all relevant files above a threshold
qmd query "error handling" --all --files --min-score 0.4

# Retrieve full document content
qmd get "docs/api-reference.md" --full
```

### Using with Claude Code / agents (no MCP)

qmd-gd has **no MCP server and no Claude Code plugin** — the CLI *is* the interface, and the
skills are plain folders under `.claude/skills/`. Opening this repo in Claude Code auto-loads
the `qmd` and `ask-qmd` skills. To use them from your *other* projects too, symlink them into
your user skills:

```bash
qmd skill install --global   # live symlinks: ~/.claude/skills/{qmd,ask-qmd} -> this checkout
```

(First time on a machine? Open this folder in Claude Code and say "help me get set up" — the
`qmd-setup` skill sequences build/link → add collections → set the default ask scope → index →
embed → verify.)

Once set up, the quickest path is the **`/ask-qmd`** skill — ask a question, get a cited answer
from your default-scoped knowledge base, no flags to remember:

```
/ask-qmd what were the takeaways from the last QBR meeting?
```

It authors the structured query, retrieves + reads the top sources, and answers with citations.
The scope is whatever you marked default-included at setup (`qmd collection include/exclude`).
If you run setup inside **Duo**, it opens a small **scope playground** showing exactly what
`/ask-qmd` searches, with a one-click "Change scope" button (it spawns a Claude tab to retune
`include`/`exclude` and regenerates the view). Under the hood `/ask-qmd` runs the same loop the
`qmd` skill teaches:

The skill teaches the agent-driven loop: **author a structured query → retrieve →
rank the candidates yourself.** qmd-gd does no query expansion or reranking with a
local model — the agent supplies the `lex:/vec:/hyde:` variants and judges the
returned candidates (optionally via a Haiku subagent through the Task tool — never
`claude -p`):

```sh
# Author the query yourself; qmd-gd embeds + retrieves + fuses (RRF) and returns candidates.
qmd query --format json $'intent: what to find and what to avoid\nlex: exact terms titles symbols\nvec: natural-language paraphrase\nhyde: a hypothetical passage that would answer this'

# Then read/rank the candidates and pull the winners:
qmd get "#abc123:120:40"
```

If the local embedding model is unavailable (e.g. a sandbox blocks it at query time),
fall back to `qmd search` — pure BM25, zero inference.

### SDK / Library Usage

Use QMD as a library in your own Node.js applications.

#### Installation

qmd-gd is a private fork and is **not published to npm**. Install it from the
checkout and depend on it locally (e.g. `npm install /path/to/qmd-gd`, or add a
`file:` dependency in your `package.json`).

```sh
git clone https://github.com/dudgeon/qmd-gd && cd qmd-gd
npm install && npm run build
```

#### Quick Start

```typescript
import { createStore } from 'qmd-gd'

const store = await createStore({
  dbPath: './my-index.sqlite',
  config: {
    collections: {
      docs: { path: '/path/to/docs', pattern: '**/*.md' },
    },
  },
})

const results = await store.search({ query: "authentication flow" })
console.log(results.map(r => `${r.title} (${Math.round(r.score * 100)}%)`))

await store.close()
```

#### Store Creation

`createStore()` accepts three modes:

```typescript
import { createStore } from 'qmd-gd'

// 1. Inline config — no files needed besides the DB
const store = await createStore({
  dbPath: './index.sqlite',
  config: {
    collections: {
      docs: { path: '/path/to/docs', pattern: '**/*.md' },
      notes: { path: '/path/to/notes' },
    },
  },
})

// 2. YAML config file — collections defined in a file
const store2 = await createStore({
  dbPath: './index.sqlite',
  configPath: './qmd.yml',
})

// 3. DB-only — reopen a previously configured store
const store3 = await createStore({ dbPath: './index.sqlite' })
```

#### Search

The unified `search()` method handles both simple queries and agent-authored structured queries:

```typescript
// Simple query — seeds BM25 + vector retrieval (no generative expansion); returns RRF candidates
const results = await store.search({ query: "authentication flow" })

// With options
const results2 = await store.search({
  query: "rate limiting",
  intent: "API throttling and abuse prevention",
  collection: "docs",
  limit: 5,
  minScore: 0.3,
  explain: true,
})

// Structured queries — you author each sub-query (the agent does the expansion)
const results3 = await store.search({
  queries: [
    { type: 'lex', query: '"connection pool" timeout -redis' },
    { type: 'vec', query: 'why do database connections time out under load' },
  ],
  collections: ["docs", "notes"],
})

// `rerank` is accepted but is a no-op in qmd-gd — results are always RRF-fused candidates
const fast = await store.search({ query: "auth", rerank: false })
```

For direct backend access:

```typescript
// BM25 keyword search (fast, no LLM)
const lexResults = await store.searchLex("auth middleware", { limit: 10 })

// Vector similarity search (embedding model, no reranking)
const vecResults = await store.searchVector("how users log in", { limit: 10 })

// `expandQuery` is a no-op in qmd-gd (returns []) — kept for API compatibility.
// Author your own sub-queries and pass them to search({ queries: [...] }) instead.
const expanded = await store.expandQuery("auth flow", { intent: "user login" }) // => []
```

#### Retrieval

```typescript
// Get a document by path or docid
const doc = await store.get("docs/readme.md")
const byId = await store.get("#abc123")

if (!("error" in doc)) {
  console.log(doc.title, doc.displayPath, doc.context)
}

// Get document body with line range
const body = await store.getDocumentBody("docs/readme.md", {
  fromLine: 50,
  maxLines: 100,
})

// Batch retrieve by glob or comma-separated list
const { docs, errors } = await store.multiGet("docs/**/*.md", {
  maxBytes: 20480,
})
```

#### Collections

```typescript
// Add a collection
await store.addCollection("myapp", {
  path: "/src/myapp",
  pattern: "**/*.ts",
  ignore: ["node_modules/**", "*.test.ts"],
})

// List collections with document stats
const collections = await store.listCollections()
// => [{ name, pwd, glob_pattern, doc_count, active_count, last_modified, includeByDefault }]

// Get names of collections included in queries by default
const defaults = await store.getDefaultCollectionNames()

// Remove / rename
await store.removeCollection("myapp")
await store.renameCollection("old-name", "new-name")
```

#### Context

Context adds descriptive metadata that improves search relevance and is returned alongside results:

```typescript
// Add context for a path within a collection
await store.addContext("docs", "/api", "REST API reference documentation")

// Set global context (applies to all collections)
await store.setGlobalContext("Internal engineering documentation")

// List all contexts
const contexts = await store.listContexts()
// => [{ collection, path, context }]

// Remove context
await store.removeContext("docs", "/api")
await store.setGlobalContext(undefined)  // clear global
```

#### Indexing

```typescript
// Re-index collections by scanning the filesystem
const result = await store.update({
  collections: ["docs"],  // optional — defaults to all
  onProgress: ({ collection, file, current, total }) => {
    console.log(`[${collection}] ${current}/${total} ${file}`)
  },
})
// => { collections, indexed, updated, unchanged, removed, needsEmbedding }

// Generate vector embeddings
const embedResult = await store.embed({
  force: false,           // true to re-embed everything
  onProgress: ({ current, total, collection }) => {
    console.log(`Embedding ${current}/${total}`)
  },
})
```

#### Types

Key types exported for SDK consumers:

```typescript
import type {
  QMDStore,            // The store interface
  SearchOptions,       // Options for search()
  LexSearchOptions,    // Options for searchLex()
  VectorSearchOptions, // Options for searchVector()
  HybridQueryResult,   // Search result with score, snippet, context
  SearchResult,        // Result from searchLex/searchVector
  ExpandedQuery,       // Typed sub-query { type: 'lex'|'vec'|'hyde', query }
  DocumentResult,      // Document metadata + body
  DocumentNotFound,    // Error with similarFiles suggestions
  MultiGetResult,      // Batch retrieval result
  UpdateProgress,      // Progress callback info for update()
  UpdateResult,        // Aggregated update result
  EmbedProgress,       // Progress callback info for embed()
  EmbedResult,         // Embedding result
  StoreOptions,        // createStore() options
  CollectionConfig,    // Inline config shape
  IndexStatus,         // From getStatus()
  IndexHealthInfo,     // From getIndexHealth()
} from 'qmd-gd'
```

Utility exports:

```typescript
import {
  extractSnippet,              // Extract a relevant snippet from text
  addLineNumbers,              // Add line numbers to text
  DEFAULT_MULTI_GET_MAX_BYTES, // Default max file size for multiGet (64KB)
  Maintenance,                 // Database maintenance operations
} from 'qmd-gd'
```

#### Lifecycle

```typescript
// Close the store — disposes the embedding model + DB connection
await store.close()
```

The SDK requires explicit `dbPath` — no defaults are assumed. This makes it safe to embed in any application without side effects.

## Architecture

> **qmd-gd note:** qmd-gd is retrieval-only. It runs a single local model — the
> **embedding** model — and never performs query expansion or LLM re-ranking. The
> calling agent authors the typed `lex:/vec:/hyde:` sub-queries and ranks the
> returned candidates itself. The SDK's `rerank`/`expandQuery` surface is a no-op
> kept for compatibility. See
> [`docs/adr/0002`](docs/adr/0002-delegate-generative-steps-to-the-agent.md).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      qmd-gd Hybrid Retrieval Pipeline                       │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌─────────────────┐
                              │      Query      │
                              │ (you author the │
                              │  sub-queries)   │
                              └────────┬────────┘
                                       │
                        ┌──────────────┴──────────────┐
                        ▼                             ▼
               ┌─────────────────┐           ┌──────────────────────┐
               │   BM25 (FTS5)   │           │ Vector Search        │
               │ keyword ranking │           │ (embedding model)    │
               └────────┬────────┘           └──────────┬───────────┘
                        │                               │
                        └───────────────┬───────────────┘
                                        ▼
                          ┌───────────────────────────┐
                          │        RRF Fusion         │
                          │  score = Σ 1/(k+rank+1)    │
                          └─────────────┬─────────────┘
                                        ▼
                          ┌───────────────────────────┐
                          │  Ranked candidate docs    │
                          │  (the agent ranks these)  │
                          └───────────────────────────┘
```

## Score Normalization & Fusion

### Search Backends

| Backend | Raw Score | Conversion | Range |
|---------|-----------|------------|-------|
| **FTS (BM25)** | SQLite FTS5 BM25 | `Math.abs(score)` | 0 to ~25+ |
| **Vector** | Cosine distance | `1 / (1 + distance)` | 0.0 to 1.0 |

### Fusion Strategy

The `query` command uses **Reciprocal Rank Fusion (RRF)**. The RRF score is the
final score — qmd-gd does not re-rank:

1. **Parallel Retrieval**: Each sub-query searches both FTS and vector indexes
2. **RRF Fusion**: Combine all result lists using `score = Σ(1/(k+rank+1))` where k=60
3. **Top-Rank Bonus**: Documents ranking #1 in any list get +0.05, #2-3 get +0.02
4. **Top-K Selection**: Return the top candidates, ordered by RRF score

**Why this approach**: RRF fuses keyword and semantic signals into a single robust
ranking without needing a generative model. The top-rank bonus preserves documents
that score #1 in any individual sub-query. Because qmd-gd delegates re-ranking to
the calling agent, the returned candidates are the RRF-fused set for the agent to
judge.

### Score Interpretation

| Score | Meaning |
|-------|---------|
| 0.8 - 1.0 | Highly relevant |
| 0.5 - 0.8 | Moderately relevant |
| 0.2 - 0.5 | Somewhat relevant |
| 0.0 - 0.2 | Low relevance |

## Requirements

### System Requirements

- **Node.js** >= 22 — the runtime. better-sqlite3 bundles a capable SQLite, so no
  separate SQLite install is needed for the sqlite-vec extension.

### GGUF Model (via node-llama-cpp)

qmd-gd uses **one** local GGUF model — the embedding model — auto-downloaded on first use:

| Model | Purpose | Size |
|-------|---------|------|
| `embeddinggemma-300M-Q8_0` | Vector embeddings (default) | ~300MB |

It is downloaded from HuggingFace and cached in `~/.cache/qmd/models/`. (Upstream qmd
also ran a `qwen3-reranker` and a `qmd-query-expansion` model; qmd-gd delegates those
steps to the calling agent, so they are **never downloaded** — see
[ADR 0002](docs/adr/0002-delegate-generative-steps-to-the-agent.md).)

### Custom Embedding Model

Override the default embedding model via the `QMD_EMBED_MODEL` environment variable.
This is useful for multilingual corpora (e.g. Chinese, Japanese, Korean) where
`embeddinggemma-300M` has limited coverage.

```sh
# Use Qwen3-Embedding-0.6B for better multilingual (CJK) support
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"

# After changing the model, re-embed all collections:
qmd embed -f
```

Supported model families:
- **embeddinggemma** (default) — English-optimized, small footprint
- **Qwen3-Embedding** — Multilingual (119 languages including CJK), MTEB top-ranked

> **Note:** When switching embedding models, you must re-index with `qmd embed -f`
> since vectors are not cross-compatible between models. The prompt format is
> automatically adjusted for each model family.

## Installation

qmd-gd is a private fork installed from the checkout (not published to npm). It runs on
**Node (>=22)**.

```sh
git clone https://github.com/dudgeon/qmd-gd
cd qmd-gd
npm install      # builds native deps (better-sqlite3, sqlite-vec, node-llama-cpp) for your Node
npm run build    # compiles dist/ via tsc
npm link         # or: npm i -g .
```

After a Node major-version upgrade, run `npm rebuild` so the native modules match the new ABI.

### Development

```sh
npx tsx src/cli/qmd.ts <command>   # run from source
```

## Usage

### Collection Management

```sh
# Create a collection from current directory
qmd collection add . --name myproject

# Create a collection with explicit path and custom glob mask
qmd collection add ~/Documents/notes --name notes --mask "**/*.md"

# List all collections
qmd collection list

# Remove a collection
qmd collection remove myproject

# Rename a collection
qmd collection rename myproject my-project

# List files in a collection
qmd ls notes
qmd ls notes/subfolder

# Show collection details (path, glob mask, include status, context count)
qmd collection show notes

# Include or exclude a collection from default (unscoped) queries
qmd collection include notes
qmd collection exclude notes

# Run a command before every `qmd update` (e.g. git pull); empty arg clears it
qmd collection update-cmd notes 'git pull --rebase'
qmd collection update-cmd notes
```

### Generate Vector Embeddings

```sh
# Embed all indexed documents (900 tokens/chunk, 15% overlap)
qmd embed

# Force re-embed everything
qmd embed -f

# Memory control for large corpora / constrained systems
qmd embed --max-docs-per-batch 50   # cap docs per embedding batch
qmd embed --max-batch-mb 64         # cap batch size in MB
```

Chunking is **regex/markdown-only** (~900 tokens per chunk, 15% overlap,
preferring markdown heading boundaries). There is no AST/code-aware chunking.

### Context Management

Context adds descriptive metadata to collections and paths, helping search understand your content.

```sh
# Add context to a collection (using qmd:// virtual paths)
qmd context add qmd://notes "Personal notes and ideas"
qmd context add qmd://docs/api "API documentation"

# Add context from within a collection directory
cd ~/notes && qmd context add "Personal notes and ideas"
cd ~/notes/work && qmd context add "Work-related notes"

# Add global context (applies to all collections)
qmd context add / "Knowledge base for my projects"

# List all contexts
qmd context list

# Remove context
qmd context rm qmd://notes/old
```

### Configuring `index.yml`

The `collection` and `context` commands above all read and write a single YAML
config file — you can also edit it directly. Everything QMD knows about your
collections (paths, masks, exclusions, per-collection update hooks, contexts, and
optional model overrides) lives here. A fully-commented starter template ships as
[`example-index.yml`](example-index.yml) in this repo.

**Location:** `~/.config/qmd/index.yml` by default. The directory honors
`XDG_CONFIG_HOME` (→ `$XDG_CONFIG_HOME/qmd/index.yml`) and `QMD_CONFIG_DIR`. A
named index uses `{name}.yml` — `qmd --index work …` reads/writes `work.yml`.
A **project-local** index created with `qmd init` lives at `.qmd/index.yml`
(`.qmd/index.yaml` is also accepted) alongside a project-local `index.sqlite`,
so config and index stay inside the project instead of `~/.config` / `~/.cache`.

```yaml
# ~/.config/qmd/index.yml

# Context applied to every collection (system-message style). Optional.
global_context: "Knowledge base for my projects"

# Terminal hyperlink template for search results. Optional.
# Overridden by the QMD_EDITOR_URI env var. See "Editor Links" below.
editor_uri: "vscode://file{path}:{line}:{col}"

# Override the default embedding GGUF model. Optional — omit to use the
# built-in default. See "Model Configuration" for the default URI. (qmd-gd runs
# only the embedding model; any `rerank`/`generate` entries are ignored.)
models:
  embed: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"

# One entry per collection. The key is the collection name.
collections:
  notes:
    path: /Users/me/notes        # absolute path to index (required)
    pattern: "**/*.md"           # glob mask (default: **/*.md)
    ignore:                      # glob patterns to exclude from indexing
      - "Archive/**"
      - "**/drafts/**"
    update: "git pull --rebase"  # bash command run before each `qmd update`
    includeByDefault: true       # include in unscoped queries (default: true)
    context:                     # path prefix → description; longest match wins
      "/": "Personal notes and ideas"
      "/work": "Work-related notes"
```

| Key | Scope | Purpose |
|-----|-------|---------|
| `global_context` | top-level | Context prepended for every collection. Set via `qmd context add /`. |
| `editor_uri` (alias `editor_uri_template`) | top-level | Hyperlink template for clickable result paths; `QMD_EDITOR_URI` overrides. |
| `models.embed` | top-level | HuggingFace GGUF URI (`hf:<user>/<repo>/<file>`) overriding the built-in embedding model. (Any `rerank`/`generate` keys are ignored by qmd-gd.) |
| `collections.<name>.path` | per-collection | Absolute directory to index. |
| `collections.<name>.pattern` | per-collection | Glob mask. Set via `qmd collection add --mask`. Default `**/*.md`. |
| `collections.<name>.ignore` | per-collection | Glob patterns excluded from indexing — useful to stop nested collections double-indexing. **YAML-only — no CLI command sets this.** Additive with QMD's built-in exclusions (`node_modules`, `.git`, `.cache`, `vendor`, `dist`, `build`), which you cannot un-ignore. |
| `collections.<name>.update` | per-collection | Bash command run before `qmd update` re-indexes this collection. Set via `qmd collection update-cmd`. |
| `collections.<name>.includeByDefault` | per-collection | Whether unscoped queries search it. Toggle with `qmd collection include`/`exclude`. Default `true`. |
| `collections.<name>.context` | per-collection | Path-prefix → description map; the most specific (longest) matching prefix wins. Set via `qmd context add`. |

> **Note:** Editing `index.yml` changes which directories and models QMD *uses*,
> but does not re-index on its own. Run `qmd update` after changing `path`,
> `pattern`, or `ignore`, and `qmd embed` after changing `models.embed`.

#### Automatic update commands

A collection's `update` field is QMD's built-in refresh hook: when you run
`qmd update`, each collection's `update` command runs **first**, then the
collection is re-indexed. This keeps a collection in sync with an upstream source
(a git remote, a sync script) without wrapping `qmd` yourself.

```yaml
collections:
  wiki:
    path: ~/reference/wiki
    update: "git pull --ff-only"
```

    $ qmd update
    [1/3] wiki (**/*.md)
        Running update command: git pull --ff-only
        Already up to date.
    Collection: ~/reference/wiki (**/*.md)
    Indexed: 0 new, 2 updated, 340 unchanged, 0 removed

The command runs via `bash -c` in the collection's own directory (its `path`), not
your current working directory. If it exits non-zero, `qmd update` prints the
failure and **aborts the entire run** — collections after the failing one are not
re-indexed. Set or clear it from the CLI instead of editing YAML by hand:

```sh
qmd collection update-cmd wiki 'git pull --ff-only'   # set
qmd collection update-cmd wiki                         # clear
```

### Search Commands

```
┌──────────────────────────────────────────────────────────────────┐
│                        Search Modes                              │
├──────────┬───────────────────────────────────────────────────────┤
│ search   │ BM25 full-text search only                           │
│ vsearch  │ Vector semantic search only                          │
│ query    │ Hybrid: FTS + Vector + RRF fusion                    │
│          │ (you author lex/vec/hyde; you rank the candidates)   │
└──────────┴───────────────────────────────────────────────────────┘
```

```sh
# Full-text search (fast, keyword-based)
qmd search "authentication flow"

# Vector search (semantic similarity)
qmd vsearch "how to login"

# Hybrid search — BM25 + vector fused with RRF (best recall)
qmd query "user authentication"
```

Two aliases exist for the semantic/hybrid modes: `vector-search` (→ `vsearch`)
and `deep-search` (→ `query`).

### Options

```sh
# Search options
-n <num>           # Number of results (default: 5, or 20 for --files/--json)
-c, --collection   # Restrict search to a specific collection
--all              # Return all matches (use with --min-score to filter)
--min-score <num>  # Minimum score threshold (default: 0)
--full             # Show full document content
--line-numbers     # Add line numbers to output
--explain          # Include retrieval score traces (query, JSON/CLI output)
--index <name>     # Use named index
--intent "<text>"  # Disambiguation context (e.g. "web page load times")
--no-rerank        # No-op (kept for compatibility; qmd-gd never reranks — results are always RRF scores)
-C, --candidate-limit <n>  # Max candidates returned by fusion (default: 40)
--full-path        # Emit on-disk filesystem paths instead of qmd:// URIs

# Output formats (for search and multi-get)
--format <kind>    # cli (default) | json | csv | md | xml | files
                   # (--json, --csv, --md, --xml, --files are legacy aliases)

# Get options
qmd get <file>[:from[:count]]  # Get document; optional start line and count
-l <num>                       # Maximum lines to return
--from <num>                   # Start line (overrides the :from suffix)
--no-line-numbers              # Disable line numbering (on by default)

# Multi-get options
-l <num>           # Maximum lines per file
--max-bytes <num>  # Skip files larger than N bytes (default: 64KB)
```

### Collection Filtering

The `-c`/`--collection` flag filters results by collection **name** (as shown by
`qmd collection list`). Collections are a global registry — you can search any
collection from any directory:

```sh
qmd search "auth" -c notes           # single collection
qmd search "auth" -c notes -c docs   # multiple collections (OR)
```

With no `-c` flag, all default-included collections are searched. Collections
marked excluded (`qmd collection exclude <name>`) are skipped unless named
explicitly with `-c`.

> **Note:** With multiple `-c` flags, results come from a global top-K pool and are
> then filtered. If one collection dominates the rankings, matches from smaller
> collections may not appear at the default limit — raise `-n` or use `--all`.

### Output Format

Default output is colorized CLI format (respects `NO_COLOR` env).

When stdout is a TTY, result paths are emitted as clickable terminal hyperlinks (OSC 8). Clicking a path opens the file in your editor using an editor URI template.

When stdout is not a TTY (for example piped to another command or redirected to a file), QMD emits plain text paths with no escape sequences.

TTY example:

```
docs/guide.md:42 #a1b2c3
Title: Software Craftsmanship
Context: Work documentation
Score: 93%

This section covers the **craftsmanship** of building
quality software with attention to detail.
See also: engineering principles


notes/meeting.md:15 #d4e5f6
Title: Q4 Planning
Context: Personal notes and ideas
Score: 67%

Discussion about code quality and craftsmanship
in the development process.
```

Configure the editor link target with `QMD_EDITOR_URI` (or `editor_uri` in config):

```sh
# VS Code (default)
export QMD_EDITOR_URI="vscode://file/{path}:{line}:{col}"

# Cursor
export QMD_EDITOR_URI="cursor://file/{path}:{line}:{col}"

# Zed
export QMD_EDITOR_URI="zed://file/{path}:{line}:{col}"

# Sublime Text
export QMD_EDITOR_URI="subl://open?url=file://{path}&line={line}"
```

Template placeholders:
- `{path}` absolute filesystem path (URI-encoded)
- `{line}` 1-based line number
- `{col}` or `{column}` 1-based column number

- **Path**: Collection-relative path (e.g., `docs/guide.md`)
- **Docid**: Short hash identifier (e.g., `#a1b2c3`) - use with `qmd get #a1b2c3`
- **Title**: Extracted from document (first heading or filename)
- **Context**: Path context if configured via `qmd context add`
- **Score**: Color-coded (green >70%, yellow >40%, dim otherwise)
- **Snippet**: Context around match with query terms highlighted

### Examples

```sh
# Get 10 results with minimum score 0.3
qmd query -n 10 --min-score 0.3 "API design patterns"

# Output as markdown for LLM context
qmd search --md --full "error handling"

# JSON output for scripting
qmd query --json "quarterly reports"

# Inspect how each result was scored (RRF fusion math; rerank score is always 0)
qmd query --json --explain "quarterly reports"

# Use separate index for different knowledge base
qmd --index work search "quarterly reports"
```

The `--explain` flag attaches a score breakdown to each result: the FTS/vector
backend scores plus the RRF fusion math (rank, weight, top-rank bonus) and every
sub-query's contribution. The final score is the RRF score; the rerank score is
always `0` in qmd-gd. Abbreviated:

```json
{
  "docid": "#6c90f0",
  "score": 0.89,
  "file": "qmd://qmd/README.md",
  "explain": {
    "ftsScores": [0.892, 0.907],
    "vectorScores": [0.540, 0.484],
    "rrf": {
      "rank": 1,
      "weight": 0.75,
      "baseScore": 0.123,
      "topRankBonus": 0.05,
      "totalScore": 0.173,
      "contributions": [
        { "source": "fts", "queryType": "original", "query": "quarterly reports",
          "rank": 1, "weight": 2, "backendScore": 0.892, "rrfContribution": 0.0328 }
      ]
    }
  }
}
```

### Index Maintenance

```sh
# Show index status and collections with contexts
qmd status

# Re-index all collections. If a collection has a configured update command
# (e.g. `git pull`), it runs first — set one with `qmd collection update-cmd`.
qmd update

# Diagnose the install (runtime, sqlite-vec, embedding fingerprints, GPU probe)
qmd doctor

# Initialize a project-local index in the current directory
qmd init

# Get document by filepath (with fuzzy matching suggestions)
qmd get notes/meeting.md

# Get document by docid (from search results)
qmd get "#abc123"

# Get document starting at line 50, max 100 lines
qmd get notes/meeting.md:50 -l 100

# Read 40 lines starting at line 120 via the :from:count suffix (works with docids)
qmd get notes/meeting.md:120:40
qmd get "#abc123:120:40"

# get / multi-get are line-numbered by default; disable with --no-line-numbers
qmd get notes/meeting.md --no-line-numbers

# Get multiple documents by glob pattern
qmd multi-get "journals/2025-05*.md"

# Get multiple documents by comma-separated list (supports docids)
qmd multi-get "doc1.md, doc2.md, #abc123"

# Limit multi-get to files under 20KB
qmd multi-get "docs/*.md" --max-bytes 20480

# Output multi-get as JSON for agent processing
qmd multi-get "docs/*.md" --json

# Clean up cache and orphaned data
qmd cleanup
```

### Benchmarking

Measure search quality across the search backends with `qmd bench` and a fixture file
of queries with known-relevant documents.

**From a git checkout**, an example fixture and its test corpus ship in the repo:

```sh
# One-time setup (indexes the repo's test corpus into its own collection)
qmd collection add test/eval-docs --name eval-docs
qmd embed -c eval-docs

# Run the benchmark (table output)
qmd bench src/bench/fixtures/example.json

# JSON output for programmatic analysis
qmd bench src/bench/fixtures/example.json --json
```

> The example fixture (`src/bench/fixtures/example.json`) and its test corpus
> (`test/eval-docs/`) exist only in a git checkout — they are **not** part of the
> published npm package. If you installed via `npm`/`npx`, write your own fixture
> (see below) against a collection you have already indexed:
>
> ```sh
> qmd bench my-fixture.json -c my-collection
> ```

Each query runs against these backends, reporting precision@k, recall, MRR, and F1:

| Backend | What it tests | LLM required |
|---------|---------------|--------------|
| `bm25` | Keyword search only (FTS5) | No |
| `vector` | Semantic similarity only | Embedding model |
| `hybrid` | BM25 + vector fusion (RRF) | Embedding model |

**Score interpretation:** `1.00` = perfect (all expected docs in top results),
`0.00` = complete miss. The example fixture typically shows bm25 ~0.50, vector
~0.70, and hybrid ~1.00 — a concrete demonstration of why hybrid search beats
either backend alone.

**Custom fixtures** are JSON:

```json
{
  "description": "My benchmark",
  "version": 1,
  "collection": "my-collection",
  "queries": [
    {
      "id": "find-auth",
      "query": "authentication flow",
      "type": "semantic",
      "expected_files": ["docs/auth-design.md"],
      "expected_in_top_k": 3
    }
  ]
}
```

`expected_files` are collection-relative paths as shown by `qmd ls`. The `type`
field (`exact`, `semantic`, `topical`, `cross-domain`, `alias`) labels queries for
grouping — it does not change search behavior.

> **Heads-up:** if the fixture's collection isn't indexed, bench currently runs to
> completion and reports all zeros with no warning. Verify setup with
> `qmd ls <collection>` first.

## Data Storage

Index stored in: `~/.cache/qmd/index.sqlite`

### Schema

```sql
collections     -- Indexed directories with name and glob patterns
path_contexts   -- Context descriptions by virtual path (qmd://...)
documents       -- Markdown content with metadata and docid (6-char hash)
documents_fts   -- FTS5 full-text index
content_vectors -- Embedding chunks (hash, seq, pos, 900 tokens each)
vectors_vec     -- sqlite-vec vector index (hash_seq key)
llm_cache       -- Cached embedding/query results
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XDG_CACHE_HOME` | `~/.cache` | Cache directory location |
| `XDG_CONFIG_HOME` | `~/.config` | Config directory location (where `index.yml` lives) |
| `QMD_CONFIG_DIR` | unset | Override the config directory outright (takes precedence over `XDG_CONFIG_HOME`) |
| `QMD_LLAMA_GPU` | `auto` | Force llama.cpp GPU backend (`metal`, `vulkan`, `cuda`) or disable GPU with `false` |
| `QMD_FORCE_CPU` | unset | Set to `1`/`true` to force CPU mode before any CUDA/Vulkan/Metal probing. Equivalent CLI flag: `--no-gpu`. |
| `QMD_EMBED_PARALLELISM` | automatic | Override embedding context parallelism (1-8). Windows CUDA defaults to `1` because parallel CUDA contexts can crash with `ggml-cuda.cu:98`; use Vulkan or raise this only if your driver is stable. |

## How It Works

### Indexing Flow

```
Collection ──► Glob Pattern ──► Markdown Files ──► Parse Title ──► Hash Content
    │                                                   │              │
    │                                                   │              ▼
    │                                                   │         Generate docid
    │                                                   │         (6-char hash)
    │                                                   │              │
    └──────────────────────────────────────────────────►└──► Store in SQLite
                                                                       │
                                                                       ▼
                                                                  FTS5 Index
```

### Embedding Flow

Documents are chunked into ~900-token pieces with 15% overlap using smart boundary detection:

```
Document ──► Smart Chunk (~900 tokens) ──► Format each chunk ──► node-llama-cpp ──► Store Vectors
                │                           "title | text"        embedBatch()
                │
                └─► Chunks stored with:
                    - hash: document hash
                    - seq: chunk sequence (0, 1, 2...)
                    - pos: character position in original
```

### Smart Chunking

Instead of cutting at hard token boundaries, QMD uses a scoring algorithm to find natural markdown break points. This keeps semantic units (sections, paragraphs, code blocks) together.

**Break Point Scores:**

| Pattern | Score | Description |
|---------|-------|-------------|
| `# Heading` | 100 | H1 - major section |
| `## Heading` | 90 | H2 - subsection |
| `### Heading` | 80 | H3 |
| `#### Heading` | 70 | H4 |
| `##### Heading` | 60 | H5 |
| `###### Heading` | 50 | H6 |
| ` ``` ` | 80 | Code block boundary |
| `---` / `***` | 60 | Horizontal rule |
| Blank line | 20 | Paragraph boundary |
| `- item` / `1. item` | 5 | List item |
| Line break | 1 | Minimal break |

**Algorithm:**

1. Scan document for all break points with scores
2. When approaching the 900-token target, search a 200-token window before the cutoff
3. Score each break point: `finalScore = baseScore × (1 - (distance/window)² × 0.7)`
4. Cut at the highest-scoring break point

The squared distance decay means a heading 200 tokens back (score ~30) still beats a simple line break at the target (score 1), but a closer heading wins over a distant one.

**Code Fence Protection:** Break points inside code blocks are ignored—code stays together. If a code block exceeds the chunk size, it's kept whole when possible.

Chunking is regex/markdown-only — every file type uses the scoring algorithm above. There is no AST/tree-sitter code-aware chunking.

### Query Flow (Hybrid)

The agent authors the sub-queries; qmd-gd embeds, retrieves, and fuses them with RRF.

```
Sub-queries ──► [lex, vec, hyde, …]   (authored by the agent)
                │
      ┌─────────┴─────────┐
      ▼                   ▼
   Vector Search       FTS (BM25)
   (embedding model)      │
      │                   ▼
      ▼               Ranked List
   Ranked List            │
      │                   │
      └─────────┬─────────┘
                ▼
         RRF Fusion (k=60)
         Top-rank bonus: +0.05/#1, +0.02/#2-3
                │
                ▼
         Ranked candidate docs
         (the agent ranks these)
```

## Model Configuration

qmd-gd runs a single local model — the embedding model — defined in `src/llm.ts` as
a HuggingFace URI:

```typescript
const DEFAULT_EMBED_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
```

Override it without touching source via the `models.embed` key in `index.yml`
(see [Configuring `index.yml`](#configuring-indexyml)) or the `QMD_EMBED_MODEL`
env var. Re-run `qmd embed` after changing the embedding model.

### EmbeddingGemma Prompt Format

```
// For queries
"task: search result | query: {query}"

// For documents
"title: {title} | text: {content}"
```

## License

MIT

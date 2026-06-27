---
name: qmd
description: Search local markdown knowledge bases, notes, docs, and wikis with QMD. Use when users ask to find notes, retrieve documents, inspect a wiki, answer from indexed markdown, or set up QMD access.
license: MIT
compatibility: Requires the qmd CLI (qmd-gd fork). No MCP server, no cloud, no local generative models — you do the expansion and ranking.
metadata:
  author: tobi (qmd-gd fork)
  version: "3.0.0"
allowed-tools: Bash(qmd:*)
---

# QMD - Query Markdown Documents

## How search works

QMD searches local markdown collections: notes, docs, wikis, transcripts, and
project knowledge bases. Use it before web search when the answer may already be
in indexed local files.

**qmd-gd is a retrieval engine, not a search assistant.** It runs a local
embedding model for BM25 + vector retrieval and fuses the results (RRF). It does
**not** expand your query and does **not** rerank results with a model — *you* do
both. That is the whole design: you know the user's goal, so you are the query
expander and the reranker.

The workflow is always:

1. **Expand** — author a structured query (`intent:`/`lex:`/`vec:`/`hyde:`).
2. **Retrieve** — run `qmd query`; it returns RRF-fused candidate documents.
3. **Rank & answer** — read the candidates, `qmd get` the promising ones, judge
   relevance yourself, and answer from the retrieved text, citing paths or docids.

Do not answer from snippets alone when the user needs facts, decisions, quotes,
or nuance. Snippets are only leads.

Typical loop:

```bash
qmd search "merchant reality support interviews" -n 5
# leads: #abc123 concepts/customer-proximity.md; #def432 sources/merchant-call.md
qmd multi-get "#abc123,#def432" --format md
```

**Default to structured `qmd query` with `intent:`, `lex:`, `vec:`, and `hyde:`
fields that you write yourself.** There is no built-in expander to fall back on —
qmd-gd embeds exactly the text you give it. You know the user's actual goal, the
domain vocabulary, and the nearby-but-wrong concepts to avoid, so supply the
`intent:` and craft the lexical and semantic terms deliberately (see
[Pick the right search mode](#pick-the-right-search-mode)).

When reporting what you retrieved, a compact note is enough; do not paste whole
files unless needed:

```text
Retrieved:
- #abc123 concepts/customer-proximity.md
- #def432 sources/merchant-call.md
```

## Pick the right search mode

Use **BM25 lexical search** when you know exact words, titles, names, code
symbols, or rare phrases:

```bash
qmd search "cockpit OKR Goodhart" -n 10
qmd search '"AI Before Headcount"' -c concepts -n 5
```

Use **`qmd query` with structured fields** when the user describes an idea
indirectly, uses different wording than the source, or needs conceptual recall.
**This is the default mode — you write the fields; qmd just retrieves.** Combine
exact anchors with semantic recall:

```bash
qmd query $'intent: Find the concept note about metrics as instruments without letting OKRs replace judgment.\nlex: cockpit instruments OKR Goodhart metrics judgment\nvec: data informed not metric driven product judgment\nhyde: A concept note says metrics are useful like cockpit instruments, but leaders should remain data-informed rather than metric-driven because OKRs and dashboards can Goodhart product judgment.'
```

Structured query fields (you author each one — qmd-gd runs no expansion model):

- `intent:` states what you are trying to find **and what to avoid**. Always
  supply this. It steers ranking away from nearby-but-wrong concepts.
- `lex:` exact terms, aliases, titles, code symbols, and rare words you expect
  in the source. This is your keyword expansion → BM25.
- `vec:` paraphrases the idea in natural language, in source-like wording → vector.
- `hyde:` describes the document or answer that would satisfy the request → vector.

You do not need all four every time, but you should almost always write at least
`intent:` plus one of `lex:`/`vec:`. A bare `qmd query "the user's sentence"`
throws away the context only you have — qmd-gd will just embed that one sentence
verbatim. Prefer the structured form.

If you genuinely have nothing to expand (a single rare token, a verbatim phrase),
that is a job for `qmd search`, not bare `qmd query`:

```bash
qmd query --format json --explain $'intent: ...\nlex: ...\nvec: ...'  # inspect ranking
```

If `qmd query` is slow or the embedding model/GPU setup fails (e.g. the sandbox
blocks the local model at query time), fall back to `qmd search` — it is pure
BM25, runs no model at all, and needs only better lexical terms.

## Rank the candidates yourself

`qmd query` returns candidates scored by **Reciprocal Rank Fusion (RRF)** of BM25
and vector hits — it does **not** rerank them with a model. RRF ordering is a
strong starting point, not a final answer. **You are the reranker.**

After retrieving:

1. Read the returned candidates (`--format json` gives `docid`, `file`, `score`,
   `line`, `title`, `context`, and a `snippet`).
2. `qmd get` / `qmd multi-get` the promising ones to see the actual text.
3. Judge relevance against the user's real intent — promote, demote, or drop
   candidates based on what the documents actually say, not their RRF rank.
4. Answer from the documents you confirmed, citing docids and line numbers.

For the whole search → read → rank loop — especially when you're on an expensive
model (Opus) or the candidate set is large — delegate to the **`qmd-retrieve`
subagent** (Sonnet) via the **Task tool**: give it the question (and any scope) and
it returns a ranked, cited shortlist; re-invoke it with a docid to pull more detail.
**Never shell out to `claude -p` or any headless Claude process**; the Task-tool
subagent is in-session. qmd itself never calls Claude.

qmd-gd never runs a local reranker — `qmd query` always returns RRF-fused
candidates for **you** to rank. There is no rerank flag.

## Retrieve sources

Search results include docids like `#abc123` and `qmd://...` paths. Fetch them:

```bash
qmd get "#abc123"
qmd get qmd://concepts/ai-before-headcount.md
qmd multi-get "#abc123,#def432" --format md
qmd multi-get 'concepts/{ai-before-headcount.md,data-informed-not-metric-driven.md}' --format md
qmd multi-get 'sources/podcast-2025-*.md' -l 80
```

Use `multi-get` when comparing several hits or gathering context across pages.

### Output is line-numbered and carries the docid — cite both

`get` and `multi-get` are **line-numbered by default** and always print the
document's `#docid` and `qmd://` path. So `get` output looks like:

```text
qmd://concepts/note.md  #abc123
---

1: # Metrics as instruments
2:
3: Treat dashboards like cockpit instruments...
```

Cite the docid and exact line numbers in your answer, and use the numbers to ask
for the next slice. Pass `--no-line-numbers` only when you need raw content to
copy verbatim (e.g. reproducing a code block).

When you need to open or edit the underlying file (e.g. hand a path to `Read`,
`Edit`, or an editor), add `--full-path`. It replaces the `qmd://` URL + docid
header with the document's on-disk path, falling back to the canonical header if
the file no longer exists on disk:

```text
$ qmd get "#abc123" --full-path
/Users/you/notes/concepts/note.md
---

1: # Metrics as instruments
```

`--full-path` works the same way on `qmd search` and `qmd query`: result paths
become the file's on-disk path — `./`-prefixed relative path when the file is
inside `$PWD`, absolute realpath otherwise — and the per-result `#docid` is
dropped because the path is the identifier. Default search/query output still uses
`qmd://` URIs; only opt into `--full-path` when you specifically need a path you
can hand to a non-QMD tool.

### Read line ranges with the `:from:count` suffix — never pipe through `sed`/`head`/`tail`

`qmd get` slices files itself. Use the suffix or flags; do **not** shell out to
`sed -n`, `head`, `tail`, or `awk` to pull a line range. Piping defeats docid
resolution, virtual-path lookups, line numbering, and the header, and it is
slower and more error-prone.

The most compact form is a `:from:count` suffix right on the path or docid —
prefer it:

```bash
qmd get "#abc123:120:40"                  # 40 lines starting at line 120
qmd get qmd://concepts/note.md:200:60     # lines 200–259
qmd get "#abc123:120"                      # from line 120 to end of file
qmd get "#abc123" --from 120 -l 40         # equivalent, using flags
```

Suffix and flags:

- `<path>:<from>:<count>` — start at line `<from>`, read `<count>` lines. **Best
  for reading around a search hit.**
- `<path>:<from>` — start at `<from>`, read to end of file.
- `--from <line>` / `-l <lines>` — flag equivalents. Explicit flags override the
  suffix, so `... :5:2 -l 1` reads 1 line.
- `--no-line-numbers` — drop the `N:` prefixes (line numbers are on by default).

Wrong: `qmd get "#abc123" | sed -n '120,160p'`
Right: `qmd get "#abc123:120:40"`

Search results include a `:line` anchor on each hit — feed it straight into
`qmd get path:line:<n>` to read a window around the match (line numbers in the
output will start at `line`).

## Discover what is indexed

```bash
qmd collection list
qmd ls
qmd status
```

Add collection filters when broad searches drift into the wrong corpus:

```bash
qmd search "headcount autonomous agents" -c concepts -n 10
qmd query "merchant support product reality" -c concepts -c sources -n 10
```

Omit `-c` to search everything.

## Query craft

Good QMD searches mix three things:

1. **Title/alias anchors:** exact page titles, named entities, phrases.
2. **Semantic paraphrase:** how a human would describe the idea.
3. **Negative space:** enough intent to avoid nearby-but-wrong concepts.

Examples:

```bash
# Exact-ish title lookup
qmd search '"arm the rebels" merchants tools big companies' -c concepts

# Semantic concept lookup
qmd query $'intent: Find the customer proximity concept, not generic customer delight.\nlex: support pseudonymous merchant customer interviews\nvec: founder stays close to merchant reality through support and product use'

# Source lookup
qmd search "six-week cadence WhatsApp merchant relationships Shawn Ryan" -c sources -n 10
```

## Setup and maintenance

Only mutate indexes when the user asked for setup or maintenance. Searching and
retrieving are safe; collection/index mutation is not a casual first step. For a
guided first-time install, point the user at the **`qmd-setup`** skill, which
sequences these steps and prints the commands for them to run.

```bash
qmd collection add ~/notes --name notes
qmd update
qmd embed
```

Health and diagnostics:

```bash
qmd doctor
qmd status
qmd pull          # downloads only the embedding model (qmd-gd runs no generative models)
```

`qmd doctor` checks config, the embedding-model cache, device/GPU setup, and
vector fingerprints. If `qmd query`/`qmd embed` fails, run it before changing
configuration.

## Pitfalls

- **Do not stop at snippets.** Fetch documents before making claims.
- **Do not slice files with `sed`/`head`/`tail`.** Use the `path:from:count`
  suffix (e.g. `qmd get "#abc123:120:40"`) or `--from`/`-l`. Output is already
  line-numbered; piping breaks docid resolution, the header, and virtual paths.
- **You expand and you rank.** qmd-gd runs no expansion or reranking model. Write
  `intent:`/`lex:`/`vec:`/`hyde:` yourself, then judge the returned candidates
  yourself (or via a Task-tool subagent — never `claude -p`).
- **Do not overuse semantic search.** If you know exact titles or terms, BM25 is
  faster and often better.
- **Do not mutate indexes casually.** `qmd collection add`, `qmd update`, and
  `qmd embed` change local state and can be expensive — leave them to the user /
  the scheduled refresh job.
- **The embedding model can be environment-sensitive.** If `qmd query` or
  `qmd vsearch` fails because the local embedding model/GPU is unavailable (e.g.
  sandbox restrictions), use `qmd search` (BM25, zero inference) with stronger
  lexical/structured terms.
- **Ambiguous user wording needs intent.** Add `intent:` rather than embedding a
  bare sentence and hoping the vectors land in the right domain.
- **Collection names matter.** Search `concepts` for synthesized wiki pages,
  `sources` for transcripts/raw source pages, and docs collections for code or
  project documentation.

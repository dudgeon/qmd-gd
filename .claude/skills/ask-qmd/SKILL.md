---
name: ask-qmd
description: Answer a natural-language question from the user's indexed knowledge base (notes, docs, meeting transcripts) with qmd, and cite the sources. Use when the user runs "/ask-qmd <question>" or asks to answer something "from my notes", "from qmd", or "from my knowledge base". Picks instant keyword search or thorough hybrid search per question, reads the top sources, returns a cited answer, and — in Duo — offers to open the source and scroll to the answer span.
allowed-tools: Bash(qmd:*), Bash(duo:*)
---

# ask-qmd — answer a question from the user's knowledge base

The user invoked you with a question — the text after `/ask-qmd`, e.g.
`/ask-qmd what were the takeaways from the last QBR?`. Your job: **answer that question from
what qmd has indexed, cite the sources, and — in Duo — offer to open the source at the answer
span.** This is read-only retrieval — you never index or mutate anything.

**The scope is already configured.** qmd searches its *default-included* collections whenever
you don't pass `-c`, so a plain search already hits the right corpus. The user chose that
default at setup (`qmd collection include/exclude`). Only pass `-c` if the user names an area
(see Scope overrides).

## 1. Pick the search mode — quick or thorough

Choose per question; default to thorough.

- **Quick — `qmd search` (BM25 keyword, instant, no model load).** Use it when the user signals
  speed ("quick", "fast", "just keyword", "real quick") **or** the question hinges on *exact
  words*: a name, a title, a term, a code symbol, an error string, a ticket/ID. Keyword
  matching is enough and it returns instantly.
- **Thorough — `qmd query` (hybrid BM25 + vector + RRF, the default).** Use it for conceptual or
  paraphrase-y questions ("how did X go", "what was the gist of Y", "why did we…"). It
  cold-loads the local embedding model (a few seconds) but matches *meaning*, not just words.

If `qmd query` can't embed (a sandbox blocks the local model), fall back to `qmd search`.

## 2. Search

Author the query for the chosen mode. Stay unscoped (default scope) unless the user named an area.

- **Quick:**
  ```bash
  qmd search "<the key terms>" --format json -n 8
  ```
- **Thorough:** you author the expansions (there is no local generative model to do it):
  ```bash
  qmd query $'intent: <what the user wants, one line — sharpens ranking>\nlex: <exact keywords, names, titles likely in the text>\nvec: <a natural-language paraphrase of the question>\nhyde: <one or two sentences of a hypothetical ideal answer>' --format json -n 8
  ```
  A bare `qmd query "<the question>" --format json -n 8` works too, but the structured form
  recalls better.

Each JSON result carries `docid`, `file` (a `qmd://` path), `line`, `score`, and a snippet —
keep them; you'll cite with them and (in Duo) open with them.

## 3. Read the real sources

Parse the JSON and **never answer from snippets alone.** Pull the top 3–6 candidates by docid:

```bash
qmd multi-get "#abc123,#def456,#ghi789"      # or a slice of one: qmd get "#abc123:120:60"
```

## 4. Answer, with sources

Answer the question directly, grounded in the retrieved text. **Cite each claim** with its
source — path + docid + line, e.g. `meetings/2025-q1-qbr.md #abc123:42`. Lead with the answer;
keep it tight. Be honest about confidence: if the top results are off-topic or low-score, say
you couldn't find it in the default scope and offer to widen — another collection (`-c <name>`),
a lower floor (`--all --min-score 0.2`), or a rephrase. **Don't fabricate.**

## 5. In Duo — offer to open the source at the answer

If you're in a **Duo** session — the `DUO_SESSION` env var is set (`duo status` also succeeds
only inside Duo) — then after answering, **offer** (don't auto-open): *"Want me to open the top
source and jump to the answer?"* When the user says yes:

1. **Get the on-disk path.** Duo opens files, not `qmd://` URIs — re-run your step-2 search with
   `--full-path` so each hit's `file` is an absolute path:
   ```bash
   qmd search "<the key terms>" --format json -n 8 --full-path     # (or the qmd query form)
   ```
2. **Open it, then jump to the answer by TEXT — not by qmd's line number.** Duo's editor
   renders markdown and renumbers lines, so qmd's raw-file `line` does **not** match the
   editor's line; passing it to `goto --line` lands in the wrong place. Locate the span by its
   text and let `duo doc find` give you the editor-relative line:
   ```bash
   duo open --reveal "<abs-path>"                                       # a .md source opens in the editor
   duo doc find "<a distinctive phrase from the answer>" "<abs-path>"   # → {first:{line}} in EDITOR coords
   duo doc goto "<abs-path>" --line <first.line>                        # scroll there
   ```
   If the answer sits under a known section, this is even simpler (no phrase needed):
   ```bash
   duo doc goto "<abs-path>" --heading "<Section heading>"
   ```
3. **Optional emphasis:** `duo doc highlight "<abs-path>" --text "<the key sentence>"` marks the
   span (match by the same distinctive text). Offer it; note it adds a **removable** highlight the
   user can clear. Skip it if they just wanted to read.

For multiple strong sources, offer to open each in turn.

## Scope overrides & rules

- **Scope override:** if the user names an area ("…in my meeting notes", "…from the handbook"),
  scope explicitly with one or more `-c <collection>` flags. `qmd collection list` shows the names.
- **Read-only.** Never run `qmd collection add`, `qmd update`, or `qmd embed`. If the index looks
  empty/stale, tell the user to run setup/refresh — don't do it for them.
- **Local only.** `qmd …` and `duo …` run entirely on-device; no external network calls.
- For the full search reference (scoring, output formats, query syntax), see the `qmd` skill.

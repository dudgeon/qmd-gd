---
name: ask-qmd
description: Answer a natural-language question from the user's indexed knowledge base (notes, docs, meeting transcripts) with qmd. Use when the user runs "/ask-qmd <question>" or asks to answer something "from my notes", "from qmd", or "from my knowledge base". Searches qmd's default-included collections, reads the top sources, and returns a cited answer.
allowed-tools: Bash(qmd:*)
---

# ask-qmd — answer a question from the user's knowledge base

The user invoked you with a question — the text after `/ask-qmd`, e.g.
`/ask-qmd what were the takeaways from the last QBR?`. Your job: **answer that question from
what qmd has indexed, and cite the sources.** This is read-only retrieval — you never index
or mutate anything.

**The scope is already configured.** qmd searches its *default-included* collections whenever
you don't pass `-c`, so a plain `qmd query` already hits the right corpus. The user chose that
default at setup; they retune it with `qmd collection include/exclude`. Don't pass `-c` unless
the user explicitly names an area (see Scope overrides).

## The loop

1. **Turn the question into a structured query.** You author the expansions; qmd does the
   retrieval (there is no local generative model). Keep `-c` off to use the default scope:

   ```bash
   qmd query $'intent: <what the user wants, one line — sharpens ranking>\nlex: <exact keywords, names, titles likely in the text>\nvec: <a natural-language paraphrase of the question>\nhyde: <one or two sentences of a hypothetical ideal answer>' --format json -n 8
   ```

   A bare `qmd query "<the question>" --format json -n 8` also works, but the structured form
   recalls better — prefer it.

2. **If query-time embedding is unavailable** (a sandbox blocks the local model), fall back to
   keyword-only search — instant, zero inference:

   ```bash
   qmd search "<the key terms>" --format json -n 8
   ```

3. **Read the real sources — never answer from snippets.** Pull the top 3–6 candidates by
   docid before making any claim:

   ```bash
   qmd multi-get "#abc123,#def456,#ghi789"      # or a single doc with a line range:
   qmd get "#abc123:120:60"
   ```

4. **Answer the question directly**, grounded in the retrieved text, and **cite each claim**
   with its source (path + docid, e.g. `meetings/2025-q1-qbr.md #abc123`). Lead with the
   answer; keep it tight. If sources disagree or look dated, say so.

5. **If nothing scores well** (top results are off-topic or low-score), say you couldn't find
   it in the default scope, and offer to widen: search another collection (`-c <name>`), lower
   the floor (`--all --min-score 0.2`), or rephrase. Don't fabricate an answer.

## Scope overrides (optional)

If the user names an area ("…in my meeting notes", "…from the handbook"), scope explicitly with
one or more `-c <collection>` flags. `qmd collection list` shows the available names.

## Rules

- **Read-only.** Never run `qmd collection add`, `qmd update`, or `qmd embed`. If the index
  looks empty or stale, tell the user to run setup / refresh — do not do it for them.
- **Local only.** `qmd query`/`search`/`get` run entirely on-device (the embedding model is
  local); they make no external network calls.
- For the full search reference (scoring, output formats, query syntax), see the `qmd` skill.

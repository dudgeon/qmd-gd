---
name: qmd-setup
description: Install and set up qmd-gd for a new user — build/link the CLI, install the qmd skill into ~/.claude/skills, add collections, index, embed, and schedule refresh. Use when the user says "/qmd-setup", "set up qmd", "install qmd", or asks how to get qmd search working. NOT auto-invoked by the model.
disable-model-invocation: true
---

# qmd-setup

Guide a (possibly non-technical) user through standing up qmd-gd end to end. This
skill **prints the commands for the user to run** for anything that mutates state
(indexing, embedding, installing). It runs only read-only checks itself.

**Never auto-run** `qmd collection add`, `qmd update`, or `qmd embed`. Present the
exact command, explain what it does, and let the user run it. Confirm completion
before moving to the next step.

## Process

### 0. Probe current state (read-only)

Run the context script and read its `[todo]` items:

```bash
bash skills/qmd-setup/scripts/qmd-setup-context.sh
```

It reports: checkout location (warns if you're in a throwaway `.claude/worktrees`
copy), whether the `qmd` CLI is on PATH, whether the skill is installed for
Claude, what's indexed, and whether a Duo refresh job exists. Walk the user
through the `[todo]` items in order. Skip any step already `[ok]`.

### 1. Build & link the CLI (if `qmd` is not on PATH)

From the **stable** checkout (e.g. `~/repos/qmd-gd`, not a worktree). qmd-gd runs on
**Node (>=22)** — no Bun required:

```bash
npm install        # builds native deps (better-sqlite3, sqlite-vec, node-llama-cpp) for your Node
npm run build      # compiles dist/ via tsc (do NOT use `bun build --compile`)
npm link           # exposes `qmd` globally (or: npm i -g .)
```

After a Node major-version upgrade, re-run `npm rebuild` so the native modules match the
new ABI. (Bun also works if you have it — `bun install && bun run build && bun link` — but
it is not required, and the CLI runs under Node by default.)

### 2. Install the qmd skill into Claude

This copies the skill and symlinks `~/.claude/skills/qmd` → the checkout, so
Claude Code auto-discovers it:

```bash
qmd skill install --global
```

Verify: `ls -l ~/.claude/skills/qmd` should show a symlink into the checkout.

### 3. Get the embedding model (test the dependency first)

qmd-gd downloads **only** the embedding model (~333MB, no generative/reranker models)
from HuggingFace on first use. On a locked-down work network this is the dependency most
likely to be blocked — the step-0 probe **preflights it** (a HEAD request, no full
download) and reports `[ok]` / `[todo]`. Check that line before downloading:

- **Reachable / already cached** → just pull it:

  ```bash
  qmd pull        # downloads the embedding model; etag-cached, so it's a one-time fetch
  ```

- **Blocked** (probe said it can't reach HuggingFace) → use one offline path instead of
  `qmd pull`, then continue:

  ```bash
  # (a) point at a pre-staged local file (downloaded on an allowed machine) — no network:
  export QMD_EMBED_MODEL=/abs/path/to/embeddinggemma-300M-Q8_0.gguf
  # (b) or drop the .gguf (+ its .etag) into ~/.cache/qmd/models/ and qmd pull skips the fetch
  # (c) or point at an internal HuggingFace mirror, then qmd pull:
  export HF_ENDPOINT=https://<your-org-hf-mirror>
  ```

  Persist whichever you choose (e.g. in `.env` / shell profile) so `qmd embed` and the
  scheduled refresh use the same model. Re-run the step-0 probe to confirm it now reports `[ok]`.

> Note: `npm install` (step 1) also fetches native prebuilts for `node-llama-cpp`,
> `better-sqlite3`, and `sqlite-vec` from their own hosts (not just the npm registry). If
> your Artifactory proxy doesn't cover those and `npm install` fails to produce a working
> binary, `qmd doctor` will flag it — install build tools or a proxied prebuilt source.

### 4. Add the repos/folders to search

For each folder the user wants searchable, print an `add` command. Ask which
folders first (e.g. a notes vault, a docs repo). Example:

```bash
qmd collection add ~/notes --name notes --mask '**/*.md'
qmd collection add ~/work/handbook --name handbook --mask '**/*.md'
```

### 5. Index and embed

```bash
qmd update     # scans files into the index (no inference)
qmd embed      # generates vector embeddings (local embedding model)
```

`qmd embed` can take a while on large corpora and on first run downloads the
model if step 3 was skipped. Let the user run it and wait.

### 6. Verify

```bash
qmd doctor     # config, embedding-model cache, device/GPU, vector fingerprints
qmd status     # documents + vectors per collection
```

Then sanity-check search:

```bash
qmd search "<a term you know is in the corpus>" -n 5
```

### 7. Schedule automatic refresh (optional)

Keep the index fresh without manual re-runs. **Preferred:** Duo's scheduler
running a plain shell command (requires Duo's shell-job cron support):

```bash
duo cron add --name "qmd index refresh" --cwd <repo> \
  --run "qmd update && qmd embed" --every daily --at 02:00 --catch-up
```

This runs the refresh directly — no Claude session, no inference beyond the local
embedding model. `--catch-up` means a run that was due while Duo was closed fires once
when Duo next opens, so a daily-driver user stays fresh without anything running
unattended. Once the job exists it appears in **Duo's Home view**, where the user can
Run / Pause / Resume it and edit its schedule natively (no Claude involved).

(If your Duo build predates shell-job cron support — `duo cron add --run` — use the
interim `duo cron add ... --say "run qmd update then qmd embed"` Claude-session form
until it lands.)

## Notes

- **Stable checkout matters.** The `~/.claude/skills/qmd` symlink and the cron job
  reference an on-disk path. Install from a durable checkout (`~/repos/qmd-gd`),
  not a temporary git worktree.
- **Re-running is safe.** Every step is idempotent: `qmd skill install --global`
  refreshes the symlink (`--force` if needed), `qmd update`/`qmd embed` only
  process new/changed files.
- If a model-backed step fails (sandbox blocks the local model, GPU issues), the
  user can still search with `qmd search` (BM25, zero inference). Run `qmd doctor`
  to diagnose.

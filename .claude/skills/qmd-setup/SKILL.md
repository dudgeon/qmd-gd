---
name: qmd-setup
description: Install and set up qmd-gd for a new user — build/link the CLI, install the qmd + ask-qmd skills, add collections, set the default /ask-qmd scope, index, embed, and schedule refresh. Use when the user says "/qmd-setup", "set up qmd", "install qmd", or asks how to get qmd search working. NOT auto-invoked by the model.
disable-model-invocation: true
---

# qmd-setup

Guide a (possibly non-technical) user through standing up qmd-gd end to end.

**Two hard rules for the agent running this skill:**

1. **Never mutate state for the user.** Anything that installs, indexes, embeds, or
   downloads — `npm install`, `qmd skill install`, `qmd collection add`, `qmd update`,
   `qmd embed`, `qmd pull` — is **printed for the user to run**, never run by the agent.
   Present the exact command, explain it, and confirm completion before the next step.

2. **Never contact an external network domain.** In this environment the agent may reach
   only `capitalone.com` and `github.com`; the user reaches everything else from their own
   terminal. So the agent must **not** run `curl`/`wget`, `npm install`, `qmd pull`, or the
   **preflight script** — anything that touches the npm registry, HuggingFace, or prebuilt
   hosts. Hand those commands to the user and read back what they paste.

The agent may itself run only **local, read-only** checks — chiefly `qmd-setup-context.sh`,
which touches nothing on the network.

## Process

### 0. Probe current state (read-only, local-only — safe for the agent to run)

This probe touches **nothing on the network** (git, `command -v`, local SQLite reads,
a cache-dir `ls`), so the agent may run it directly and read its `[todo]` items:

```bash
bash .claude/skills/qmd-setup/scripts/qmd-setup-context.sh
```

It reports: checkout location (warns if you're in a throwaway `.claude/worktrees`
copy), whether the `qmd` CLI is on PATH, whether the skill is installed for
Claude, what's indexed, and whether a Duo refresh job exists. Walk the user
through the `[todo]` items in order. Skip any step already `[ok]`.

### 0.5. Preflight external services — **the user runs this, not the agent**

qmd-gd reaches three external services: the **npm registry** (JS deps + the sqlite-vec
platform packages), **HuggingFace** (the embedding model), and **GitHub release hosts**
(native prebuilts for node-llama-cpp / better-sqlite3). On a locked-down corporate network
any of these may be proxied through an internal mirror — or blocked. Test them first so a
blocked dependency surfaces here, not as a confusing failure mid-install.

The preflight script `curl`s those endpoints, so by **rule 2 above the agent must not run
it.** Give the user this command to run in their own terminal and ask them to paste back the
output:

```bash
bash .claude/skills/qmd-setup/scripts/preflight-deps.sh   # USER runs this; exits non-zero if any service fails
```

For each service it tests the **effective endpoint** — the user's configured internal value
if set, else the public default — and on failure prints the exact knob to set plus a repro
command. Read the pasted output to decide what to tell the user next.

**If a service reports `[FAIL]`:** ask the user for that service's internal URL, set it, and
re-run the preflight until it passes — only then proceed to install. The knobs:

- **npm registry** → `npm config set registry <url>` (or `~/.npmrc` `registry=`, or
  `NPM_CONFIG_REGISTRY`). This is usually the org's Artifactory npm virtual repo.
- **HuggingFace** → `export HF_ENDPOINT=<mirror>` — or skip it entirely with
  `export QMD_EMBED_MODEL=/abs/path/to/embeddinggemma-300M-Q8_0.gguf` (a pre-staged file).
- **native prebuilts** → if GitHub release hosts are blocked, either set
  `npm config set better_sqlite3_binary_host_mirror <url>` or build from source
  (`npm install --build-from-source`; node-llama-cpp needs cmake + a C/C++ toolchain).

Persist whatever you set (shell profile / `~/.npmrc` / a project `.env`) so install, `qmd
embed`, and the scheduled refresh all use the same endpoints. Re-run the preflight (and the
native functional check passes once `qmd` is installed).

### 1. Build & link the CLI (if `qmd` is not on PATH)

From the **stable** checkout (e.g. `~/repos/qmd-gd`, not a worktree). qmd-gd runs on
**Node (>=22)**:

```bash
npm install        # builds native deps (better-sqlite3, sqlite-vec, node-llama-cpp) for your Node
npm run build      # compiles dist/ via tsc
npm link           # exposes `qmd` globally (or: npm i -g .)
```

After a Node major-version upgrade, re-run `npm rebuild` so the native modules match the
new ABI.

### 2. Make the qmd skills available everywhere

qmd-gd ships its skills as plain folders under `.claude/skills/` in this checkout, so
Claude Code **already auto-discovers them when you open this folder** (that is how this
skill ran — no plugin, no install). To use the **`qmd`** (search) and **`ask-qmd`**
(ask-a-question) skills from your **other** projects too, symlink them into your user
skills. `qmd skill install --global` does exactly that — live symlinks, so a later `git
pull` keeps them current:

```bash
qmd skill install --global        # symlinks ~/.claude/skills/{qmd,ask-qmd} -> this checkout
```

Verify: `ls -l ~/.claude/skills/` should show `qmd` and `ask-qmd` symlinks into this checkout.

### 3. Get the embedding model (test the dependency first)

qmd-gd downloads **only** the embedding model (~333MB, no generative/reranker models)
from HuggingFace on first use. On a locked-down work network this is the dependency most
likely to be blocked — the **user-run preflight (step 0.5)** tests reachability, and the
local step-0 probe reports whether the model is already cached. Check those before the user
downloads:

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

### 5. Choose the default `/ask-qmd` scope

`/ask-qmd "<question>"` answers from qmd's **default-included** collections — the ones an
*unscoped* `qmd query` searches. Decide which of the collections just added should be in that
default scope, and exclude the rest. Ask the user which folders a question like *"what were
the takeaways from the last QBR?"* should draw from, then print:

```bash
qmd collection include notes        # in the default /ask-qmd scope
qmd collection include meetings
qmd collection exclude scratch      # still searchable with -c, just not by default
```

Everything is included by default, so you only need `exclude` for collections that would add
noise. There is no separate config file — the scope **is** qmd's include/exclude state, so the
user can retune anytime. (`/ask-qmd … in my meeting notes` can still scope explicitly with
`-c meetings`.)

### 6. Index and embed

```bash
qmd update     # scans files into the index (no inference)
qmd embed      # generates vector embeddings (local embedding model)
```

`qmd embed` can take a while on large corpora and on first run downloads the
model if step 3 was skipped. Let the user run it and wait.

### 7. Verify

```bash
qmd doctor     # config, embedding-model cache, device/GPU, vector fingerprints
qmd status     # documents + vectors per collection
```

Then sanity-check search:

```bash
qmd search "<a term you know is in the corpus>" -n 5
```

And once the `ask-qmd` skill is linked (step 2), confirm the turnkey path from a Claude Code
session: **`/ask-qmd <a question the corpus can answer>`** — it should return a cited answer,
not just a list of files.

### 8. Open the scope playground (Duo only)

If setup is running inside **Duo** — the `DUO_SESSION` environment variable is set — open a
small visual **scope playground** so the user can see what `/ask-qmd` searches and change it
with one click. **Only when Duo is present**; skip silently otherwise. This is local and safe
to run yourself (it reads `qmd collection list --json` and writes one HTML file — no network,
no index changes):

```bash
if [ -n "$DUO_SESSION" ]; then
  out="$(node .claude/skills/qmd-setup/scripts/scope-playground.mjs)"   # renders the HTML; prints its path
  duo open --reveal "$out"                                             # shows it in Duo's browser pane
fi
```

The playground lists in-scope vs. out-of-scope collections and has a **"Change scope…"** button
that opens a fresh Claude tab to adjust qmd's `include`/`exclude` state and regenerate the view.
(The HTML is written under `~/.claude/duo/` so Duo allows its button to fire.)

### 9. Schedule automatic refresh (optional)

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

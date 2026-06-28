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

2. **Never contact an external network domain.** In locked-down environments the agent may
   reach only an allowlisted set of domains; the user reaches everything else from their own
   terminal. So the agent must **not** run `curl`/`wget`, `npm install`, `bash scripts/install.sh`,
   `qmd pull`, or the **preflight script** — anything that touches the npm registry or prebuilt
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

qmd-gd's install needs the **npm registry** (JS deps + the sqlite-vec platform packages) and
the **GitHub release CDN** + **nodejs.org** (native prebuilts / build-from-source headers for
node-llama-cpp, better-sqlite3, sqlite-vec). The embedding model is **vendored in-repo**, so
HuggingFace is **not** needed. On a locked-down network these may be proxied or blocked — and
a **TLS-intercepting proxy** breaks Node's trust store specifically (a curl check can pass
while Node fails), so the preflight tests both curl and Node. Test first so a blocked
dependency surfaces here, not as a confusing failure mid-install.

The preflight script `curl`s those endpoints, so by **rule 2 above the agent must not run
it.** Give the user this command to run in their own terminal and ask them to paste back the
output:

```bash
bash .claude/skills/qmd-setup/scripts/preflight-deps.sh   # USER runs this; exits non-zero if any service fails
```

For each service it tests the **effective endpoint** — the user's configured internal value
if set, else the public default — and on failure prints the exact knob to set plus a repro
command. Read the pasted output to decide what to tell the user next.

**If a check reports `[FAIL]`:** set the matching knob and re-run the preflight until it
passes — only then install. The knobs:

- **Node TLS (`UNABLE_TO_GET_ISSUER_CERT`)** → point Node at the corporate CA bundle.
  **You, the agent, know this environment's bundle path — give it to the user** (if not, ask
  for their corporate root-CA `.pem`): `export QMD_CA_BUNDLE=/path/to/corp-ca.pem` (and
  `export NODE_EXTRA_CA_CERTS="$QMD_CA_BUNDLE"` for `npm install`). `scripts/install.sh` does
  this automatically when `QMD_CA_BUNDLE` is set.
- **npm registry** → `npm config set registry <url>` (or `~/.npmrc` `registry=`, or
  `NPM_CONFIG_REGISTRY`) — usually an internal/mirror npm registry. Read it from the user's
  environment; never hardcode an org-specific URL in the repo or skill.
- **native prebuilts** → if the GitHub release CDN is blocked, either set
  `npm config set better_sqlite3_binary_host_mirror <url>` or build from source
  (`npm install --build-from-source`; node-llama-cpp needs cmake + a C/C++ toolchain).

Persist whatever you set (shell profile / `~/.npmrc`) so install, `qmd embed`, and the
scheduled refresh use the same settings. The native functional check passes once `qmd` is installed.

**Sourcing org-specific endpoints — read first, ask second, persist locally.** The repo and
this skill carry **zero** internal URLs or paths on purpose, so any org-specific value is
discovered at setup time, never committed:

1. **Read first.** The value may already be on the machine — `~/.npmrc` /
   `NPM_CONFIG_REGISTRY` for the registry; `QMD_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS` /
   `SSL_CERT_FILE` for the CA bundle; or a path the user's own `~/.claude/CLAUDE.md`
   documents. If you (the agent) already know it from `~/.claude`, supply it.
2. **Ask second.** If a check is still `[default]` / `[FAIL]`, ask the user for **only** the
   one value it needs (their internal npm registry URL, or their corporate CA `.pem` path) —
   don't guess and don't invent an org URL.
3. **Persist locally**, where future runs pick it up automatically — **never in the repo:**
   `npm config set registry <url>` (writes `~/.npmrc`) and `export QMD_CA_BUNDLE=…` in the
   shell profile. Then re-run the preflight until it passes.

This keeps the skill org-agnostic: the same steps work at any company because the specifics
live on the user's machine, not in qmd-gd.

### 1. Install — one command (build, link, skills)

The bundled installer collapses build + link + skill-install into one command and handles
corporate-proxy TLS. **You (the agent) print it; the user runs it** — by rule 1 the agent
never runs `npm install` itself. From the **stable** checkout (e.g. `~/repos/qmd-gd`, not a
worktree); qmd-gd runs on **Node (>=20)**:

```bash
bash scripts/install.sh --yes
```

**Behind a TLS-intercepting proxy**, Node must trust the corporate CA bundle or `npm install`
fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. **You, the agent, know this environment's CA
bundle path — supply it** (if you don't, ask the user for their corporate root-CA `.pem`):

```bash
QMD_CA_BUNDLE=/path/to/corp-ca.pem bash scripts/install.sh --yes
```

`install.sh` exports `NODE_EXTRA_CA_CERTS` for `npm install` and reuses `QMD_CA_BUNDLE` for
the qmd runtime. If `npm install` still fails on certs, `--insecure-tls` retries that one
command with verification off (insecure — prefer the bundle). Tell the user to persist
`export QMD_CA_BUNDLE=…` in their shell profile so `qmd embed` and the scheduled refresh keep
working. After a Node major upgrade, re-run `npm rebuild`.

**Manual alternative** (the same steps à la carte, if you'd rather run them one by one):

```bash
npm install && npm run build && npm link
qmd skill install --global --yes   # symlinks ~/.claude/skills/{qmd,ask-qmd} + the qmd-retrieve agent
```

### 2. (Covered by step 1) Make the qmd skills available everywhere

`scripts/install.sh` already ran `qmd skill install --global --yes`, which live-symlinks the
**`qmd`** (search) and **`ask-qmd`** (ask-a-question) skills — plus the `qmd-retrieve` agent —
into your user `~/.claude/skills/`, so they work from your **other** projects too (a later
`git pull` keeps them current). The `--yes` flag skips the per-symlink `[y/N]` prompts.

Verify: `ls -l ~/.claude/skills/` should show `qmd` and `ask-qmd` symlinks into this checkout.

### 3. The embedding model is vendored — nothing to download

qmd-gd ships its default embedding model **in the repo**
(`models/bge-small-en-v1.5-Q8_0.gguf`, ~35 MB, MIT-licensed), referenced internally as
`bundled:bge-small-en-v1.5-Q8_0.gguf`. A fresh clone embeds with **no network** — there is
**no `qmd pull` step** on the default path, which is exactly what makes qmd-gd work where
HuggingFace is blocked. The step-0 probe confirms the file is present.

To use a **different** model instead, set `QMD_EMBED_MODEL` (run `qmd pull` only for an
`hf:` URI, which needs HuggingFace reachable):

```bash
export QMD_EMBED_MODEL=/abs/path/to/some-model.gguf      # a local .gguf — no network
export QMD_EMBED_MODEL=hf:<user>/<repo>/<file>.gguf      # downloaded from HuggingFace
```

> Note: `npm install` (step 1) still fetches native prebuilts for `node-llama-cpp`,
> `better-sqlite3`, and `sqlite-vec` from the GitHub release CDN (and Node headers from
> `nodejs.org` for a build-from-source fallback) — not just the npm registry. The updated
> preflight (step 0.5) checks both, and behind a TLS-intercepting proxy you'll need a CA
> bundle (step 1). `qmd doctor` flags a broken native install.

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
to run yourself (it reads `qmd status --json` and writes one HTML file — no network,
no index changes):

```bash
if [ -n "$DUO_SESSION" ]; then
  out="$(node .claude/skills/qmd-setup/scripts/scope-playground.mjs)"   # renders the HTML; prints its path
  duo open --reveal "$out" && duo reload                               # show it (reload re-renders if already open)
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

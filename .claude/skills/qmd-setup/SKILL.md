---
name: qmd-setup
description: Install and set up qmd-gd for a new user — build/link the CLI, install the qmd + ask-qmd skills, add collections, set the default /ask-qmd scope, index, embed, and schedule refresh. Use when the user says "/qmd-setup", "set up qmd", "install qmd", or asks how to get qmd search working. NOT auto-invoked by the model.
disable-model-invocation: true
---

# qmd-setup

Guide a (possibly non-technical) user through standing up qmd-gd end to end.
**Do the work for them.** The skill exists to drive the `qmd` CLI, so the agent
runs the qmd commands itself — it does not narrate a checklist and make the user
paste each line.

## The one rule that decides who runs each command

**The agent runs every local `qmd` CLI command itself.** `qmd collection add`,
`qmd update`, `qmd embed`, `qmd skill install`, `qmd collection include/exclude`,
`qmd context add`, `qmd doctor`, `qmd status`, `qmd search`/`query`, the step-0
probe, the scope playground — all on-device, network-free, and idempotent.
Running them for the user is the whole point of this skill. Gather any input the
command needs (which folders, what scope) by **asking** the user, then run it —
don't hand them a command to paste.

**The agent hands a command to the user only when it would (a) install npm
packages or (b) reach the network / an external service** — because the agent's
sandbox cannot (and should not) do those. That is a short, fixed list:

- `npm install` / `bash scripts/install.sh` — npm registry + prebuilt backends
- the **preflight** script, and any `curl`/`wget` reachability check
- `qmd pull` for an `hf:` model — a HuggingFace download (the default model is
  vendored in-repo, so the default path never needs this)
- setting an internal npm registry or corporate CA bundle — machine config the
  user owns

For each of those: print the exact command, explain it, and read back what the
user pastes. For **everything else**, just run it.

> Why the split: in a locked-down environment the agent may reach only an
> allowlisted set of domains and must not install packages, but it runs freely on
> the local filesystem and CPU. So npm + network → user; local `qmd` → agent.

## Process

### 0. Probe current state (agent runs this)

Local, read-only (git, `command -v`, local SQLite reads, a cache-dir `ls`) —
touches nothing on the network. Run it and read its `[todo]` items:

```bash
bash .claude/skills/qmd-setup/scripts/qmd-setup-context.sh
```

It reports: checkout location (warns if you're in a throwaway `.claude/worktrees`
copy), whether the `qmd` CLI is on PATH, whether the skill is installed for
Claude, what's indexed, and whether a Duo refresh job exists. Work the `[todo]`
items in order. For each one, decide by the rule above: a local `qmd` step you
run yourself; an npm/network step you hand to the user. Skip any step already
`[ok]`.

### 0.5. Preflight external services — **the user runs this** (network)

qmd-gd's install needs the **npm registry** (JS deps + the sqlite-vec and
node-llama-cpp platform packages) and possibly the **GitHub release CDN**
(node-llama-cpp's prebuilt backend). There is **no native SQLite build** — qmd
uses Node's built-in node:sqlite. The embedding model is **vendored in-repo**, so
HuggingFace is **not** needed. On a locked-down network these may be proxied or
blocked — and a **TLS-intercepting proxy** breaks Node's trust store specifically
(a curl check can pass while Node fails), so the preflight tests both curl and
Node. Test first so a blocked dependency surfaces here, not as a confusing
failure mid-install.

The preflight `curl`s external endpoints, so by the rule above it's a **user**
command. Give the user this and ask them to paste back the output:

```bash
bash .claude/skills/qmd-setup/scripts/preflight-deps.sh   # USER runs this; exits non-zero if any service fails
```

For each service it tests the **effective endpoint** — the user's configured
internal value if set, else the public default — and on failure prints the exact
knob to set plus a repro command. Read the pasted output to decide what to tell
the user next.

**If a check reports `[FAIL]`:** set the matching knob and re-run the preflight
until it passes — only then install. The knobs:

- **Node TLS (`UNABLE_TO_GET_ISSUER_CERT`)** → point Node at the corporate CA
  bundle. **You, the agent, know this environment's bundle path — give it to the
  user** (if not, ask for their corporate root-CA `.pem`):
  `export QMD_CA_BUNDLE=/path/to/corp-ca.pem` (and
  `export NODE_EXTRA_CA_CERTS="$QMD_CA_BUNDLE"` for `npm install`).
  `scripts/install.sh` does this automatically when `QMD_CA_BUNDLE` is set.
- **npm registry** → `npm config set registry <url>` (or `~/.npmrc` `registry=`,
  or `NPM_CONFIG_REGISTRY`) — usually an internal/mirror npm registry. Read it
  from the user's environment; never hardcode an org-specific URL in the repo or
  skill.
- **native prebuilts** → if the GitHub release CDN is blocked, either set
  `npm config set better_sqlite3_binary_host_mirror <url>` or build from source
  (`npm install --build-from-source`; node-llama-cpp needs cmake + a C/C++
  toolchain).

These are machine-config/network commands, so the **user** runs them. Persist
whatever you set (shell profile / `~/.npmrc`) so install, `qmd embed`, and the
scheduled refresh use the same settings. The native functional check passes once
`qmd` is installed.

**Sourcing org-specific endpoints — read first, ask second, persist locally.**
The repo and this skill carry **zero** internal URLs or paths on purpose, so any
org-specific value is discovered at setup time, never committed:

1. **Read first.** The value may already be on the machine — `~/.npmrc` /
   `NPM_CONFIG_REGISTRY` for the registry; `QMD_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS`
   / `SSL_CERT_FILE` for the CA bundle; or a path the user's own
   `~/.claude/CLAUDE.md` documents. If you (the agent) already know it from
   `~/.claude`, supply it.
2. **Ask second.** If a check is still `[default]` / `[FAIL]`, ask the user for
   **only** the one value it needs (their internal npm registry URL, or their
   corporate CA `.pem` path) — don't guess and don't invent an org URL.
3. **Persist locally**, where future runs pick it up automatically — **never in
   the repo:** `npm config set registry <url>` (writes `~/.npmrc`) and
   `export QMD_CA_BUNDLE=…` in the shell profile. Then re-run the preflight until
   it passes.

This keeps the skill org-agnostic: the same steps work at any company because the
specifics live on the user's machine, not in qmd-gd.

### 1. Install — one command (build, link, skills) — **the user runs this** (npm)

The bundled installer collapses build + link + skill-install into one command and
handles corporate-proxy TLS. It runs `npm install`, so by the rule above it's a
**user** command — print it; don't run it yourself. Run it from the unzipped
**qmd-gd** folder (a stable location — not a throwaway worktree); qmd-gd runs on
**Node (>=22.13)**:

```bash
bash scripts/install.sh --yes
```

**Behind a TLS-intercepting proxy**, Node must trust the corporate CA bundle or
`npm install` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. **You, the agent,
know this environment's CA bundle path — supply it** (if you don't, ask the user
for their corporate root-CA `.pem`):

```bash
QMD_CA_BUNDLE=/path/to/corp-ca.pem bash scripts/install.sh --yes
```

`install.sh` exports `NODE_EXTRA_CA_CERTS` for `npm install` and reuses
`QMD_CA_BUNDLE` for the qmd runtime. If `npm install` still fails on certs,
`--insecure-tls` retries that one command with verification off (insecure —
prefer the bundle). Tell the user to persist `export QMD_CA_BUNDLE=…` in their
shell profile so `qmd embed` and the scheduled refresh keep working. (No
`npm rebuild` is ever needed — the SQLite engine is Node's built-in `node:sqlite`.)

This single command also installs the qmd skills globally
(`qmd skill install --global --yes`), so once the user has run it, the CLI is on
PATH and **every step below is yours to run.**

**Manual alternative** (if `install.sh` is unavailable): the user runs the one
npm step, `npm install`; then you (the agent) run the local remainder yourself —
`npm run build && npm link && qmd skill install --global --yes`.

### 2. (Covered by step 1) Make the qmd skills available everywhere

`scripts/install.sh` already ran `qmd skill install --global --yes`, which
live-symlinks the **`qmd`** (search) and **`ask-qmd`** (ask-a-question) skills —
plus the `qmd-retrieve` agent — into the user's `~/.claude/skills/`, so they work
from **other** projects too (a later `git pull` keeps them current). If the
step-0 probe shows the global symlink is missing (e.g. the manual install path),
run `qmd skill install --global --yes` yourself — it's a local symlink, no
network.

Verify (you run this): `ls -l ~/.claude/skills/` should show `qmd` and `ask-qmd`
symlinks into this checkout.

### 3. The embedding model is vendored — nothing to download

qmd-gd ships its default embedding model **in the repo**
(`models/bge-small-en-v1.5-Q8_0.gguf`, ~35 MB, MIT-licensed), referenced
internally as `bundled:bge-small-en-v1.5-Q8_0.gguf`. A fresh clone embeds with
**no network** — there is **no `qmd pull` step** on the default path, which is
exactly what makes qmd-gd work where HuggingFace is blocked. The step-0 probe
confirms the file is present.

To use a **different** model instead, set `QMD_EMBED_MODEL`. A local `.gguf` path
needs no network (you can set it). An `hf:` URI is a **download**, so the user
runs `qmd pull`:

```bash
export QMD_EMBED_MODEL=/abs/path/to/some-model.gguf      # a local .gguf — no network (agent can set)
export QMD_EMBED_MODEL=hf:<user>/<repo>/<file>.gguf      # downloaded from HuggingFace (USER runs qmd pull)
```

> Note: there is **no native SQLite build** — qmd uses Node's built-in
> `node:sqlite`. `npm install` (step 1) still fetches `sqlite-vec` and
> `node-llama-cpp`'s prebuilt backend (mostly npm packages; node-llama-cpp may
> also use the GitHub release CDN), so behind a TLS-intercepting proxy you'll need
> a CA bundle (step 1). `qmd doctor` flags a broken install.

### 4. Add the repos/folders to search — **you run this**

Ask the user which folders to make searchable (e.g. a notes vault, a docs repo) —
that's the input you need from them. Then **run the `add` for each yourself**:

```bash
qmd collection add ~/notes --name notes --mask '**/*.md'
qmd collection add ~/work/handbook --name handbook --mask '**/*.md'
```

These index local files only — no network, no npm — so they're yours to run.
Confirm the folder paths with the user before running (so you don't index the
wrong tree), then run them and report what landed.

### 5. Choose the default `/ask-qmd` scope — **you run this**

`/ask-qmd "<question>"` answers from qmd's **default-included** collections — the
ones an *unscoped* `qmd query` searches. Ask the user which folders a question
like *"what were the takeaways from the last QBR?"* should draw from, then **run**
the include/exclude yourself:

```bash
qmd collection include notes        # in the default /ask-qmd scope
qmd collection include meetings
qmd collection exclude scratch      # still searchable with -c, just not by default
```

Everything is included by default, so you only need `exclude` for collections
that would add noise. There is no separate config file — the scope **is** qmd's
include/exclude state, so you can retune anytime. (`/ask-qmd … in my meeting
notes` can still scope explicitly with `-c meetings`.)

### 6. Index and embed — **you run `update`; `embed` depends on the platform**

```bash
qmd update     # scans files into the index (no inference, no network) — always yours to run
qmd embed      # generates vector embeddings (local embedding model, no network)
```

`qmd update` is pure SQLite — run it yourself anywhere. `qmd embed` runs the local
embedding model, which needs GPU init, and that's where the sandbox bites:

- **On Apple Silicon (`uname -sm` → `Darwin arm64`), hand `qmd embed` to the user.** The only
  node-llama-cpp prebuilt for arm64 Macs is the Metal/GPU one, and the Claude Code sandbox
  blocks Metal — `ggml_metal_init` can't create a command queue, so `qmd embed` **aborts**
  inside the agent's shell (and `QMD_FORCE_CPU=1` / `GGML_NO_METAL=1` don't help — there's no
  CPU-only arm64 binary to fall back to). It runs fine in the **user's own terminal**. So on
  this platform, print `qmd embed` for the user, wait for them to paste that it finished, then
  continue. Once embeddings exist they persist in `~/.cache/qmd/index.sqlite` and `qmd query` /
  `/ask-qmd` use them from anywhere — including from inside the sandbox.
- **Everywhere else** (CPU-only, or CUDA/Vulkan that initializes in-sandbox), run `qmd embed`
  yourself. It can take a while on a large corpus — tell the user it's running and let it
  finish. If it still fails to load the model (`qmd doctor` will say so), hand it to the user.

Either way, `qmd search` (BM25 keyword search) needs no embeddings, so it works immediately —
even before `qmd embed` finishes.

### 7. Verify — **you run this**

```bash
qmd doctor     # config, embedding-model cache, device/GPU, vector fingerprints
qmd status     # documents + vectors per collection
```

Then sanity-check search yourself with a term you know is in the corpus:

```bash
qmd search "<a term you know is in the corpus>" -n 5
```

And confirm the turnkey path: run `/ask-qmd <a question the corpus can answer>` —
it should return a cited answer, not just a list of files. Report the results to
the user instead of asking them to run the checks.

### 8. Open the scope playground (Duo only) — **you run this**

If setup is running inside **Duo** — the `DUO_SESSION` environment variable is
set — open a small visual **scope playground** so the user can see what
`/ask-qmd` searches and change it with one click. **Only when Duo is present**;
skip silently otherwise. Local and safe (it reads `qmd status --json` and writes
one HTML file — no network, no index changes):

```bash
if [ -n "$DUO_SESSION" ]; then
  out="$(node .claude/skills/qmd-setup/scripts/scope-playground.mjs)"   # renders the HTML; prints its path
  duo open --reveal "$out" && duo reload                               # show it (reload re-renders if already open)
fi
```

The playground lists in-scope vs. out-of-scope collections and has a **"Change
scope…"** button that opens a fresh Claude tab to adjust qmd's `include`/`exclude`
state and regenerate the view. (The HTML is written under `~/.claude/duo/` so Duo
allows its button to fire.)

### 9. Schedule automatic refresh (optional) — **you run this**

Keep the index fresh without manual re-runs. **Preferred:** Duo's scheduler
running a plain shell command (requires Duo's shell-job cron support). It's a
local Duo CLI call (no network, no npm), so once you've confirmed the schedule
the user wants (folder, time of day), **run it yourself**:

```bash
duo cron add --name "qmd index refresh" --cwd <repo> \
  --run "qmd update && qmd embed" --every daily --at 02:00 --catch-up
```

This runs the refresh directly — no Claude session, no inference beyond the local
embedding model. `--catch-up` means a run that was due while Duo was closed fires
once when Duo next opens, so a daily-driver user stays fresh without anything
running unattended. Once the job exists it appears in **Duo's Home view**, where
the user can Run / Pause / Resume it and edit its schedule natively (no Claude
involved).

(If your Duo build predates shell-job cron support — `duo cron add --run` — use
the interim `duo cron add ... --say "run qmd update then qmd embed"`
Claude-session form until it lands.)

## Notes

- **Stable checkout matters.** The `~/.claude/skills/qmd` symlink and the cron job
  reference an on-disk path. Install from a durable checkout (`~/repos/qmd-gd`),
  not a temporary git worktree.
- **Re-running is safe.** Every step is idempotent: `qmd skill install --global`
  refreshes the symlink (`--force` if needed), `qmd update`/`qmd embed` only
  process new/changed files.
- **What still goes to the user.** npm installs (`npm install` /
  `scripts/install.sh`), the preflight and any reachability `curl`, `qmd pull`
  for an `hf:` model, corporate registry/CA config — and, **on Apple Silicon,
  `qmd embed`** (the sandbox blocks Metal GPU init; see step 6). Everything else
  is yours to run.
- If a model-backed step fails (sandbox blocks the local model, GPU issues), the
  user can still search with `qmd search` (BM25, zero inference). Run `qmd doctor`
  to diagnose.

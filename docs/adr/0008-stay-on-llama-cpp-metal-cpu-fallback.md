# ADR 0008 — Stay on llama.cpp; fall back to CPU when Metal can't run

**Status:** Accepted (2026-06-28)

## Context

`qmd embed` was reported failing to use the GPU on macOS 26 (Tahoe), with the question of
whether the cause is a llama.cpp/Metal incompatibility serious enough to justify moving the
embedding runtime off `node-llama-cpp` entirely.

What the investigation established:

- **The symptom is real and upstream.** On macOS 26, libggml-metal's `ggml_metal_device_init`
  logs `error: failed to create command queue` when `[device newCommandQueue]` returns nil.
  This is a documented class of macOS 26 Metal breakage in llama.cpp
  (ggml-org/llama.cpp discussion #17298). It is distinct from the *exit-time* residency-set
  teardown assertion (ggml-org/llama.cpp#22593) that `bin/qmd` already mitigates with
  `GGML_METAL_NO_RESIDENCY=1`.
- **It is not always an OS-wide API break.** The same failure shape appears when the OS denies
  GPU work to a **background/headless process** — e.g. a shell spawned by a desktop app rather
  than launched from Terminal.app. That explains the "works in Terminal, fails when spawned"
  reports better than a blanket macOS-26 incompatibility (a broken binary would fail in
  Terminal too). Either way the process-side remedy is identical: don't depend on the GPU.
- **node-llama-cpp 3.18.1 is already the latest** — there is no newer release to bump to, and
  the fix for the upstream Metal break lives in llama.cpp, which node-llama-cpp tracks.
- **qmd-gd uses llama.cpp for embeddings only**, on a 35 MB bge-small-en-v1.5 model (384-dim,
  Q8_0). GPU offload buys little for a model this small; CPU embedding is fast (verified: the
  full embedding test suite, including real-model integration tests, passes on CPU). So
  "GPU not working" is a *performance* concern for this workload, not a correctness blocker.
- **There was a real gap in qmd's fallback chain.** The existing CPU fallback only triggered
  when `getLlama()` (runtime init) threw. On macOS 26 the Metal *device* probes fine — the
  failure surfaces later, at embedding-**context** creation — so qmd hard-failed with
  "Failed to create any embedding context" instead of degrading to CPU.

## Decision

**Keep `node-llama-cpp` / llama.cpp as the embedding runtime. Do not migrate.** Instead, close
the fallback gap: when a GPU runtime loads but cannot create *any* embedding context, dispose
the GPU runtime, force the CPU path for the rest of that process, and retry once on CPU
(warning once on stderr). The `failedGpuInitModes` cache makes any later runtime load in the
same process also skip the GPU. `QMD_FORCE_CPU=1` / `QMD_LLAMA_GPU=false` remain the up-front
escape hatches for users who want to bypass the GPU probe entirely.

## Alternatives considered

- **Migrate embeddings to ONNX Runtime / transformers.js.** Avoids llama.cpp's Metal teardown
  and command-queue quirks and could ship a friendlier install. Rejected for now: it is a
  substantial rewrite of `src/llm.ts` (tokenization, truncation, GPU/CPU lifecycle, batching,
  the session layer) and reintroduces its own native/WASM portability surface — a large cost
  to dodge a problem that a CPU fallback already neutralizes for a tiny-model workload. Revisit
  if the first-run native-llama install proves too heavy for non-SWE users (see ADR 0001).
- **Pin/upgrade node-llama-cpp.** Not actionable: 3.18.1 is the latest; the relevant fix is in
  upstream llama.cpp.
- **Force CPU on all of darwin.** Too blunt — it would penalize the many macOS machines where
  Metal embedding works fine. The runtime fallback only kicks in when the GPU actually fails.
- **Do nothing / document `QMD_FORCE_CPU=1`.** Leaves a hard failure as the default experience
  on affected machines; the whole point is that `qmd embed` should just work.

## Consequences

- `qmd embed` succeeds on macOS 26 and in background-spawned shells, transparently on CPU, with
  a single explanatory warning instead of a crash.
- No new dependency; the embedding code path and the bundled bge-small default are unchanged.
- A machine that *could* have used Metal but trips the context-creation failure runs embeddings
  on CPU for that process. For qmd's short-lived CLI calls over a 35 MB model this is a small,
  acceptable cost. Users who later confirm Metal is healthy can simply rerun without
  `QMD_FORCE_CPU`.
- If a future macOS/Metal failure manifests as an *uncatchable* native abort (rather than a JS
  exception at context creation), the JS-level retry cannot catch it; `QMD_FORCE_CPU=1` up front
  remains the guaranteed bypass, and `qmd doctor` documents it.

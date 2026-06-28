/**
 * llm.ts - LLM abstraction layer for QMD using node-llama-cpp
 *
 * Provides local embeddings using a GGUF embedding model. Generative query
 * expansion and reranking are delegated to the calling agent (ADR 0002); only
 * the embedding model is run locally.
 */

import type {
  Llama,
  LlamaModel,
  LlamaEmbeddingContext,
  Token as LlamaToken,
} from "node-llama-cpp";

type StdoutChunk = string | Uint8Array;
type WriteCallback = (err?: Error | null) => void;

type NodeLlamaCppModule = {
  getLlama: (options: Record<string, unknown>) => Promise<Llama>;
  getLlamaGpuTypes?: (include?: "supported" | "allValid") => Promise<LlamaGpuMode[]>;
  resolveModelFile: (model: string, cacheDir: string) => Promise<string>;
  LlamaLogLevel: { error: unknown };
};

let nodeLlamaCppImport: Promise<NodeLlamaCppModule> | null = null;
async function loadNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
  nodeLlamaCppImport ??= withNativeStdoutRedirectedToStderr(
    () => import("node-llama-cpp") as Promise<NodeLlamaCppModule>
  );
  return nodeLlamaCppImport;
}

export function setNodeLlamaCppModuleForTest(module: NodeLlamaCppModule | null): void {
  nodeLlamaCppImport = module ? Promise.resolve(module) : null;
  failedGpuInitModes.clear();
  noGpuAccelerationWarningShown = false;
  cpuForcedPrebuiltFallbackWarningShown = false;
}

type StdoutWrite = typeof process.stdout.write;
let nativeStdoutRedirectDepth = 0;
let originalStdoutWrite: StdoutWrite | null = null;

/**
 * Some node-llama-cpp native build/probe paths write library noise to stdout.
 * JSON APIs must reserve stdout for machine-readable payloads, so route that
 * noise to stderr while native llama initialization is in progress.
 */
export async function withNativeStdoutRedirectedToStderr<T>(fn: () => Promise<T>): Promise<T> {
  if (nativeStdoutRedirectDepth === 0) {
    originalStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutWrite;
    process.stdout.write = ((chunk: StdoutChunk, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback) => {
      if (typeof encodingOrCallback === "function") {
        return process.stderr.write(chunk, encodingOrCallback);
      }
      return process.stderr.write(chunk, encodingOrCallback, callback);
    }) as StdoutWrite;
  }
  nativeStdoutRedirectDepth++;
  try {
    return await fn();
  } finally {
    nativeStdoutRedirectDepth--;
    if (nativeStdoutRedirectDepth === 0 && originalStdoutWrite) {
      process.stdout.write = originalStdoutWrite;
      originalStdoutWrite = null;
    }
  }
}

import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from "fs";

// =============================================================================
// Embedding Formatting Functions
// =============================================================================

/**
 * Detect if a model URI uses the Qwen3-Embedding format.
 * Qwen3-Embedding uses a different prompting style than nomic/embeddinggemma.
 */
export function isQwen3EmbeddingModel(modelUri: string): boolean {
  return /qwen.*embed/i.test(modelUri) || /embed.*qwen/i.test(modelUri);
}

/**
 * Detect if a model URI is a BAAI bge embedding model (bge-small/base/large).
 * bge-v1.5 expects a retrieval instruction prefix on queries and bare-text
 * passages — distinct from both the Qwen3 and nomic/embeddinggemma styles.
 */
export function isBgeEmbeddingModel(modelUri: string): boolean {
  return /bge|baai/i.test(modelUri);
}

/**
 * Format a query for embedding.
 * Uses nomic-style task prefix format for embeddinggemma.
 * Uses Qwen3-Embedding instruct format when a Qwen embedding model is active.
 * Uses the bge retrieval instruction for BAAI bge models (the default).
 */
export function formatQueryForEmbedding(query: string, modelUri?: string): string {
  const uri = modelUri ?? resolveEmbedModel();
  if (isQwen3EmbeddingModel(uri)) {
    return `Instruct: Retrieve relevant documents for the given query\nQuery: ${query}`;
  }
  if (isBgeEmbeddingModel(uri)) {
    // bge-v1.5: queries carry the retrieval instruction; passages stay bare text.
    return `Represent this sentence for searching relevant passages: ${query}`;
  }
  return `task: search result | query: ${query}`;
}

/**
 * Format a document for embedding.
 * Uses nomic-style format with title and text fields for embeddinggemma.
 * Qwen3-Embedding and bge encode documents as raw text without a task prefix.
 */
export function formatDocForEmbedding(text: string, title?: string, modelUri?: string): string {
  const uri = modelUri ?? resolveEmbedModel();
  if (isQwen3EmbeddingModel(uri)) {
    // Qwen3-Embedding: documents are raw text, no task prefix
    return title ? `${title}\n${text}` : text;
  }
  if (isBgeEmbeddingModel(uri)) {
    // bge: passages are raw text (optionally title-prefixed), no task prefix.
    return title ? `${title}\n${text}` : text;
  }
  return `title: ${title || "none"} | text: ${text}`;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Embedding result
 */
export type EmbeddingResult = {
  embedding: number[];
  model: string;
};

/**
 * Model info
 */
export type ModelInfo = {
  name: string;
  exists: boolean;
  path?: string;
};

/**
 * Options for embedding
 */
export type EmbedOptions = {
  model?: string;
  isQuery?: boolean;
  title?: string;
};

/**
 * Options for LLM sessions
 */
export type LLMSessionOptions = {
  /** Max session duration in ms (default: 10 minutes) */
  maxDuration?: number;
  /** External abort signal */
  signal?: AbortSignal;
  /** Debug name for logging */
  name?: string;
};

/**
 * Session interface for scoped LLM access with lifecycle guarantees
 */
export interface ILLMSession {
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
  embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;
  /** Whether this session is still valid (not released or aborted) */
  readonly isValid: boolean;
  /** Abort signal for this session (aborts on release or maxDuration) */
  readonly signal: AbortSignal;
}

// =============================================================================
// Model Configuration
// =============================================================================

// Embedding model resolution.
//
// qmd-gd runs only the local embedding model. Generative query expansion and
// reranking are delegated to the calling agent (ADR 0002), so the former
// generate/rerank model URIs and their resolvers have been removed.
//
// Three URI shapes are understood:
//   bundled:<file>      a GGUF committed in-repo under models/ (the default) —
//                       resolved to an absolute on-disk path with NO network.
//   hf:<user>/<repo>/<file>   downloaded from HuggingFace via node-llama-cpp.
//   <absolute path>     a local .gguf, passed through as-is (QMD_EMBED_MODEL).
//
// The default is bge-small-en-v1.5 (BAAI, MIT, 384-dim), vendored so a fresh
// clone needs no network to embed. Override with QMD_EMBED_MODEL=<abs path> or
// an hf: URI (e.g. hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf).

// Package root: dist/llm.js -> dist/.. and src/llm.ts -> src/.. both resolve to
// the package directory that holds models/.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_MODEL_DIR = join(PKG_ROOT, "models");

const DEFAULT_EMBED_MODEL = "bundled:bge-small-en-v1.5-Q8_0.gguf";

export const DEFAULT_EMBED_MODEL_URI = DEFAULT_EMBED_MODEL;

/**
 * Map a "bundled:<file>" URI to its absolute path inside the packaged models/
 * directory. Returns null for non-bundled URIs (hf:..., absolute paths, etc.).
 * The "bundled:" identity is stable and portable, so it is what gets written
 * into the index's model column and embedding fingerprint.
 */
export function resolveBundledModelPath(model: string): string | null {
  if (!model.startsWith("bundled:")) return null;
  return join(BUNDLED_MODEL_DIR, model.slice("bundled:".length));
}

export type ModelResolutionConfig = {
  embed?: string;
};

export function resolveEmbedModel(config?: ModelResolutionConfig): string {
  return config?.embed || process.env.QMD_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

// Local model cache directory
const MODEL_CACHE_DIR = process.env.XDG_CACHE_HOME
  ? join(process.env.XDG_CACHE_HOME, "qmd", "models")
  : join(homedir(), ".cache", "qmd", "models");
export const DEFAULT_MODEL_CACHE_DIR = MODEL_CACHE_DIR;

export type PullResult = {
  model: string;
  path: string;
  sizeBytes: number;
  refreshed: boolean;
};

type HfRef = {
  repo: string;
  file: string;
};

function parseHfUri(model: string): HfRef | null {
  if (!model.startsWith("hf:")) return null;
  const without = model.slice(3);
  const parts = without.split("/");
  if (parts.length < 3) return null;
  const repo = parts.slice(0, 2).join("/");
  const file = parts.slice(2).join("/");
  return { repo, file };
}

async function getRemoteEtag(ref: HfRef): Promise<string | null> {
  const url = `https://huggingface.co/${ref.repo}/resolve/main/${ref.file}`;
  try {
    const resp = await fetch(url, { method: "HEAD" });
    if (!resp.ok) return null;
    const etag = resp.headers.get("etag");
    return etag || null;
  } catch {
    return null;
  }
}

const GGUF_MAGIC = Buffer.from("GGUF");

export type GgufFileInspection = {
  exists: boolean;
  valid: boolean;
  kind: "missing" | "gguf" | "html" | "invalid";
  sizeBytes?: number;
  magic?: string;
  details: string;
};

function formatModelFileSize(sizeBytes: number): string {
  return `${(sizeBytes / 1024).toFixed(0)} KB`;
}

function printableMagic(header: Buffer): string {
  const text = header.toString("utf-8");
  return /^[\x20-\x7e]{1,4}$/.test(text) ? text : `0x${header.toString("hex")}`;
}

/**
 * Inspect a potential GGUF model file without mutating it.
 * Used by doctor for early diagnostics and by runtime validation before load.
 */
export function inspectGgufFile(filePath: string): GgufFileInspection {
  if (!existsSync(filePath)) {
    return { exists: false, valid: false, kind: "missing", details: "file does not exist" };
  }

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(filePath).size;
    const fd = openSync(filePath, "r");
    const sniff = Buffer.alloc(512);
    try {
      readSync(fd, sniff, 0, 512, 0);
    } finally {
      closeSync(fd);
    }

    const header = sniff.subarray(0, 4);
    if (header.equals(GGUF_MAGIC)) {
      return {
        exists: true,
        valid: true,
        kind: "gguf",
        sizeBytes,
        magic: "GGUF",
        details: `valid GGUF (${formatModelFileSize(sizeBytes)})`,
      };
    }

    const magic = printableMagic(header);
    const text = sniff.toString("utf-8").toLowerCase();
    const isHtml = text.includes("<!doctype") || text.includes("<html");
    if (isHtml) {
      return {
        exists: true,
        valid: false,
        kind: "html",
        sizeBytes,
        magic,
        details: `HTML page, not a GGUF model (${formatModelFileSize(sizeBytes)}); likely proxy/firewall/captive portal response`,
      };
    }

    return {
      exists: true,
      valid: false,
      kind: "invalid",
      sizeBytes,
      magic,
      details: `not valid GGUF (expected magic "GGUF", got "${magic}", ${formatModelFileSize(sizeBytes)})`,
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      kind: "invalid",
      sizeBytes,
      details: `cannot read model file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Validate that a file is actually a GGUF model, not an HTML error page
 * from a proxy, firewall, or failed download.
 * Throws a descriptive error if the file is not valid GGUF.
 */
function validateGgufFile(filePath: string, modelUri: string): void {
  const inspection = inspectGgufFile(filePath);
  if (!inspection.exists || inspection.valid) return; // let downstream handle missing files

  // Remove the bad file so the next attempt re-downloads
  try {
    unlinkSync(filePath);
  } catch { /* best effort */ }

  if (inspection.kind === "html") {
    throw new Error(
      `Downloaded model file is an HTML page, not a GGUF model (${formatModelFileSize(inspection.sizeBytes ?? 0)}).\n` +
      `Something is intercepting the download from huggingface.co (a proxy, firewall, or captive portal).\n\n` +
      `Model: ${modelUri}\n` +
      `Path:  ${filePath}\n\n` +
      `To fix this, either:\n` +
      `  1. Try a HuggingFace mirror:  HF_ENDPOINT=https://hf-mirror.com qmd embed\n` +
      `  2. Download the model manually and set the env var, e.g.:\n` +
      `       QMD_EMBED_MODEL=/path/to/model.gguf qmd embed\n\n` +
      `Note: 'qmd search' works without any model downloads.`
    );
  }

  throw new Error(
    `Model file is not valid GGUF (expected magic "GGUF", got "${inspection.magic ?? "unknown"}", file is ${formatModelFileSize(inspection.sizeBytes ?? 0)}).\n` +
    `Model: ${modelUri}\n` +
    `Path:  ${filePath}\n\n` +
    `The file has been removed. Run the command again to re-download.`
  );
}

export async function pullModels(
  models: string[],
  options: { refresh?: boolean; cacheDir?: string } = {}
): Promise<PullResult[]> {
  const cacheDir = options.cacheDir || MODEL_CACHE_DIR;
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const results: PullResult[] = [];
  for (const model of models) {
    let refreshed = false;

    // Bundled models are committed in-repo — nothing to download.
    const bundledPath = resolveBundledModelPath(model);
    if (bundledPath) {
      if (!existsSync(bundledPath)) {
        throw new Error(
          `Bundled embedding model not found at ${bundledPath}. ` +
          `The packaged models/ asset may be missing.`
        );
      }
      validateGgufFile(bundledPath, model);
      results.push({ model, path: bundledPath, sizeBytes: statSync(bundledPath).size, refreshed: false });
      continue;
    }

    const hfRef = parseHfUri(model);
    const filename = model.split("/").pop();
    const entries = readdirSync(cacheDir, { withFileTypes: true });
    const cached = filename
      ? entries
          .filter((entry) => entry.isFile() && entry.name.includes(filename))
          .map((entry) => join(cacheDir, entry.name))
      : [];

    if (hfRef && filename) {
      const etagPath = join(cacheDir, `${filename}.etag`);
      const remoteEtag = await getRemoteEtag(hfRef);
      const localEtag = existsSync(etagPath)
        ? readFileSync(etagPath, "utf-8").trim()
        : null;
      const shouldRefresh =
        options.refresh || !remoteEtag || remoteEtag !== localEtag || cached.length === 0;

      if (shouldRefresh) {
        for (const candidate of cached) {
          if (existsSync(candidate)) unlinkSync(candidate);
        }
        if (existsSync(etagPath)) unlinkSync(etagPath);
        refreshed = cached.length > 0;
      }
    } else if (options.refresh && filename) {
      for (const candidate of cached) {
        if (existsSync(candidate)) unlinkSync(candidate);
        refreshed = true;
      }
    }

    const { resolveModelFile } = await loadNodeLlamaCpp();
    const path = await resolveModelFile(model, cacheDir);
    validateGgufFile(path, model);
    const sizeBytes = existsSync(path) ? statSync(path).size : 0;
    if (hfRef && filename) {
      const remoteEtag = await getRemoteEtag(hfRef);
      if (remoteEtag) {
        const etagPath = join(cacheDir, `${filename}.etag`);
        writeFileSync(etagPath, remoteEtag + "\n", "utf-8");
      }
    }
    results.push({ model, path, sizeBytes, refreshed });
  }
  return results;
}

// =============================================================================
// LLM Interface
// =============================================================================

/**
 * Abstract LLM interface - implement this for different backends
 */
export interface LLM {
  /**
   * Get embeddings for text
   */
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;

  /**
   * Check if a model exists/is available
   */
  modelExists(model: string): Promise<ModelInfo>;

  /**
   * Dispose of resources
   */
  dispose(): Promise<void>;
}

// =============================================================================
// node-llama-cpp Implementation
// =============================================================================

export type LlamaCppConfig = {
  embedModel?: string;
  modelCacheDir?: string;
  /**
   * Inactivity timeout in ms before unloading contexts (default: 2 minutes, 0 to disable).
   *
   * Per node-llama-cpp lifecycle guidance, we prefer keeping models loaded and only disposing
   * contexts when idle, since contexts (and their sequences) are the heavy per-session objects.
   * @see https://node-llama-cpp.withcat.ai/guide/objects-lifecycle
   */
  inactivityTimeoutMs?: number;
  /**
   * Whether to dispose models on inactivity (default: false).
   *
   * Keeping models loaded avoids repeated VRAM thrash; set to true only if you need aggressive
   * memory reclaim.
   */
  disposeModelsOnInactivity?: boolean;
};

/**
 * LLM implementation using node-llama-cpp
 */
// Default inactivity timeout: 5 minutes (keep models warm during typical search sessions)
const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

export type LlamaGpuMode = "auto" | "metal" | "vulkan" | "cuda" | false;

type ParallelismOptions = {
  gpu: string | false;
  platform?: NodeJS.Platform;
  computed: number;
  envValue?: string;
};

export function resolveParallelismOverride(envValue = process.env.QMD_EMBED_PARALLELISM): number | undefined {
  const normalized = envValue?.trim() ?? "";
  if (!normalized) return undefined;

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) {
    process.stderr.write(`QMD Warning: invalid QMD_EMBED_PARALLELISM="${envValue}", using automatic parallelism.\n`);
    return undefined;
  }

  return Math.min(8, parsed);
}

export function resolveSafeParallelism(options: ParallelismOptions): number {
  const override = resolveParallelismOverride(options.envValue);
  if (override !== undefined) return override;

  // node-llama-cpp/llama.cpp CUDA on Windows is unstable with multiple
  // simultaneous contexts (ggml-cuda.cu:98 in #519). Vulkan and CPU do not
  // show the same failure mode, so only serialize Windows CUDA by default.
  if ((options.platform ?? process.platform) === "win32" && options.gpu === "cuda") {
    return 1;
  }

  return Math.max(1, options.computed);
}

export function resolveLlamaGpuMode(
  envValue = process.env.QMD_LLAMA_GPU,
  forceCpuValue = process.env.QMD_FORCE_CPU
): LlamaGpuMode {
  const forceCpu = forceCpuValue?.trim().toLowerCase() ?? "";
  if (forceCpu && !["false", "off", "none", "disable", "disabled", "0"].includes(forceCpu)) {
    return false;
  }

  const normalized = envValue?.trim().toLowerCase() ?? "";
  if (!normalized) return "auto";
  if (["false", "off", "none", "disable", "disabled", "0"].includes(normalized)) return false;
  if (normalized === "metal" || normalized === "vulkan" || normalized === "cuda") return normalized;

  process.stderr.write(`QMD Warning: invalid QMD_LLAMA_GPU="${envValue}", using auto GPU selection.\n`);
  return "auto";
}

async function disposeWithTimeout(resourceName: string, dispose: () => Promise<void>, timeoutMs = 1000): Promise<void> {
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs).unref();
  });

  try {
    const result = await Promise.race([dispose(), timeoutPromise]);
    if (result === "timeout") {
      process.stderr.write(`QMD Warning: timed out disposing ${resourceName}; continuing shutdown.\n`);
    }
  } catch (error) {
    process.stderr.write(
      `QMD Warning: failed to dispose ${resourceName} (${error instanceof Error ? error.message : String(error)}); continuing shutdown.\n`
    );
  }
}

const failedGpuInitModes = new Set<LlamaGpuMode>();
let noGpuAccelerationWarningShown = false;
let cpuForcedPrebuiltFallbackWarningShown = false;

function isCpuModeRequested(): boolean {
  return resolveLlamaGpuMode() === false;
}

export class LlamaCpp implements LLM {
  private readonly _ciMode = !!process.env.CI;
  private llama: Llama | null = null;
  private embedModel: LlamaModel | null = null;
  private embedContexts: LlamaEmbeddingContext[] = [];

  private embedModelUri: string;
  private modelCacheDir: string;

  // Ensure we don't load the same model/context concurrently (which can allocate duplicate VRAM).
  private embedModelLoadPromise: Promise<LlamaModel> | null = null;
  // Guard against concurrent ensureLlama() calls creating duplicate Llama
  // instances. Without this, two concurrent callers each build their own
  // runtime and the last write to this.llama wins, leaving models/grammars
  // bound to different Llama instances ("different Llama instance" errors).
  private llamaLoadPromise: Promise<Llama> | null = null;

  // Inactivity timer for auto-unloading models
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimeoutMs: number;
  private disposeModelsOnInactivity: boolean;

  // Track disposal state to prevent double-dispose
  private disposed = false;


  constructor(config: LlamaCppConfig = {}) {
    // STRUCTURAL INVARIANT: the launcher (bin/qmd) sets GGML_METAL_NO_RESIDENCY=1
    // on darwin BEFORE the native binding loads, which prevents the libggml-metal
    // static destructor assertion at process exit (ggml-org/llama.cpp#22593).
    // See isDarwinMetalMitigationActive() for the runtime check exposed to
    // diagnostics. No constructor-time guard installation is needed.

    this.embedModelUri = resolveEmbedModel({ embed: config.embedModel });
    this.modelCacheDir = config.modelCacheDir || MODEL_CACHE_DIR;
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.disposeModelsOnInactivity = config.disposeModelsOnInactivity ?? false;
  }

  get embedModelName(): string {
    return this.embedModelUri;
  }

  /**
   * Reset the inactivity timer. Called after each model operation.
   * When timer fires, models are unloaded to free memory (if no active sessions).
   */
  private touchActivity(): void {
    // Clear existing timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Only set timer if we have disposable contexts and timeout is enabled
    if (this.inactivityTimeoutMs > 0 && this.hasLoadedContexts()) {
      this.inactivityTimer = setTimeout(() => {
        // Check if session manager allows unloading
        // canUnloadLLM is defined later in this file - it checks the session manager
        // We use dynamic import pattern to avoid circular dependency issues
        if (typeof canUnloadLLM === 'function' && !canUnloadLLM()) {
          // Active sessions/operations - reschedule timer
          this.touchActivity();
          return;
        }
        this.unloadIdleResources().catch(err => {
          console.error("Error unloading idle resources:", err);
        });
      }, this.inactivityTimeoutMs);
      // Don't keep process alive just for this timer
      this.inactivityTimer.unref();
    }
  }

  /**
   * Check if any contexts are currently loaded (and therefore worth unloading on inactivity).
   */
  private hasLoadedContexts(): boolean {
    return this.embedContexts.length > 0;
  }

  /**
   * Unload idle resources but keep the instance alive for future use.
   *
   * By default, this disposes contexts (and their dependent sequences), while keeping models loaded.
   * This matches the intended lifecycle: model → context → sequence, where contexts are per-session.
   */
  async unloadIdleResources(): Promise<void> {
    // Don't unload if already disposed
    if (this.disposed) {
      return;
    }

    // Clear timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Dispose contexts first
    for (const ctx of this.embedContexts) {
      await ctx.dispose();
    }
    this.embedContexts = [];

    // Optionally dispose models too (opt-in)
    if (this.disposeModelsOnInactivity) {
      if (this.embedModel) {
        await this.embedModel.dispose();
        this.embedModel = null;
      }
      // Reset load promise so the model can be reloaded later
      this.embedModelLoadPromise = null;
    }

    // Note: We keep llama instance alive - it's lightweight
  }

  /**
   * Ensure model cache directory exists
   */
  private ensureModelCacheDir(): void {
    if (!existsSync(this.modelCacheDir)) {
      mkdirSync(this.modelCacheDir, { recursive: true });
    }
  }

  /**
   * Initialize the llama instance (lazy)
   */
  private async ensureLlama(allowBuild = true): Promise<Llama> {
    if (this.llama) {
      return this.llama;
    }
    if (this.llamaLoadPromise) {
      return await this.llamaLoadPromise;
    }
    this.llamaLoadPromise = this.loadLlamaRuntime(allowBuild);
    try {
      return await this.llamaLoadPromise;
    } finally {
      this.llamaLoadPromise = null;
    }
  }

  private async loadLlamaRuntime(allowBuild = true): Promise<Llama> {
    if (!this.llama) {
      const gpuMode = resolveLlamaGpuMode();

      const { getLlama, getLlamaGpuTypes, LlamaLogLevel } = await loadNodeLlamaCpp();
      const loadLlama = async (gpu: LlamaGpuMode, sourceBuildAllowed = allowBuild, buildOverride?: "auto" | "never") =>
        await withNativeStdoutRedirectedToStderr(() => getLlama({
          // Prefer packaged prebuilt bindings before compiling llama.cpp locally.
          // node-llama-cpp documents gpu:"auto" as the best default: Metal on
          // Apple Silicon, CUDA when fully available, Vulkan where available,
          // then CPU. Use build:"auto" for normal loads and build:"never" for
          // diagnostic/probe paths that must not compile llama.cpp.
          build: buildOverride ?? (sourceBuildAllowed ? "auto" : "never"),
          logLevel: LlamaLogLevel.error,
          gpu,
          progressLogs: false,
          skipDownload: !sourceBuildAllowed,
        }));
      const loadCpuCompatibleLlama = async () => {
        try {
          return await loadLlama(false, false);
        } catch (err) {
          // Some platforms, notably Apple Silicon, ship a Metal prebuilt but no
          // CPU-only prebuilt. Do a fast no-build lookup for an actual CPU
          // binding first; if it does not exist, use the packaged auto/Metal
          // binding and disable model offloading via gpuLayers: 0.
          if (!cpuForcedPrebuiltFallbackWarningShown) {
            cpuForcedPrebuiltFallbackWarningShown = true;
            process.stderr.write(
              `QMD Warning: CPU-only llama.cpp prebuilt not available (${err instanceof Error ? err.message : String(err)}); using packaged backend with GPU offloading disabled.\n`
            );
          }
          return await loadLlama("auto", false);
        }
      };

      let llama: Llama;
      if (gpuMode === false) {
        llama = await loadCpuCompatibleLlama();
      } else if (failedGpuInitModes.has(gpuMode)) {
        process.stderr.write(
          `QMD Warning: skipping previously failed GPU init${gpuMode === "auto" ? "" : ` for QMD_LLAMA_GPU=${gpuMode}`}, using CPU.\n`
        );
        llama = await loadCpuCompatibleLlama();
      } else {
        try {
          llama = await loadLlama(gpuMode);

          // If node-llama-cpp auto-detection chose CPU, do one no-build pass
          // over all OS-valid packaged GPU backends. This preserves the
          // documented auto mode for Metal/CUDA/Vulkan while recovering on
          // systems where a packaged backend can load but detection is too
          // conservative. Never compile during these extra probes.
          if (gpuMode === "auto" && llama.gpu === false && getLlamaGpuTypes) {
            const candidates = (await getLlamaGpuTypes("allValid"))
              .filter((candidate): candidate is Exclude<LlamaGpuMode, "auto" | false> => candidate !== false && candidate !== "auto");
            for (const candidate of candidates) {
              if (failedGpuInitModes.has(candidate)) continue;
              try {
                const gpuLlama = await loadLlama(candidate, false, "never");
                if (gpuLlama.gpu !== false) {
                  await disposeWithTimeout("CPU llama runtime", () => llama.dispose());
                  llama = gpuLlama;
                  break;
                }
                await disposeWithTimeout(`${candidate} probe runtime`, () => gpuLlama.dispose());
              } catch {
                failedGpuInitModes.add(candidate);
              }
            }
          }
        } catch (err) {
          // GPU backend (e.g. Vulkan/CUDA on headless/driverless machines) can throw at init.
          // Fall back to CPU so qmd still works, and cache the failure to avoid repeated
          // expensive native build/probe attempts in this process.
          failedGpuInitModes.add(gpuMode);
          process.stderr.write(
            `QMD Warning: GPU init failed${gpuMode === "auto" ? "" : ` for QMD_LLAMA_GPU=${gpuMode}`} (${err instanceof Error ? err.message : String(err)}), falling back to CPU.\n`
          );
          llama = await loadCpuCompatibleLlama();
        }
      }

      if (llama.gpu === false && !noGpuAccelerationWarningShown) {
        noGpuAccelerationWarningShown = true;
        process.stderr.write(
          "QMD Warning: no GPU acceleration, running on CPU (slow). Run 'qmd doctor' for device diagnostics.\n"
        );
      }
      this.llama = llama;
    }
    return this.llama;
  }

  private isCpuOffloadForced(): boolean {
    return isCpuModeRequested();
  }

  private modelLoadOptions(modelPath: string): { modelPath: string; gpuLayers?: number } {
    return {
      modelPath,
      ...(this.isCpuOffloadForced() ? { gpuLayers: 0 } : {}),
    };
  }

  /**
   * Resolve a model URI to a local path, downloading if needed.
   * Validates the downloaded file is actually a GGUF model (not an HTML error page
   * from a proxy or firewall).
   */
  private async resolveModel(modelUri: string): Promise<string> {
    this.ensureModelCacheDir();
    // Bundled models ship in-repo under models/; resolve to the on-disk file with
    // no network round-trip — the same fast path as an explicit local QMD_EMBED_MODEL.
    const bundled = resolveBundledModelPath(modelUri);
    if (bundled) {
      if (!existsSync(bundled)) {
        throw new Error(
          `Bundled embedding model not found at ${bundled}.\n` +
          `The packaged models/ asset appears to be missing — reinstall qmd-gd, or set ` +
          `QMD_EMBED_MODEL to a local .gguf file.`
        );
      }
      validateGgufFile(bundled, modelUri);
      return bundled;
    }
    // resolveModelFile handles HF URIs and downloads to the cache dir
    const { resolveModelFile } = await loadNodeLlamaCpp();
    const modelPath = await resolveModelFile(modelUri, this.modelCacheDir);
    validateGgufFile(modelPath, modelUri);
    return modelPath;
  }

  /**
   * Load embedding model (lazy)
   */
  private async ensureEmbedModel(): Promise<LlamaModel> {
    if (this.embedModel) {
      return this.embedModel;
    }
    if (this.embedModelLoadPromise) {
      return await this.embedModelLoadPromise;
    }

    this.embedModelLoadPromise = (async () => {
      const llama = await this.ensureLlama();
      const modelPath = await this.resolveModel(this.embedModelUri);
      const model = await llama.loadModel(this.modelLoadOptions(modelPath));
      this.embedModel = model;
      // Model loading counts as activity - ping to keep alive
      this.touchActivity();
      return model;
    })();

    try {
      return await this.embedModelLoadPromise;
    } finally {
      // Keep the resolved model cached; clear only the in-flight promise.
      this.embedModelLoadPromise = null;
    }
  }

  /**
   * Compute how many parallel contexts to create.
   *
   * GPU: constrained by VRAM (25% of free, capped at 8).
   * CPU: constrained by cores. Splitting threads across contexts enables
   *      true parallelism (each context runs on its own cores). Use at most
   *      half the math cores, with at least 4 threads per context.
   */
  private async computeParallelism(perContextMB: number): Promise<number> {
    const llama = await this.ensureLlama();

    if (!this.isCpuOffloadForced() && llama.gpu) {
      try {
        const vram = await llama.getVramState();
        const freeMB = vram.free / (1024 * 1024);
        const maxByVram = Math.floor((freeMB * 0.25) / perContextMB);
        const computed = Math.max(1, Math.min(8, maxByVram));
        return resolveSafeParallelism({ gpu: llama.gpu, computed });
      } catch {
        return resolveSafeParallelism({ gpu: llama.gpu, computed: 2 });
      }
    }

    // CPU: split cores across contexts. At least 4 threads per context.
    const cores = llama.cpuMathCores || 4;
    const maxContexts = Math.floor(cores / 4);
    const computed = Math.max(1, Math.min(4, maxContexts));
    return resolveSafeParallelism({ gpu: false, computed });
  }

  /**
   * Get the number of threads each context should use, given N parallel contexts.
   * Splits available math cores evenly across contexts.
   */
  private async threadsPerContext(parallelism: number): Promise<number> {
    const llama = await this.ensureLlama();
    if (!this.isCpuOffloadForced() && llama.gpu) return 0; // GPU: let the library decide
    const cores = llama.cpuMathCores || 4;
    return Math.max(1, Math.floor(cores / parallelism));
  }

  /**
   * Load embedding contexts (lazy). Creates multiple for parallel embedding.
   * Uses promise guard to prevent concurrent context creation race condition.
   */
  private embedContextsCreatePromise: Promise<LlamaEmbeddingContext[]> | null = null;

  private async ensureEmbedContexts(): Promise<LlamaEmbeddingContext[]> {
    if (this.embedContexts.length > 0) {
      this.touchActivity();
      return this.embedContexts;
    }

    if (this.embedContextsCreatePromise) {
      return await this.embedContextsCreatePromise;
    }

    this.embedContextsCreatePromise = (async () => {
      const model = await this.ensureEmbedModel();
      // Embed contexts are ~143 MB each (nomic-embed 2048 ctx)
      const n = await this.computeParallelism(150);
      const threads = await this.threadsPerContext(n);
      for (let i = 0; i < n; i++) {
        try {
          this.embedContexts.push(await model.createEmbeddingContext({
            contextSize: LlamaCpp.EMBED_CONTEXT_SIZE,
            ...(threads > 0 ? { threads } : {}),
          }));
        } catch {
          if (this.embedContexts.length === 0) throw new Error("Failed to create any embedding context");
          break;
        }
      }
      this.touchActivity();
      return this.embedContexts;
    })();

    try {
      return await this.embedContextsCreatePromise;
    } finally {
      this.embedContextsCreatePromise = null;
    }
  }

  /**
   * Get a single embed context (for single-embed calls). Uses first from pool.
   */
  private async ensureEmbedContext(): Promise<LlamaEmbeddingContext> {
    const contexts = await this.ensureEmbedContexts();
    return contexts[0]!;
  }

  private static readonly EMBED_CONTEXT_SIZE: number = (() => {
    const v = parseInt(process.env.QMD_EMBED_CONTEXT_SIZE ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : 2048;
  })();

  // ==========================================================================
  // Tokenization
  // ==========================================================================

  /**
   * Tokenize text using the embedding model's tokenizer
   * Returns tokenizer tokens (opaque type from node-llama-cpp)
   */
  async tokenize(text: string): Promise<readonly LlamaToken[]> {
    await this.ensureEmbedContext();  // Ensure model is loaded
    if (!this.embedModel) {
      throw new Error("Embed model not loaded");
    }
    return this.embedModel.tokenize(text);
  }

  /**
   * Count tokens in text using the embedding model's tokenizer
   */
  async countTokens(text: string): Promise<number> {
    const tokens = await this.tokenize(text);
    return tokens.length;
  }

  /**
   * Detokenize token IDs back to text
   */
  async detokenize(tokens: readonly LlamaToken[]): Promise<string> {
    await this.ensureEmbedContext();
    if (!this.embedModel) {
      throw new Error("Embed model not loaded");
    }
    return this.embedModel.detokenize(tokens);
  }

  // ==========================================================================
  // Core API methods
  // ==========================================================================

  /**
   * Truncate text to fit within the embedding model's context window.
   * Uses the model's own tokenizer for accurate token counting, then
   * detokenizes back to text if truncation is needed.
   * Returns the (possibly truncated) text and whether truncation occurred.
   */
  private resolveEmbedTokenLimit(): number {
    const trainedContextSize = this.embedModel?.trainContextSize;
    if (typeof trainedContextSize === "number" && Number.isFinite(trainedContextSize) && trainedContextSize > 0) {
      return Math.max(1, Math.min(LlamaCpp.EMBED_CONTEXT_SIZE, trainedContextSize));
    }
    return LlamaCpp.EMBED_CONTEXT_SIZE;
  }

  private async truncateToContextSize(
    text: string
  ): Promise<{ text: string; truncated: boolean; limit: number }> {
    if (!this.embedModel) return { text, truncated: false, limit: LlamaCpp.EMBED_CONTEXT_SIZE };

    const maxTokens = this.resolveEmbedTokenLimit();
    if (maxTokens <= 0) return { text, truncated: false, limit: maxTokens };

    const tokens = this.embedModel.tokenize(text);
    if (tokens.length <= maxTokens) return { text, truncated: false, limit: maxTokens };

    // Leave a small margin (4 tokens) for BOS/EOS overhead
    const safeLimit = Math.max(1, maxTokens - 4);
    const truncatedTokens = tokens.slice(0, safeLimit);
    const truncatedText = this.embedModel.detokenize(truncatedTokens);
    return { text: truncatedText, truncated: true, limit: maxTokens };
  }

  async embed(text: string, options: EmbedOptions = {}): Promise<EmbeddingResult | null> {
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    try {
      const context = await this.ensureEmbedContext();

      // Guard: truncate text that exceeds model context window to prevent GGML crash
      const { text: safeText, truncated, limit } = await this.truncateToContextSize(text);
      if (truncated) {
        console.warn(`⚠ Text truncated to fit embedding context (${limit} tokens)`);
      }

      const embedding = await context.getEmbeddingFor(safeText);

      return {
        embedding: Array.from(embedding.vector),
        model: options.model ?? this.embedModelUri,
      };
    } catch (error) {
      console.error("Embedding error:", error);
      return null;
    }
  }

  /**
   * Batch embed multiple texts efficiently
   * Uses Promise.all for parallel embedding - node-llama-cpp handles batching internally
   */
  async embedBatch(texts: string[], options: EmbedOptions = {}): Promise<(EmbeddingResult | null)[]> {
    if (this._ciMode) throw new Error("LLM operations are disabled in CI (set CI=true)");
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    if (texts.length === 0) return [];

    try {
      const contexts = await this.ensureEmbedContexts();
      const n = contexts.length;

      if (n === 1) {
        // Single context: sequential (no point splitting)
        const context = contexts[0]!;
        const embeddings: ({ embedding: number[]; model: string } | null)[] = [];
        for (const text of texts) {
          try {
            const { text: safeText, truncated, limit } = await this.truncateToContextSize(text);
            if (truncated) {
              console.warn(`⚠ Batch text truncated to fit embedding context (${limit} tokens)`);
            }
            const embedding = await context.getEmbeddingFor(safeText);
            this.touchActivity();
            embeddings.push({ embedding: Array.from(embedding.vector), model: options.model ?? this.embedModelUri });
          } catch (err) {
            console.error("Embedding error for text:", err);
            embeddings.push(null);
          }
        }
        return embeddings;
      }

      // Multiple contexts: split texts across contexts for parallel evaluation
      const chunkSize = Math.ceil(texts.length / n);
      const chunks = Array.from({ length: n }, (_, i) =>
        texts.slice(i * chunkSize, (i + 1) * chunkSize)
      );

      const chunkResults = await Promise.all(
        chunks.map(async (chunk, i) => {
          const ctx = contexts[i]!;
          const results: (EmbeddingResult | null)[] = [];
          for (const text of chunk) {
            try {
              const { text: safeText, truncated, limit } = await this.truncateToContextSize(text);
              if (truncated) {
                console.warn(`⚠ Batch text truncated to fit embedding context (${limit} tokens)`);
              }
              const embedding = await ctx.getEmbeddingFor(safeText);
              this.touchActivity();
              results.push({ embedding: Array.from(embedding.vector), model: options.model ?? this.embedModelUri });
            } catch (err) {
              console.error("Embedding error for text:", err);
              results.push(null);
            }
          }
          return results;
        })
      );

      return chunkResults.flat();
    } catch (error) {
      console.error("Batch embedding error:", error);
      return texts.map(() => null);
    }
  }

  async modelExists(modelUri: string): Promise<ModelInfo> {
    // For HuggingFace URIs, we assume they exist
    // For local paths, check if file exists
    if (modelUri.startsWith("hf:")) {
      return { name: modelUri, exists: true };
    }

    const exists = existsSync(modelUri);
    return {
      name: modelUri,
      exists,
      path: exists ? modelUri : undefined,
    };
  }


  /**
   * Get device/GPU info for status display.
   * Initializes llama if not already done.
   */
  async getDeviceInfo(options: { allowBuild?: boolean } = {}): Promise<{
    gpu: string | false;
    gpuOffloading: boolean;
    gpuDevices: string[];
    vram?: { total: number; used: number; free: number };
    cpuCores: number;
  }> {
    const llama = await this.ensureLlama(options.allowBuild ?? true);
    const cpuForced = this.isCpuOffloadForced();
    const gpuDevices = cpuForced ? [] : await llama.getGpuDeviceNames();
    let vram: { total: number; used: number; free: number } | undefined;
    if (!cpuForced && llama.gpu) {
      try {
        const state = await llama.getVramState();
        vram = { total: state.total, used: state.used, free: state.free };
      } catch { /* no vram info */ }
    }
    return {
      gpu: cpuForced ? false : llama.gpu,
      gpuOffloading: !cpuForced && llama.supportsGpuOffloading,
      gpuDevices,
      vram,
      cpuCores: llama.cpuMathCores,
    };
  }

  async dispose(): Promise<void> {
    // Prevent double-dispose
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Clear inactivity timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Explicitly dispose in dependency order: contexts first, then models, then llama.
    // Relying only on llama.dispose() leaves Metal resource sets alive until process
    // finalization on Apple Silicon, where ggml_metal_device_free can abort after
    // otherwise-successful CLI output (#368).
    for (const ctx of this.embedContexts) {
      await disposeWithTimeout("embedding context", () => ctx.dispose());
    }
    this.embedContexts = [];

    if (this.embedModel) {
      await disposeWithTimeout("embedding model", () => this.embedModel!.dispose());
      this.embedModel = null;
    }

    if (this.llama) {
      await disposeWithTimeout("llama runtime", () => this.llama!.dispose());
      this.llama = null;
    }

    // Clear any in-flight load/create promises
    this.embedModelLoadPromise = null;
    this.embedContextsCreatePromise = null;
    this.llamaLoadPromise = null;
  }
}

// =============================================================================
// Session Management Layer
// =============================================================================

/**
 * Manages LLM session lifecycle with reference counting.
 * Coordinates with LlamaCpp idle timeout to prevent disposal during active sessions.
 */
class LLMSessionManager {
  private llm: LlamaCpp;
  private _activeSessionCount = 0;
  private _inFlightOperations = 0;

  constructor(llm: LlamaCpp) {
    this.llm = llm;
  }

  get activeSessionCount(): number {
    return this._activeSessionCount;
  }

  get inFlightOperations(): number {
    return this._inFlightOperations;
  }

  /**
   * Returns true only when both session count and in-flight operations are 0.
   * Used by LlamaCpp to determine if idle unload is safe.
   */
  canUnload(): boolean {
    return this._activeSessionCount === 0 && this._inFlightOperations === 0;
  }

  acquire(): void {
    this._activeSessionCount++;
  }

  release(): void {
    this._activeSessionCount = Math.max(0, this._activeSessionCount - 1);
  }

  operationStart(): void {
    this._inFlightOperations++;
  }

  operationEnd(): void {
    this._inFlightOperations = Math.max(0, this._inFlightOperations - 1);
  }

  getLlamaCpp(): LlamaCpp {
    return this.llm;
  }
}

/**
 * Error thrown when an operation is attempted on a released or aborted session.
 */
export class SessionReleasedError extends Error {
  constructor(message = "LLM session has been released or aborted") {
    super(message);
    this.name = "SessionReleasedError";
  }
}

/**
 * Scoped LLM session with automatic lifecycle management.
 * Wraps LlamaCpp methods with operation tracking and abort handling.
 */
class LLMSession implements ILLMSession {
  private manager: LLMSessionManager;
  private released = false;
  private abortController: AbortController;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private name: string;

  constructor(manager: LLMSessionManager, options: LLMSessionOptions = {}) {
    this.manager = manager;
    this.name = options.name || "unnamed";
    this.abortController = new AbortController();

    // Link external abort signal if provided
    if (options.signal) {
      if (options.signal.aborted) {
        this.abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener("abort", () => {
          this.abortController.abort(options.signal!.reason);
        }, { once: true });
      }
    }

    // Set up max duration timer
    const maxDuration = options.maxDuration ?? 10 * 60 * 1000; // Default 10 minutes
    if (maxDuration > 0) {
      this.maxDurationTimer = setTimeout(() => {
        this.abortController.abort(new Error(`Session "${this.name}" exceeded max duration of ${maxDuration}ms`));
      }, maxDuration);
      this.maxDurationTimer.unref(); // Don't keep process alive
    }

    // Acquire session lease
    this.manager.acquire();
  }

  get isValid(): boolean {
    return !this.released && !this.abortController.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Release the session and decrement ref count.
   * Called automatically by withLLMSession when the callback completes.
   */
  release(): void {
    if (this.released) return;
    this.released = true;

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    this.abortController.abort(new Error("Session released"));
    this.manager.release();
  }

  /**
   * Wrap an operation with tracking and abort checking.
   */
  private async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isValid) {
      throw new SessionReleasedError();
    }

    this.manager.operationStart();
    try {
      // Check abort before starting
      if (this.abortController.signal.aborted) {
        throw new SessionReleasedError(
          this.abortController.signal.reason?.message || "Session aborted"
        );
      }
      return await fn();
    } finally {
      this.manager.operationEnd();
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.withOperation(() => this.manager.getLlamaCpp().embed(text, options));
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    return this.withOperation(() => this.manager.getLlamaCpp().embedBatch(texts, options));
  }
}

// Session manager for the default LlamaCpp instance
let defaultSessionManager: LLMSessionManager | null = null;

/**
 * Get the session manager for the default LlamaCpp instance.
 */
function getSessionManager(): LLMSessionManager {
  const llm = getDefaultLlamaCpp();
  if (!defaultSessionManager || defaultSessionManager.getLlamaCpp() !== llm) {
    defaultSessionManager = new LLMSessionManager(llm);
  }
  return defaultSessionManager;
}

/**
 * Execute a function with a scoped LLM session.
 * The session provides lifecycle guarantees - resources won't be disposed mid-operation.
 *
 * @example
 * ```typescript
 * await withLLMSession(async (session) => {
 *   const embeddings = await session.embedBatch(texts);
 *   return embeddings;
 * }, { maxDuration: 10 * 60 * 1000, name: 'embedQueries' });
 * ```
 */
export async function withLLMSession<T>(
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions
): Promise<T> {
  const manager = getSessionManager();
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * Execute a function with a scoped LLM session using a specific LlamaCpp instance.
 * Unlike withLLMSession, this does not use the global singleton.
 */
export async function withLLMSessionForLlm<T>(
  llm: LlamaCpp,
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions
): Promise<T> {
  const manager = new LLMSessionManager(llm);
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * Check if idle unload is safe (no active sessions or operations).
 * Used internally by LlamaCpp idle timer.
 */
export function canUnloadLLM(): boolean {
  if (!defaultSessionManager) return true;
  return defaultSessionManager.canUnload();
}

// =============================================================================
// Darwin Metal exit-crash mitigation
// =============================================================================
//
// libggml-metal on macOS keeps allocated model memory wired via "residency
// sets" with a 180-second keep_alive timer (added in ggml-org/llama.cpp#11427).
// The process-static `std::vector<std::unique_ptr<ggml_metal_device>>`
// destructor fires during libc `exit()` → `__cxa_finalize_ranges` and asserts
// `[rsets->data count] == 0` — but the keep_alive hasn't expired, so the
// assertion fails and `ggml_abort` dumps a multi-kilobyte stack trace to
// stderr after the user-visible output. See ggml-org/llama.cpp#22593.
//
// No JS-side dispose call (`llama.dispose()`, `model.dispose()`, etc.) can
// prevent it: the static destructor runs after every JS-reachable cleanup,
// and `process.reallyExit` on Node calls libc `exit()` not `_exit()` (it
// does NOT skip C++ static destructors — verified in
// node/src/api/environment.cc).
//
// The actual fix is to disable residency sets via `GGML_METAL_NO_RESIDENCY=1`,
// which we set from `bin/qmd` before Node loads the native binding. For QMD's
// short-lived CLI workflow this has no measurable cost (subsequent calls
// don't reuse the warm mapping). The functions below report whether that
// mitigation is in effect — kept here, in the module that depends on the
// underlying resource, so doctor can answer "is the protection active?"
// without reaching into env handling directly.
//
// Setting `QMD_METAL_KEEP_RESIDENCY=1` opts back into residency sets (with
// the visible-noise consequences). The legacy `QMD_DISABLE_DARWIN_SAFE_EXIT`
// env var is accepted as a no-op alias for back-compat; it had no effect on
// Node prior to this fix.

/**
 * Whether QMD's darwin Metal exit-crash mitigation is active in this process:
 *   true  → residency sets disabled, process exit completes silently
 *   false → either non-darwin, or `QMD_METAL_KEEP_RESIDENCY=1` overrode it,
 *           in which case the libggml-metal teardown assertion may fire
 */
export function isDarwinMetalMitigationActive(): boolean {
  if (process.platform !== "darwin") return false;
  if (process.env.QMD_METAL_KEEP_RESIDENCY === "1") return false;
  return process.env.GGML_METAL_NO_RESIDENCY === "1";
}

/**
 * Compatibility shim: previous releases installed a `process.on('exit')` hook
 * that tried to skip the C++ static destructor by calling `process.reallyExit`.
 * That mechanism didn't work on Node (Environment::Exit still calls libc
 * `exit()`), so it was replaced by `GGML_METAL_NO_RESIDENCY=1` from bin/qmd.
 * Kept as a no-op for code paths that still call it; safe to remove once no
 * production launcher predates the residency-set fix.
 */
export function installDarwinExitGuard(): void {
  // Intentional no-op. See isDarwinMetalMitigationActive() for the real check.
}

/** @deprecated Replaced by isDarwinMetalMitigationActive. */
export function isDarwinExitGuardInstalled(): boolean {
  return isDarwinMetalMitigationActive();
}

// =============================================================================
// Singleton for default LlamaCpp instance
// =============================================================================

let defaultLlamaCpp: LlamaCpp | null = null;

/**
 * Get the default LlamaCpp instance (creates one if needed). The LlamaCpp
 * constructor installs the darwin exit guard, so any code path that obtains
 * the singleton is protected.
 */
export function getDefaultLlamaCpp(): LlamaCpp {
  if (!defaultLlamaCpp) {
    defaultLlamaCpp = new LlamaCpp();
  }
  return defaultLlamaCpp;
}

/**
 * Set a custom default LlamaCpp instance (useful for testing). Setting a
 * non-null instance also ensures the darwin exit guard is installed — keeps
 * the invariant intact for test doubles that didn't go through the real
 * constructor.
 */
export function setDefaultLlamaCpp(llm: LlamaCpp | null): void {
  if (llm !== null) installDarwinExitGuard();
  defaultLlamaCpp = llm;
}

/**
 * Peek at the default LlamaCpp instance without instantiating one. Used by
 * doctor and lifecycle diagnostics.
 */
export function hasDefaultLlamaCpp(): boolean {
  return defaultLlamaCpp !== null;
}

/**
 * Dispose the default LlamaCpp instance if it exists.
 * Call this before process exit to prevent NAPI crashes.
 */
export async function disposeDefaultLlamaCpp(): Promise<void> {
  if (defaultLlamaCpp) {
    await defaultLlamaCpp.dispose();
    defaultLlamaCpp = null;
  }
}

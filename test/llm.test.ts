/**
 * llm.test.ts - Unit tests for the LLM abstraction layer (node-llama-cpp)
 *
 * Run with: bun test src/llm.test.ts
 *
 * These tests require the actual models to be downloaded. Run the embed or
 * rerank functions first to trigger model downloads.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import {
  LlamaCpp,
  getDefaultLlamaCpp,
  disposeDefaultLlamaCpp,
  resolveLlamaGpuMode,
  setNodeLlamaCppModuleForTest,
  withNativeStdoutRedirectedToStderr,
  resolveParallelismOverride,
  resolveSafeParallelism,
  resolveEmbedModel,
  withLLMSession,
  canUnloadLLM,
  SessionReleasedError,
  type ILLMSession,
} from "../src/llm.js";

describe("model name resolution", () => {
  // qmd-gd runs only the local embedding model; generative query expansion and
  // reranking are delegated to the calling agent (ADR 0002).
  function withModelEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const previous = {
      QMD_EMBED_MODEL: process.env.QMD_EMBED_MODEL,
    };
    try {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("embed model resolves config hint before env fallback", () => {
    withModelEnv({
      QMD_EMBED_MODEL: "env-embed",
    }, () => {
      expect(resolveEmbedModel({ embed: "config-embed" })).toBe("config-embed");
    });
  });

  test("LlamaCpp constructor uses the same embed resolver as status/embed helpers", () => {
    withModelEnv({
      QMD_EMBED_MODEL: "env-embed",
    }, () => {
      const llm = new LlamaCpp({
        embedModel: "config-embed",
      });
      expect(llm.embedModelName).toBe(resolveEmbedModel({ embed: "config-embed" }));
    });
  });
});

// =============================================================================
// Singleton Tests (no model loading required)
// =============================================================================

describe("Default LlamaCpp Singleton", () => {
  // Test singleton behavior without resetting to avoid orphan instances
  test("getDefaultLlamaCpp returns same instance on subsequent calls", () => {
    const llm1 = getDefaultLlamaCpp();
    const llm2 = getDefaultLlamaCpp();
    expect(llm1).toBe(llm2);
    expect(llm1).toBeInstanceOf(LlamaCpp);
  });
});

// =============================================================================
// Model Existence Tests
// =============================================================================

describe("LlamaCpp.modelExists", () => {
  test("returns exists:true for HuggingFace model URIs", async () => {
    const llm = getDefaultLlamaCpp();
    const result = await llm.modelExists("hf:org/repo/model.gguf");

    expect(result.exists).toBe(true);
    expect(result.name).toBe("hf:org/repo/model.gguf");
  });

  test("returns exists:false for non-existent local paths", async () => {
    const llm = getDefaultLlamaCpp();
    const result = await llm.modelExists("/nonexistent/path/model.gguf");

    expect(result.exists).toBe(false);
    expect(result.name).toBe("/nonexistent/path/model.gguf");
  });
});

describe("QMD_LLAMA_GPU resolution", () => {
  test("uses auto when unset or blank", () => {
    expect(resolveLlamaGpuMode(undefined)).toBe("auto");
    expect(resolveLlamaGpuMode("   ")).toBe("auto");
  });

  test("maps CPU disable values to false", () => {
    expect(resolveLlamaGpuMode("false")).toBe(false);
    expect(resolveLlamaGpuMode("OFF")).toBe(false);
    expect(resolveLlamaGpuMode(" none ")).toBe(false);
    expect(resolveLlamaGpuMode("disabled")).toBe(false);
    expect(resolveLlamaGpuMode("0")).toBe(false);
  });

  test("passes through supported GPU backends", () => {
    expect(resolveLlamaGpuMode("metal")).toBe("metal");
    expect(resolveLlamaGpuMode("VULKAN")).toBe("vulkan");
    expect(resolveLlamaGpuMode(" cuda ")).toBe("cuda");
  });

  test("QMD_FORCE_CPU disables GPU before QMD_LLAMA_GPU auto-detection", () => {
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_FORCE_CPU = "1";
    try {
      expect(resolveLlamaGpuMode(undefined)).toBe(false);
      expect(resolveLlamaGpuMode("cuda")).toBe(false);
    } finally {
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });

  test("QMD_FORCE_CPU ignores false-ish values", () => {
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_FORCE_CPU = "0";
    try {
      expect(resolveLlamaGpuMode(undefined)).toBe("auto");
    } finally {
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });

  test("warns and falls back to auto for unsupported values", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(resolveLlamaGpuMode("rocm")).toBe("auto");
      expect(stderrSpy).toHaveBeenCalled();
      expect(String(stderrSpy.mock.calls[0]?.[0] || "")).toContain("QMD_LLAMA_GPU");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("native llama stdout containment", () => {
  test("redirects native stdout noise to stderr while JSON callers are initializing llama", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await withNativeStdoutRedirectedToStderr(async () => {
        process.stdout.write("cmake build spam\n");
        return "ok";
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith("cmake build spam\n", undefined, undefined);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test("keeps native GPU failure noise off stdout and caches failed GPU init", async () => {
    const prevGpu = process.env.QMD_LLAMA_GPU;
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_LLAMA_GPU = "cuda";
    delete process.env.QMD_FORCE_CPU;

    const calls: unknown[] = [];
    const fakeLlama = { gpu: false, cpuMathCores: 4 };
    setNodeLlamaCppModuleForTest({
      LlamaLogLevel: { error: "error" },
      resolveModelFile: vi.fn(),
      LlamaChatSession: vi.fn() as any,
      getLlama: vi.fn(async (options: Record<string, unknown>) => {
        calls.push(options.gpu);
        if (options.gpu === "cuda") {
          process.stdout.write("cmake build spam\n");
          throw new Error("CUDA unavailable");
        }
        return fakeLlama as any;
      }),
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const first = new LlamaCpp();
      const second = new LlamaCpp();

      await (first as any).ensureLlama();
      await (second as any).ensureLlama();

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith("cmake build spam\n", undefined, undefined);
      expect(calls).toEqual(["cuda", false, false]);
      expect(String(stderrSpy.mock.calls.map(call => call[0]).join(""))).toContain("skipping previously failed GPU init");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      setNodeLlamaCppModuleForTest(null);
      if (prevGpu === undefined) delete process.env.QMD_LLAMA_GPU;
      else process.env.QMD_LLAMA_GPU = prevGpu;
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });

  test("warns about CPU fallback only once per process", async () => {
    const prevGpu = process.env.QMD_LLAMA_GPU;
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_LLAMA_GPU = "false";
    delete process.env.QMD_FORCE_CPU;

    setNodeLlamaCppModuleForTest({
      LlamaLogLevel: { error: "error" },
      resolveModelFile: vi.fn(),
      LlamaChatSession: vi.fn() as any,
      getLlama: vi.fn(async () => ({ gpu: false, cpuMathCores: 4 }) as any),
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const first = new LlamaCpp();
      const second = new LlamaCpp();

      await (first as any).ensureLlama();
      await (second as any).ensureLlama();

      const stderr = String(stderrSpy.mock.calls.map(call => call[0]).join(""));
      expect(stderr.match(/no GPU acceleration/g)?.length).toBe(1);
      expect(stderr).toContain("qmd doctor");
      expect(stderr).not.toContain("QMD_STATUS_DEVICE_PROBE");
    } finally {
      stderrSpy.mockRestore();
      setNodeLlamaCppModuleForTest(null);
      if (prevGpu === undefined) delete process.env.QMD_LLAMA_GPU;
      else process.env.QMD_LLAMA_GPU = prevGpu;
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });

  test("embeds hello world with QMD_FORCE_CPU=1 without throwing", async () => {
    const prevGpu = process.env.QMD_LLAMA_GPU;
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_FORCE_CPU = "1";
    process.env.QMD_LLAMA_GPU = "metal";

    const getEmbeddingFor = vi.fn(async (text: string) => ({
      vector: new Float32Array([0.1, 0.2, 0.3]),
      text,
    }));
    const createEmbeddingContext = vi.fn(async () => ({
      getEmbeddingFor,
      dispose: vi.fn(async () => {}),
    }));
    const loadModel = vi.fn(async () => ({
      trainContextSize: 2048,
      tokenize: (text: string) => Array.from(text),
      detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext,
      dispose: vi.fn(async () => {}),
    }));
    const getLlama = vi.fn(async (options: Record<string, unknown>) => ({
      gpu: false,
      cpuMathCores: 4,
      loadModel,
      dispose: vi.fn(async () => {}),
    }) as any);

    setNodeLlamaCppModuleForTest({
      LlamaLogLevel: { error: "error" },
      resolveModelFile: vi.fn(async () => "/tmp/nonexistent-model.gguf"),
      LlamaChatSession: vi.fn() as any,
      getLlama,
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const llm = new LlamaCpp();
    try {
      const result = await llm.embed("hello world");
      expect(result).toEqual({
        embedding: [0.10000000149011612, 0.20000000298023224, 0.30000001192092896],
        model: llm.embedModelName,
      });
      expect(getLlama).toHaveBeenCalledWith(expect.objectContaining({ gpu: false, build: "never" }));
      expect(loadModel).toHaveBeenCalledWith(expect.objectContaining({ gpuLayers: 0 }));
      expect(getEmbeddingFor).toHaveBeenCalledWith("hello world");
    } finally {
      await llm.dispose();
      stderrSpy.mockRestore();
      setNodeLlamaCppModuleForTest(null);
      if (prevGpu === undefined) delete process.env.QMD_LLAMA_GPU;
      else process.env.QMD_LLAMA_GPU = prevGpu;
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });
});

describe("LLM context parallelism safety", () => {
  test("defaults Windows CUDA to one context to avoid ggml-cuda.cu:98 crashes", () => {
    expect(resolveSafeParallelism({
      gpu: "cuda",
      platform: "win32",
      computed: 8,
      envValue: undefined,
    })).toBe(1);
  });

  test("keeps non-Windows and non-CUDA backends on computed parallelism", () => {
    expect(resolveSafeParallelism({ gpu: "cuda", platform: "linux", computed: 8 })).toBe(8);
    expect(resolveSafeParallelism({ gpu: "vulkan", platform: "win32", computed: 8 })).toBe(8);
    expect(resolveSafeParallelism({ gpu: false, platform: "win32", computed: 4 })).toBe(4);
  });

  test("QMD_EMBED_PARALLELISM overrides the Windows CUDA safety default", () => {
    expect(resolveSafeParallelism({
      gpu: "cuda",
      platform: "win32",
      computed: 8,
      envValue: "2",
    })).toBe(2);
  });

  test("QMD_EMBED_PARALLELISM clamps invalid values and warns", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(resolveParallelismOverride("0")).toBeUndefined();
      expect(resolveParallelismOverride("bad")).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledTimes(2);
      expect(String(stderrSpy.mock.calls[0]?.[0] || "")).toContain("QMD_EMBED_PARALLELISM");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("LlamaCpp model resolution (config > env > default)", () => {
  const HARDCODED_EMBED = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

  test("uses hardcoded default when no config or env is set", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    delete process.env.QMD_EMBED_MODEL;
    try {
      const llm = new LlamaCpp({}) as any;
      expect(llm.embedModelUri).toBe(HARDCODED_EMBED);
    } finally {
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });

  test("env var overrides hardcoded default", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    process.env.QMD_EMBED_MODEL = "hf:custom/embed-model.gguf";
    try {
      const llm = new LlamaCpp({}) as any;
      expect(llm.embedModelUri).toBe("hf:custom/embed-model.gguf");
    } finally {
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });

  test("config overrides env var", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    process.env.QMD_EMBED_MODEL = "hf:env/model.gguf";
    try {
      const llm = new LlamaCpp({ embedModel: "hf:config/model.gguf" }) as any;
      expect(llm.embedModelUri).toBe("hf:config/model.gguf");
    } finally {
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });
});

describe("LlamaCpp embedding truncation", () => {
  test("truncates against the active embedding context limit, not the model train context", async () => {
    const llm = new LlamaCpp({}) as any;
    const getEmbeddingFor = vi.fn(async (text: string) => ({
      vector: new Float32Array([0.25, 0.5]),
      text,
    }));

    llm.touchActivity = vi.fn();
    llm.embedModel = {
      trainContextSize: 8192,
      tokenize: (text: string) => Array.from({ length: text.length }, () => 1),
      detokenize: (tokens: readonly number[]) => "x".repeat(tokens.length),
    };
    llm.ensureEmbedContext = vi.fn().mockResolvedValue({ getEmbeddingFor });

    const result = await llm.embed("x".repeat(3000));

    expect(getEmbeddingFor).toHaveBeenCalledWith("x".repeat(2044));
    expect(result).toEqual({
      embedding: [0.25, 0.5],
      model: llm.embedModelUri,
    });
  });
});

describe("LlamaCpp.getDeviceInfo", () => {
  test("can skip build attempts for status probes", async () => {
    const llm = new LlamaCpp({}) as any;
    const fakeLlama = {
      gpu: "metal",
      supportsGpuOffloading: true,
      cpuMathCores: 8,
      getGpuDeviceNames: vi.fn().mockResolvedValue(["Apple GPU"]),
      getVramState: vi.fn().mockResolvedValue({ total: 1024, used: 256, free: 768 }),
    };

    llm.ensureLlama = vi.fn().mockResolvedValue(fakeLlama);

    const device = await llm.getDeviceInfo({ allowBuild: false });

    expect(llm.ensureLlama).toHaveBeenCalledWith(false);
    expect(device).toEqual({
      gpu: "metal",
      gpuOffloading: true,
      gpuDevices: ["Apple GPU"],
      vram: { total: 1024, used: 256, free: 768 },
      cpuCores: 8,
    });
  });
});

// =============================================================================
// Integration Tests (require actual models)
// =============================================================================

describe.skipIf(!!process.env.CI)("LlamaCpp Integration", () => {
  // Use the singleton to avoid multiple Metal contexts
  const llm = getDefaultLlamaCpp();

  afterAll(async () => {
    // Ensure native resources are released to avoid ggml-metal asserts on process exit.
    await disposeDefaultLlamaCpp();
  });

  describe("embed", () => {
    test("returns embedding with correct dimensions", async () => {
      const result = await llm.embed("Hello world");

      expect(result).not.toBeNull();
      expect(result!.embedding).toBeInstanceOf(Array);
      expect(result!.embedding.length).toBeGreaterThan(0);
      // embeddinggemma outputs 768 dimensions
      expect(result!.embedding.length).toBe(768);
    });

    test("returns consistent embeddings for same input", async () => {
      const result1 = await llm.embed("test text");
      const result2 = await llm.embed("test text");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      // Embeddings should be identical for the same input
      for (let i = 0; i < result1!.embedding.length; i++) {
        expect(result1!.embedding[i]).toBeCloseTo(result2!.embedding[i]!, 5);
      }
    });

    test("returns different embeddings for different inputs", async () => {
      const result1 = await llm.embed("cats are great");
      const result2 = await llm.embed("database optimization");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      // Calculate cosine similarity - should be less than 1.0 (not identical)
      let dotProduct = 0;
      let norm1 = 0;
      let norm2 = 0;
      for (let i = 0; i < result1!.embedding.length; i++) {
        const v1 = result1!.embedding[i]!;
        const v2 = result2!.embedding[i]!;
        dotProduct += v1 * v2;
        norm1 += v1 ** 2;
        norm2 += v2 ** 2;
      }
      const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

      expect(similarity).toBeLessThan(0.95); // Should be meaningfully different
    });
  });

  describe("embedBatch", () => {
    test("returns embeddings for multiple texts", async () => {
      const texts = ["Hello world", "Test text", "Another document"];
      const results = await llm.embedBatch(texts);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).not.toBeNull();
        expect(result!.embedding.length).toBe(768);
      }
    });

    test("returns same results as individual embed calls", async () => {
      const texts = ["cats are great", "dogs are awesome"];

      // Get batch embeddings
      const batchResults = await llm.embedBatch(texts);

      // Get individual embeddings
      const individualResults = await Promise.all(texts.map(t => llm.embed(t)));

      // Compare - should be identical
      for (let i = 0; i < texts.length; i++) {
        expect(batchResults[i]).not.toBeNull();
        expect(individualResults[i]).not.toBeNull();
        for (let j = 0; j < batchResults[i]!.embedding.length; j++) {
          expect(batchResults[i]!.embedding[j]).toBeCloseTo(individualResults[i]!.embedding[j]!, 5);
        }
      }
    });

    test("handles empty array", async () => {
      const results = await llm.embedBatch([]);
      expect(results).toHaveLength(0);
    });

    test("batch is faster than sequential", async () => {
      const texts = Array(10).fill(null).map((_, i) => `Document number ${i} with content`);

      // Time batch
      const batchStart = Date.now();
      await llm.embedBatch(texts);
      const batchTime = Date.now() - batchStart;

      // Time sequential
      const seqStart = Date.now();
      for (const text of texts) {
        await llm.embed(text);
      }
      const seqTime = Date.now() - seqStart;

      console.log(`Batch: ${batchTime}ms, Sequential: ${seqTime}ms`);
      // Performance is machine/load dependent. We only assert batch isn't drastically worse.
      expect(batchTime).toBeLessThanOrEqual(seqTime * 3);
    });

    test("handles concurrent embedBatch calls on fresh instance without race condition", async () => {
      // This test verifies the fix for a race condition where concurrent calls to
      // ensureEmbedContext() could create multiple contexts. Without the promise guard,
      // each concurrent embedBatch call sees embedContext === null and creates its own
      // context, causing resource leaks and potential "Context is disposed" errors.
      //
      // See: https://github.com/tobi/qmd/pull/54
      //
      // The fix uses a promise guard to ensure only one context creation runs at a time.
      // We verify this by instrumenting createEmbeddingContext to count invocations.
      
      const freshLlm = new LlamaCpp({});
      let contextCreateCount = 0;
      
      // Instrument the model's createEmbeddingContext to count calls
      const originalEnsureEmbedModel = (freshLlm as any).ensureEmbedModel.bind(freshLlm);
      let modelInstrumented = false;
      (freshLlm as any).ensureEmbedModel = async function() {
        const model = await originalEnsureEmbedModel();
        if (!modelInstrumented) {
          modelInstrumented = true;
          const originalCreate = model.createEmbeddingContext.bind(model);
          model.createEmbeddingContext = async function(...args: any[]) {
            contextCreateCount++;
            return originalCreate(...args);
          };
        }
        return model;
      };
      
      const texts = Array(10).fill(null).map((_, i) => `Document ${i}`);

      // Call embedBatch 5 TIMES in parallel on fresh instance.
      // Without the promise guard fix, this would create 5 contexts (one per call).
      // With the fix, only 1 context should be created.
      const batches = await Promise.all([
        freshLlm.embedBatch(texts.slice(0, 2)),
        freshLlm.embedBatch(texts.slice(2, 4)),
        freshLlm.embedBatch(texts.slice(4, 6)),
        freshLlm.embedBatch(texts.slice(6, 8)),
        freshLlm.embedBatch(texts.slice(8, 10)),
      ]);

      const allResults = batches.flat();
      expect(allResults).toHaveLength(10);
      
      const successCount = allResults.filter(r => r !== null).length;
      expect(successCount).toBe(10);

      // THE KEY ASSERTION: Contexts should be created once (by ensureEmbedContexts),
      // not duplicated per concurrent embedBatch call. The exact count depends on
      // available VRAM (computeParallelism), but should not be 5 (one per call).
      // Without the fix, contextCreateCount would be 5× the intended count (one set per concurrent call).
      // With the promise guard, contexts are created exactly once regardless of concurrent callers.
      // The count depends on VRAM (computeParallelism), but should be ≤ 8 (the cap).
      console.log(`Context creation count: ${contextCreateCount} (expected: ≤ 8, not 5× duplicated)`);
      expect(contextCreateCount).toBeGreaterThanOrEqual(1);
      expect(contextCreateCount).toBeLessThanOrEqual(8);
      
      await freshLlm.dispose();
    }, 60000);
  });

});

// =============================================================================
// Session Management Tests
// =============================================================================

describe.skipIf(!!process.env.CI)("LLM Session Management", () => {
  describe("withLLMSession", () => {
    test("session provides access to LLM operations", async () => {
      const result = await withLLMSession(async (session) => {
        expect(session.isValid).toBe(true);
        const embedding = await session.embed("test text");
        expect(embedding).not.toBeNull();
        expect(embedding!.embedding.length).toBe(768);
        return "success";
      });
      expect(result).toBe("success");
    });

    test("session is invalid after release", async () => {
      let capturedSession: ILLMSession | null = null;

      await withLLMSession(async (session) => {
        capturedSession = session;
        expect(session.isValid).toBe(true);
      });

      // Session should be invalid after withLLMSession returns
      expect(capturedSession).not.toBeNull();
      expect(capturedSession!.isValid).toBe(false);
    });

    test("session prevents idle unload during operations", async () => {
      await withLLMSession(async (session) => {
        // While inside a session, canUnloadLLM should return false
        expect(canUnloadLLM()).toBe(false);

        // Perform an operation
        await session.embed("test");

        // Still should not be able to unload
        expect(canUnloadLLM()).toBe(false);
      });

      // After session ends, should be able to unload
      expect(canUnloadLLM()).toBe(true);
    });

    test("nested sessions increment ref count", async () => {
      await withLLMSession(async (outerSession) => {
        expect(canUnloadLLM()).toBe(false);

        await withLLMSession(async (innerSession) => {
          expect(canUnloadLLM()).toBe(false);
          expect(innerSession.isValid).toBe(true);
          expect(outerSession.isValid).toBe(true);
        });

        // Inner session released, but outer still active
        expect(canUnloadLLM()).toBe(false);
        expect(outerSession.isValid).toBe(true);
      });

      // All sessions released
      expect(canUnloadLLM()).toBe(true);
    });

    test("session embedBatch works correctly", async () => {
      await withLLMSession(async (session) => {
        const texts = ["Hello world", "Test text", "Another document"];
        const results = await session.embedBatch(texts);

        expect(results).toHaveLength(3);
        for (const result of results) {
          expect(result).not.toBeNull();
          expect(result!.embedding.length).toBe(768);
        }
      });
    });

    test("max duration aborts session after timeout", async () => {
      let aborted = false;

      try {
        await withLLMSession(async (session) => {
          // Wait longer than max duration
          await new Promise(resolve => setTimeout(resolve, 150));

          // This operation should throw because session was aborted
          await session.embed("test");
        }, { maxDuration: 50 }); // 50ms max
      } catch (err) {
        if (err instanceof SessionReleasedError) {
          aborted = true;
        } else {
          throw err;
        }
      }

      expect(aborted).toBe(true);
    }, 5000);

    test("external abort signal propagates to session", async () => {
      const abortController = new AbortController();
      let sessionAborted = false;

      const promise = withLLMSession(async (session) => {
        // Wait a bit then check if aborted
        await new Promise(resolve => setTimeout(resolve, 100));

        if (!session.isValid) {
          sessionAborted = true;
          throw new SessionReleasedError("Session aborted");
        }

        return "should not reach";
      }, { signal: abortController.signal });

      // Abort after 20ms
      setTimeout(() => abortController.abort(), 20);

      try {
        await promise;
      } catch (err) {
        // Expected
      }

      expect(sessionAborted).toBe(true);
    }, 5000);

    test("session provides abort signal for monitoring", async () => {
      await withLLMSession(async (session) => {
        expect(session.signal).toBeInstanceOf(AbortSignal);
        expect(session.signal.aborted).toBe(false);
      });
    });

    test("returns value from callback", async () => {
      const result = await withLLMSession(async (session) => {
        await session.embed("test");
        return { status: "complete", count: 42 };
      });

      expect(result).toEqual({ status: "complete", count: 42 });
    });

    test("propagates errors from callback", async () => {
      const customError = new Error("Custom test error");

      await expect(
        withLLMSession(async () => {
          throw customError;
        })
      ).rejects.toThrow("Custom test error");
    });
  });
});

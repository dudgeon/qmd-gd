import { describe, expect, test } from "vitest";
import { readFileSync, existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_EMBED_MODEL_URI, resolveBundledModelPath } from "../src/llm";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

describe("package test task", () => {
  test("runs typecheck and unit tests under Node", () => {
    expect(pkg.scripts.test).toContain("scripts/test-all.mjs");

    expect(pkg.scripts["test:types"]).toContain("tsconfig.build.json --noEmit");
    expect(pkg.scripts["test:unit"]).toContain("vitest.mjs");
    expect(pkg.scripts["test:unit"]).toContain("CI=true");

    const testAllScript = readFileSync(new URL("scripts/test-all.mjs", root), "utf8");
    expect(testAllScript).toContain("TypeScript build typecheck");
    expect(testAllScript).toContain("Vitest suite under Node");
  });

  test("is Node-only: no Bun or tree-sitter machinery", () => {
    // qmd-gd dropped the Bun runtime and AST/tree-sitter chunking.
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const dep of Object.keys(allDeps)) {
      expect(dep, `${dep} must not be a tree-sitter package`).not.toMatch(/tree-sitter/);
    }

    const scriptNames = Object.keys(pkg.scripts ?? {});
    expect(scriptNames).not.toContain("test:bun");
    expect(scriptNames).not.toContain("test:package");
    expect(scriptNames).not.toContain("smoke:package-grammars");
  });

  test("SQLite engine is Node's built-in node:sqlite (no native better-sqlite3)", () => {
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    };
    expect(allDeps["better-sqlite3"], "better-sqlite3 must not be a dependency").toBeUndefined();
    expect(allDeps["@types/better-sqlite3"]).toBeUndefined();
    expect(pkg.pnpm?.onlyBuiltDependencies ?? []).not.toContain("better-sqlite3");
    // Node floor must be >= 22.13 for the built-in node:sqlite engine.
    expect(pkg.engines?.node).toMatch(/>=\s*22\.13/);

    const db = readFileSync(new URL("src/db.ts", root), "utf8");
    expect(db, "db.ts must use the built-in node:sqlite").toContain('import("node:sqlite")');
    expect(db, "db.ts must not import better-sqlite3").not.toMatch(/from ["']better-sqlite3["']|import\(["']better-sqlite3["']\)/);
  });
});

describe("published package files", () => {
  test("ships bin, dist, skills, and the build/test scripts", () => {
    for (const entry of ["bin/", "dist/", "models/", ".claude/skills/", ".claude/agents/", "scripts/build.mjs", "scripts/test-all.mjs", "scripts/install.sh"]) {
      expect(pkg.files, `published package files should include ${entry}`).toContain(entry);
    }
    // Grammar/smoke helpers were removed with the AST/Bun teardown.
    expect(pkg.files).not.toContain("scripts/check-package-grammars.mjs");
    expect(pkg.files).not.toContain("scripts/package-smoke.mjs");
  });

  test("vendors the default embedding model as a valid GGUF", () => {
    // The offline-install guarantee depends on this file actually shipping.
    expect(DEFAULT_EMBED_MODEL_URI).toBe("bundled:bge-small-en-v1.5-Q8_0.gguf");
    const modelPath = resolveBundledModelPath(DEFAULT_EMBED_MODEL_URI);
    expect(modelPath).toBeTruthy();
    expect(existsSync(modelPath!), `vendored model missing at ${modelPath}`).toBe(true);
    // First 4 bytes must be the GGUF magic — guards against a corrupt file or an
    // un-smudged Git-LFS pointer landing in the package.
    const fd = openSync(modelPath!, "r");
    try {
      const buf = Buffer.alloc(4);
      readSync(fd, buf, 0, 4, 0);
      expect(buf.toString("latin1")).toBe("GGUF");
    } finally {
      closeSync(fd);
    }
  });

  test("install.sh + preflight are valid bash, executable, and carry the proxy/TLS guards", () => {
    for (const rel of [
      "scripts/install.sh",
      ".claude/skills/qmd-setup/scripts/preflight-deps.sh",
      ".claude/skills/qmd-setup/scripts/qmd-setup-context.sh",
    ]) {
      const path = fileURLToPath(new URL(rel, root));
      // `bash -n` parses without executing — throws on a syntax error.
      expect(() => execFileSync("bash", ["-n", path]), `${rel} should parse`).not.toThrow();
      expect(statSync(path).mode & 0o111, `${rel} should be executable`).not.toBe(0);
    }

    // The step-0 probe must be git-free (works from an unzipped download, not just a clone)
    // and vendor-aware (no stale embeddinggemma/HF-download language).
    const probe = readFileSync(new URL(".claude/skills/qmd-setup/scripts/qmd-setup-context.sh", root), "utf8");
    expect(probe).not.toContain("rev-parse");            // no git dependency for locating the folder
    expect(probe).not.toContain("embeddinggemma");        // default model is now vendored bge
    expect(probe).toContain("models/bge-small-en-v1.5-Q8_0.gguf");

    const install = readFileSync(new URL("scripts/install.sh", root), "utf8");
    expect(install).toContain("NODE_EXTRA_CA_CERTS");
    expect(install).toContain("QMD_CA_BUNDLE");
    expect(install).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0"); // scoped insecure fallback
    expect(install).toContain("qmd skill install --global --yes");

    const preflight = readFileSync(new URL(".claude/skills/qmd-setup/scripts/preflight-deps.sh", root), "utf8");
    expect(preflight).toContain("node_tls_probe");               // Node trust-store probe, not just curl
    expect(preflight).toContain("objects.githubusercontent.com"); // release CDN, not just github.com
    expect(preflight).toContain("UNABLE_TO_GET_ISSUER_CERT");
  });

  test("publishes the qmd skill with the expected structure", () => {
    const qmdSkill = readFileSync(new URL(".claude/skills/qmd/SKILL.md", root), "utf8");
    expect(qmdSkill).toContain("# QMD - Query Markdown Documents");
    expect(qmdSkill).toContain("## How search works");
    expect(qmdSkill).toContain("## Rank the candidates yourself");
    expect(qmdSkill).not.toContain("## MCP Tool");
    expect(qmdSkill).not.toContain("This file is a discovery stub");

    const firstSixtyLines = qmdSkill.split(/\r?\n/).slice(0, 60).join("\n");
    expect(firstSixtyLines).toContain("author a structured query");
    expect(firstSixtyLines).toContain("qmd search");
    expect(firstSixtyLines).toContain('qmd multi-get "#abc123,#def432"');
    expect(firstSixtyLines).toContain("Retrieved:");
    expect(firstSixtyLines).toContain("qmd query");
    // The skill must teach structured, self-authored queries near the top.
    expect(firstSixtyLines).toContain("Default to structured");
  });
});

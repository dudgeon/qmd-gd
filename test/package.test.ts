import { describe, expect, test } from "vitest";
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
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

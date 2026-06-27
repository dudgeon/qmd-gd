#!/usr/bin/env node
// scope-playground.mjs — render the qmd index & search-scope dashboard (a Duo HTML
// canvas) from live qmd state, and print the file path. Re-run after a scope/index change.
//
// Local + read-only: it shells `qmd status --json` and writes ONE HTML file under
// ~/.claude/duo/ (Duo's playground trust root — required for the buttons to fire). No network.
//
// Usage:  node scope-playground.mjs [--out <path>]   (QMD_BIN overrides the qmd binary, for tests)

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url); // .../.claude/skills/qmd-setup/scripts/scope-playground.mjs
const CHECKOUT = resolve(dirname(SELF), "..", "..", "..", ".."); // repo root (up 4 from scripts/)

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT = resolve(arg("--out", resolve(homedir(), ".claude", "duo", "qmd", "scope.html")));
const QMD = process.env.QMD_BIN || "qmd";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}
function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function relTime(iso) {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = s / 60; if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)} hr ago`;
  const d = h / 24; if (d < 30) { const n = Math.round(d); return `${n} day${n === 1 ? "" : "s"} ago`; }
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function absTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function shortModel(uri) {
  if (!uri) return "unknown";
  const base = String(uri).split("/").pop() || String(uri);
  return base.replace(/\.gguf$/i, "");
}
function num(n) { return Number(n || 0).toLocaleString(); }

function loadStatus() {
  const raw = execFileSync(QMD, ["status", "--json"], { encoding: "utf8" });
  return JSON.parse(raw.trim() || "{}");
}

// The natural-language prompt the "Change scope" button hands to a NEW Claude tab.
function changeScopePrompt(inScope, outScope) {
  const names = (l) => (l.length ? l.map((c) => c.name).join(", ") : "(none)");
  return [
    "I want to change which collections `/ask-qmd` searches by default (its scope).",
    `Currently IN scope (default-included): ${names(inScope)}.`,
    `Currently OUT of scope (excluded): ${names(outScope)}.`,
    "Ask me which collections to add to or remove from the default scope, then run the",
    "matching `qmd collection include <name>` / `qmd collection exclude <name>` commands.",
    `Then refresh this dashboard: run \`node ${SELF}\` (it rewrites the file), then`,
    "`duo open --reveal` that file AND `duo reload` — opening an already-open tab only re-focuses it;",
    "reload re-renders it. Tell me when it's updated.",
  ].join(" ");
}

const s = loadStatus();
const cols = Array.isArray(s.collections) ? s.collections : [];
const inScope = cols.filter((c) => c.includeByDefault);
const outScope = cols.filter((c) => !c.includeByDefault);
const docs = s.totalDocuments || 0;
const vecs = s.vectorsEmbedded || 0;
const pending = s.needsEmbedding || 0;
const indexed = docs > 0;
const lastIdx = relTime(s.lastIndexedAt);
const lastEmb = relTime(s.lastEmbeddedAt);

const stat = (label, value, sub, tone = "") =>
  `<div class="stat ${tone}"><div class="stat-label">${esc(label)}</div>` +
  `<div class="stat-value">${esc(value)}</div>` +
  `<div class="stat-sub">${esc(sub || "")}</div></div>`;

const embedCell = pending > 0
  ? stat("Embedding", `${num(pending)} pending`, "run qmd embed", "warn")
  : stat("Embedding", indexed ? "up to date" : "—", indexed ? "all docs embedded" : "nothing indexed yet", indexed ? "pass" : "mute");

const statGrid = [
  stat("Documents", num(docs), "indexed files", indexed ? "" : "mute"),
  stat("Vectors", num(vecs), "embedded chunks"),
  embedCell,
  stat("Last indexed", lastIdx || "never", absTime(s.lastIndexedAt) || "run qmd update", indexed ? "" : "mute"),
  stat("Last embedded", lastEmb || "never", absTime(s.lastEmbeddedAt) || "", vecs ? "" : "mute"),
  stat("Index size", fmtBytes(s.sizeBytes), "on disk"),
].join("\n      ");

const scopeRows = (list, inside) =>
  list.length === 0
    ? `<div class="row muted">${inside ? "Nothing in the default scope yet." : "Nothing excluded."}</div>`
    : list
        .map((c) => `<div class="row"><span class="name">${esc(c.name)}</span><span class="count">${num(c.documents)} docs</span></div>`)
        .join("\n        ");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="duo-default-editable" content="false">
<title>qmd · search index</title>
<style>
/* ── Atelier kernel (tokens + base + page-head/intro), aligned with Duo's app shell ── */
:root {
  --paper:#fbf8f1; --paper-deep:#f3ede0; --paper-edge:#e8e0cb; --paper-rule:#d9cea8;
  --ink:#2b2620; --ink-soft:#4a4238; --ink-mute:#6f6557; --ink-ghost:#9a9080;
  --accent:#c46a1c; --accent-soft:#f4d9b6; --pass:#4a7d3e; --fail:#b13e3a; --warn:#b07527;
  --code-bg:#2b2823; --code-ink:#e8e0cb;
}
* { box-sizing:border-box; }
html, body { margin:0; padding:0; background:var(--paper); color:var(--ink);
  font-family:-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif; font-size:14px; line-height:1.55; }
body { padding:32px 40px 64px; max-width:820px; margin:0 auto; }
header.page-head { border-bottom:1px solid var(--paper-rule); padding-bottom:16px; margin-bottom:22px; }
header.page-head h1 { font-family:"New York","Iowan Old Style",Georgia,serif; font-style:italic; font-weight:500; margin:0 0 6px; font-size:24px; }
header.page-head .meta { color:var(--ink-mute); font-size:13px; }
header.page-head .meta .pill { display:inline-block; padding:2px 8px; border-radius:10px; background:var(--accent-soft);
  color:var(--accent); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-right:6px; }
.intro { background:var(--paper-deep); border:1px solid var(--paper-rule); border-radius:6px; padding:14px 18px;
  margin-bottom:26px; font-size:13.5px; color:var(--ink-soft); }
.intro strong { color:var(--ink); font-weight:600; }
h2 { font-family:"New York","Iowan Old Style",Georgia,serif; font-weight:600; margin:34px 0 14px; font-size:19px;
  border-bottom:1px solid var(--paper-rule); padding-bottom:6px; }
p { margin:8px 0; }
code { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:12.5px; background:var(--paper-deep); padding:1px 5px; border-radius:3px; }

/* ── dashboard-specific (after the kernel) ── */
.stat-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
.stat { background:var(--paper-deep); border:1px solid var(--paper-rule); border-radius:6px; padding:12px 14px; }
.stat-label { font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-mute); font-weight:600; }
.stat-value { font-size:20px; font-weight:600; margin:3px 0 1px; }
.stat-sub { font-size:11.5px; color:var(--ink-ghost); }
.stat.warn .stat-value { color:var(--warn); } .stat.pass .stat-value { color:var(--pass); } .stat.mute .stat-value { color:var(--ink-ghost); }
.model-line { font-size:12.5px; color:var(--ink-mute); margin-top:12px; }

.scope-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.scope-card { border:1px solid var(--paper-rule); border-radius:6px; padding:12px 14px; background:var(--paper-deep); }
.scope-card h3 { margin:0 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-mute); display:flex; align-items:center; gap:7px; }
.chip { font-size:10px; padding:1px 7px; border-radius:999px; font-weight:700; letter-spacing:.03em; }
.chip.in { background:color-mix(in srgb, var(--pass) 14%, var(--paper)); color:var(--pass); }
.chip.out { background:var(--paper-edge); color:var(--ink-mute); }
.row { display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid var(--paper-rule); }
.row:last-child { border-bottom:0; }
.row .name { font-weight:500; } .row .count { color:var(--ink-mute); font-size:12.5px; white-space:nowrap; }
.row.muted { color:var(--ink-ghost); border-bottom:0; }

.flow { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:6px 0 4px; }
.flow .step { border:1px solid var(--paper-rule); border-radius:6px; padding:12px 14px; }
.flow .step .n { font-family:"New York",Georgia,serif; font-style:italic; color:var(--accent); font-size:15px; }
.flow .step b { display:block; margin:2px 0 4px; }
.flow .step span { font-size:12.5px; color:var(--ink-soft); }
.note { font-size:12.5px; color:var(--ink-mute); margin-top:12px; }

.actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:30px; padding-top:18px; border-top:1px solid var(--paper-rule); }
button { font:inherit; cursor:pointer; border-radius:6px; padding:9px 16px; border:1.5px solid var(--paper-rule); background:var(--paper); color:var(--ink); font-weight:600; }
button:hover { border-color:var(--ink-ghost); }
button.cta { background:var(--accent); color:#fff; border-color:var(--accent); }
button.cta:hover { background:color-mix(in srgb, black 8%, var(--accent)); }
.actions .hint { flex-basis:100%; font-size:12px; color:var(--ink-ghost); margin-top:2px; }
</style>
</head>
<body>
<header class="page-head">
  <h1>qmd · search index</h1>
  <div class="meta">
    <span class="pill">retrieval-only</span><span class="pill">on-device</span><span class="pill">no MCP</span>
    <span>index at <code>${esc((s.indexPath || "~/.cache/qmd/index.sqlite").replace(homedir(), "~"))}</code></span>
  </div>
</header>

<div class="intro">
  <strong>This is your qmd knowledge index.</strong> When you run <code>/ask-qmd "&hellip;"</code> it searches the
  collections <em>in scope</em> below; an agent then reads the top sources and answers with citations. qmd runs one
  local embedding model and <strong>never sends your notes anywhere</strong>.
</div>

<h2>Index status</h2>
<div class="stat-grid">
      ${statGrid}
</div>
<p class="model-line">Embedding model: <code>${esc(shortModel(s.embedModel))}</code> &middot; local (node-llama-cpp). Keyword search needs no model.</p>

<h2>Search scope</h2>
<div class="scope-grid">
  <div class="scope-card">
    <h3>In scope <span class="chip in">default</span></h3>
    ${scopeRows(inScope, true)}
  </div>
  <div class="scope-card">
    <h3>Out of scope <span class="chip out">excluded</span></h3>
    ${scopeRows(outScope, false)}
  </div>
</div>
<p class="note">Out-of-scope collections stay indexed and searchable — just not by default. Reach them with <code>-c &lt;name&gt;</code>.</p>

<h2>How qmd works</h2>
<div class="flow">
  <div class="step"><span class="n">1</span><b>Find</b><span>Two searches at once: <em>BM25</em> keyword match (exact words) and on-device <em>vector</em> search (meaning).</span></div>
  <div class="step"><span class="n">2</span><b>Fuse</b><span>The two ranked lists merge via <em>Reciprocal Rank Fusion (RRF)</em> into one candidate set.</span></div>
  <div class="step"><span class="n">3</span><b>Answer</b><span>The agent (e.g. <code>/ask-qmd</code>) reads the top sources and writes the answer with citations.</span></div>
</div>
<p class="note">No cloud and no local generative model — query expansion and re-ranking are done by the calling agent, not on your machine. There is no MCP server; the CLI is the interface.</p>

<div class="actions">
  <button class="cta"
          data-duo-action="claude:spawn"
          data-cwd="${esc(CHECKOUT)}"
          data-cmd="${esc(changeScopePrompt(inScope, outScope))}">
    Change scope&hellip;
  </button>
  <button data-duo-action="terminal:send"
          data-text="qmd update && qmd embed"
          data-enter="false"
          title="Types the refresh command into your terminal — review it, then press Enter.">
    Refresh index
  </button>
  <div class="hint">&ldquo;Change scope&rdquo; opens a new Claude tab. &ldquo;Refresh index&rdquo; types <code>qmd update &amp;&amp; qmd embed</code> into your terminal for you to run (a scheduled job can also keep it current).</div>
</div>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, "utf8");
console.log(OUT);

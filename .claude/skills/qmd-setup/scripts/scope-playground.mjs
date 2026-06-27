#!/usr/bin/env node
// scope-playground.mjs — render the /ask-qmd "search scope" playground (a Duo HTML
// canvas) from live qmd state, and print the file path. Re-run after a scope change.
//
// Local + read-only: it shells `qmd collection list --json` and writes ONE HTML file.
// No network. The file is written under ~/.claude/duo/ on purpose — Duo only lets a
// playground's buttons fire when the HTML lives under that trust root.
//
// Usage:  node scope-playground.mjs [--out <path>]
//   default out: ~/.claude/duo/qmd/scope.html
//   QMD_BIN env overrides the `qmd` binary (used in tests).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url); // .../.claude/skills/qmd-setup/scripts/scope-playground.mjs
const CHECKOUT = resolve(dirname(SELF), "..", "..", "..", ".."); // repo root (up 4 from scripts/)

function argv(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = resolve(argv("--out", resolve(homedir(), ".claude", "duo", "qmd", "scope.html")));
const QMD = process.env.QMD_BIN || "qmd";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

function loadCollections() {
  const raw = execFileSync(QMD, ["collection", "list", "--json"], { encoding: "utf8" });
  const data = JSON.parse(raw.trim() || "[]");
  return Array.isArray(data) ? data : [];
}

// The natural-language prompt the "Change scope" button hands to a NEW Claude tab.
function changeScopePrompt(inScope, outScope) {
  const names = (list) => (list.length ? list.map((c) => c.name).join(", ") : "(none)");
  return [
    "I want to change which collections `/ask-qmd` searches by default (its scope).",
    `Currently IN scope (default-included): ${names(inScope)}.`,
    `Currently OUT of scope (excluded): ${names(outScope)}.`,
    "Ask me which collections to add to or remove from the default scope, then run the",
    "matching `qmd collection include <name>` / `qmd collection exclude <name>` commands.",
    `Then refresh this view: run \`node ${SELF}\` (it rewrites the playground file), then`,
    "`duo open --reveal` that file AND `duo reload` — opening an already-open tab only re-focuses it;",
    "reload re-renders it. Tell me when it's updated.",
  ].join(" ");
}

const collections = loadCollections();
const inScope = collections.filter((c) => c.includeByDefault);
const outScope = collections.filter((c) => !c.includeByDefault);

const rows = (list, inside) =>
  list.length === 0
    ? `<tr><td colspan="2" class="muted">${inside ? "Nothing in the default scope yet." : "Nothing excluded."}</td></tr>`
    : list
        .map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${esc(c.docCount)} docs</td></tr>`)
        .join("\n        ");

const scopeText =
  "In scope: " + (inScope.map((c) => c.name).join(", ") || "(none)") +
  "\nOut of scope: " + (outScope.map((c) => c.name).join(", ") || "(none)");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="duo-default-editable" content="false">
<title>qmd — /ask-qmd search scope</title>
<style>
:root { --paper:#fbfaf7; --ink:#1d1c1a; --muted:#6b6760; --line:#e6e2da; --accent:#3b6ea5; --accent-ink:#fff; --good:#2f7d4f; }
* { box-sizing: border-box; }
body { margin:0; padding:28px; background:var(--paper); color:var(--ink); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width:640px; margin:0 auto; }
h1 { font-size:20px; margin:0 0 4px; }
.sub { color:var(--muted); margin:0 0 20px; }
.card { border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:0 0 16px; background:rgba(255,255,255,.5); }
.card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 10px; display:flex; gap:8px; align-items:center; }
table { width:100%; border-collapse:collapse; }
td { padding:6px 0; border-bottom:1px solid var(--line); }
tr:last-child td { border-bottom:0; }
.num { text-align:right; color:var(--muted); white-space:nowrap; }
.muted { color:var(--muted); }
.chip { display:inline-block; font-size:12px; padding:1px 8px; border-radius:999px; font-weight:600; }
.chip.in { background:rgba(47,125,79,.12); color:var(--good); }
.chip.out { background:rgba(107,103,96,.12); color:var(--muted); }
.actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:8px; }
button { font:inherit; cursor:pointer; border-radius:8px; padding:9px 14px; border:1px solid var(--line); background:#fff; color:var(--ink); }
button.cta { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); font-weight:600; }
.foot { color:var(--muted); font-size:13px; margin-top:18px; }
code { background:rgba(0,0,0,.05); padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>/ask-qmd search scope</h1>
  <p class="sub">When you run <code>/ask-qmd "&hellip;"</code>, it searches the collections <span class="chip in">in&nbsp;scope</span> below. Everything else stays indexed but is only searched when you ask for it with <code>-c &lt;name&gt;</code>.</p>

  <div class="card">
    <h2>In scope <span class="chip in">default</span></h2>
    <table>
        ${rows(inScope, true)}
    </table>
  </div>

  <div class="card">
    <h2>Out of scope <span class="chip out">excluded</span></h2>
    <table>
        ${rows(outScope, false)}
    </table>
  </div>

  <div class="actions">
    <button class="cta"
            data-duo-action="claude:spawn"
            data-cwd="${esc(CHECKOUT)}"
            data-cmd="${esc(changeScopePrompt(inScope, outScope))}">
      Change scope&hellip;
    </button>
    <button id="copy-btn">Copy scope</button>
  </div>

  <p class="foot">The button opens a new Claude tab to adjust the scope, then regenerates this view. Scope lives in qmd&rsquo;s <code>include</code>/<code>exclude</code> state — there is no separate config file.</p>
</div>

<script>
  var SCOPE_TEXT = ${JSON.stringify(scopeText)};
  var b = document.getElementById('copy-btn');
  if (b) b.addEventListener('click', async function () {
    try { await navigator.clipboard.writeText(SCOPE_TEXT); } catch (e) {}
    var t = b.textContent; b.textContent = 'Copied!';
    setTimeout(function () { b.textContent = t; }, 1200);
  });
</script>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, "utf8");
console.log(OUT);

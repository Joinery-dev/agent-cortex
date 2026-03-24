#!/usr/bin/env node

// Opens .mmd files in Mermaid Live Editor
//
// Usage:
//   node diagrams/open-in-mermaid-live.js diagrams/how-it-works.mmd
//   node diagrams/open-in-mermaid-live.js diagrams/*.mmd

const zlib = require("zlib");
const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

const files = process.argv.slice(2);

if (files.length === 0) {
  console.log("Usage: node diagrams/open-in-mermaid-live.js <file.mmd> [file2.mmd ...]");
  console.log("       node diagrams/open-in-mermaid-live.js diagrams/*.mmd");
  process.exit(1);
}

for (const file of files) {
  let text = fs.readFileSync(file, "utf-8");

  // Strip YAML frontmatter
  text = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();

  // Build the Mermaid Live state object
  const state = JSON.stringify({
    code: text,
    mermaid: {
      theme: "default",
      sequence: {
        actorFontSize: 20,
        messageFontSize: 18,
        noteFontSize: 16,
        actorMargin: 80,
        width: 250,
        noteMargin: 20,
      },
      flowchart: {
        htmlLabels: true,
        curve: "basis",
        padding: 24,
        nodeSpacing: 60,
        rankSpacing: 60,
      },
      fontSize: 18,
    },
    autoSync: true,
    updateDiagram: true,
  });

  // Compress with zlib deflate and encode as base64url
  const compressed = zlib.deflateSync(Buffer.from(state, "utf-8"));
  const url = "https://mermaid.live/edit#pako:" + compressed.toString("base64url");

  // Write a redirect HTML file — passing long URLs directly to `open`
  // breaks because the shell truncates or mangles them.
  const name = path.basename(file, ".mmd");
  const tmpFile = `/tmp/mermaid-${name}.html`;
  const html = [
    "<html><head><script>",
    'window.location.href = decodeURIComponent("' + encodeURIComponent(url) + '");',
    "<\/script></head></html>",
  ].join("");

  fs.writeFileSync(tmpFile, html);
  execSync(`open "${tmpFile}"`);

  console.log(`${name} → opened (${url.length} chars)`);
}

#!/usr/bin/env node

// Renders a .mmd file via Mermaid Live and screenshots the diagram.
// Usage: node diagrams/screenshot-mermaid.cjs diagrams/some-diagram.mmd [output.png]

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

async function main() {
  const file = process.argv[2];
  const output = process.argv[3] || `/tmp/mermaid-screenshot-${path.basename(file, ".mmd")}.png`;

  if (!file) {
    console.log("Usage: node diagrams/screenshot-mermaid.cjs <file.mmd> [output.png]");
    process.exit(1);
  }

  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();

  const state = JSON.stringify({
    code: text,
    mermaid: {
      theme: "default",
      sequence: { actorFontSize: 20, messageFontSize: 18, noteFontSize: 16, actorMargin: 80, width: 250, noteMargin: 20 },
      flowchart: { htmlLabels: true, curve: "basis", padding: 24, nodeSpacing: 60, rankSpacing: 60 },
      fontSize: 18,
    },
    autoSync: true,
    updateDiagram: true,
  });

  const compressed = zlib.deflateSync(Buffer.from(state, "utf-8"));
  const url = "https://mermaid.live/edit#pako:" + compressed.toString("base64url");

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 2560, height: 1600 } });

  await page.goto(url, { waitUntil: "networkidle" });
  // Wait for the SVG diagram to render
  await page.waitForSelector("#view svg", { timeout: 15000 }).catch(() => {});
  // Extra settle time for layout
  await page.waitForTimeout(2000);

  // Try to screenshot just the diagram panel
  const diagramEl = await page.$("#view");
  if (diagramEl) {
    await diagramEl.screenshot({ path: output });
  } else {
    await page.screenshot({ path: output, fullPage: true });
  }

  await browser.close();
  console.log(`Screenshot saved: ${output}`);
}

main().catch(e => { console.error(e); process.exit(1); });

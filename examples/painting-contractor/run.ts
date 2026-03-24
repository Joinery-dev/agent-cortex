import { Cortex } from "../../src/index.js";
import type { ProjectIntent, TasteProfile } from "../../src/index.js";

// ─── Project Intent ──────────────────────────────────────────

const intent: ProjectIntent = {
  id: "mikes-painting",
  summary:
    "A website for Mike's Painting, a residential painting contractor in Columbus, Ohio. Mike has been in business for 15 years. His reputation is everything — most work comes from referrals and neighbors seeing his trucks in the driveway.",
  audience:
    "Homeowners in suburban Columbus considering interior or exterior painting. Age 35-65. Looking for someone trustworthy to let into their home.",
  successCriteria: [
    "Visitor feels this is a legitimate, established business within 3 seconds",
    "Easy path to requesting a free estimate",
    "Works well on mobile phones",
    "Feels warm and personal, not corporate",
  ],
  constraints: [
    "Mobile-first — many visitors will be on phones",
    "Must feel trustworthy and established",
    "Simple to maintain — Mike is not technical",
  ],
  vision:
    "A warm, professional online presence that feels like a trusted neighbor, not a corporate entity or a fly-by-night operation. When someone lands on this site, they should feel the same way they'd feel if a well-dressed, friendly contractor knocked on their door with a firm handshake.",
  keyDecisions: [],
  driftLog: [],
};

// ─── Taste Profile ───────────────────────────────────────────

const taste: TasteProfile = {
  id: "kevin-defaults",
  name: "Kevin's defaults",
  visual:
    "Warm earth tones — rust, forest green, cream, warm grays. Serif or humanist sans-serif for headings. Generous whitespace. Rounded corners.",
  decisionStyle:
    "Prefers simple over clever. Ships good over perfects great. Authentic over polished.",
  communication:
    "Terse updates, show screenshots not descriptions. Don't over-explain.",
  patterns:
    "Always wants a prominent contact/quote CTA. Iterates most on headlines and hero sections.",
  raw: {},
};

// ─── Run ─────────────────────────────────────────────────────

async function main() {
  const useDashboard = process.argv.includes("--dashboard");

  const cortex = new Cortex({
    intent,
    taste,
    logLevel: useDashboard ? "warn" : "info",
  });

  console.log("\n═══════════════════════════════════════════════");
  console.log("  Agent Cortex — Painting Contractor Example");
  console.log("═══════════════════════════════════════════════\n");

  if (useDashboard) {
    const url = await cortex.startDashboard();
    console.log(`  Dashboard: ${url}`);
    console.log("  Open in your browser to watch the cortex think.\n");

    // Give the browser a moment to connect
    await new Promise((r) => setTimeout(r, 2000));
  }

  const result = await cortex.run("Build the homepage hero section");

  console.log("\n═══════════════════════════════════════════════");
  console.log("  RESULT");
  console.log("═══════════════════════════════════════════════\n");

  console.log(`Status: ${result.status}`);
  console.log(`Cycles: ${result.cycles}`);
  console.log(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
  console.log(`Senses evaluated: ${result.evaluations.length}`);
  console.log(`Tensions found: ${result.tensions.length}`);
  console.log(`Resolutions: ${result.resolutions.length}`);

  console.log("\n─── Evaluation Scores ───────────────────────\n");
  for (const eval_ of result.evaluations) {
    const bar = "█".repeat(eval_.score) + "░".repeat(10 - eval_.score);
    console.log(`  ${bar} ${eval_.score}/10  ${eval_.activationPath.join(" > ")}`);
  }

  if (result.tensions.length > 0) {
    console.log("\n─── Tensions ───────────────────────────────\n");
    for (const tension of result.tensions) {
      console.log(`  [${tension.severity.toUpperCase()}] ${tension.description}`);
      if (tension.resolution) {
        console.log(`  → Resolved: ${tension.resolution.strategy}`);
      }
    }
  }

  console.log("\n─── Work Product ───────────────────────────\n");
  console.log(result.work);

  console.log("\n─── Token Usage ────────────────────────────\n");
  const usage = cortex.getTokenUsage();
  for (const [purpose, tokens] of Object.entries(usage)) {
    if (tokens.inputTokens > 0 || tokens.outputTokens > 0) {
      console.log(
        `  ${purpose}: ${tokens.inputTokens.toLocaleString()} in / ${tokens.outputTokens.toLocaleString()} out`
      );
    }
  }

  console.log("\n─── Decision Log ───────────────────────────\n");
  for (const decision of result.decisionLog) {
    const flag = decision.requiresHumanReview ? " ⚠️ REVIEW" : "";
    console.log(
      `  [${(decision.confidence * 100).toFixed(0)}%] ${decision.description}${flag}`
    );
    console.log(`       ${decision.reasoning}`);
  }

  console.log("\n═══════════════════════════════════════════════\n");
}

main().catch(console.error);

import { Cortex } from "../../src/index.js";
import type { ProjectIntent, TasteProfile } from "../../src/index.js";

// ─── Project Intent ──────────────────────────────────────────

const intent: ProjectIntent = {
  id: "blue-note-chi",
  summary:
    "A landing page for The Blue Note, a legendary jazz club in Chicago reopening after a two-year renovation. Live performances Thursday–Sunday, intimate 120-seat room, craft cocktails, late-night sets. The owner is a retired session musician who played with Herbie Hancock.",
  audience:
    "Jazz enthusiasts and curious nightlife seekers in Chicago, age 25-55. Mix of serious jazz heads who know the club's history and younger crowds discovering live jazz for the first time.",
  successCriteria: [
    "Visitor immediately feels the atmosphere — moody, intimate, alive",
    "Tonight's lineup and next show are findable in under 2 seconds",
    "Reservation flow is frictionless on mobile",
    "The history and credibility of the venue come through without being stuffy",
    "Page loads fast despite rich visual atmosphere",
  ],
  constraints: [
    "Must feel like walking into the club, not reading a brochure",
    "Performance schedule must be scannable — no walls of text",
    "Accessibility matters — older jazz fans, low-light UI is fine but text must be readable",
    "No autoplaying audio — ever",
  ],
  vision:
    "You push through a heavy door into a room where the light is amber and the bass is already in your chest. The page should feel like that moment — warm, electric, slightly dangerous. Not a corporate venue site. A place with soul.",
  keyDecisions: [],
  driftLog: [],
};

// ─── Taste Profile ───────────────────────────────────────────

const taste: TasteProfile = {
  id: "kevin-defaults",
  name: "Kevin's defaults",
  visual:
    "Deep blacks, warm amber, aged brass. Tight typography — condensed sans for headlines, something with character for the vibe text. Minimal whitespace — density creates intimacy. Subtle texture, not flat.",
  decisionStyle:
    "Atmosphere over information. If it doesn't feel right, the information doesn't matter. But the information still has to be there.",
  communication:
    "Terse updates, show screenshots not descriptions. Don't over-explain.",
  patterns:
    "Hero should be immersive, not informational. Schedule should feel like a setlist. Always wants a strong CTA but it should feel like an invitation, not a sales pitch.",
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
  console.log("  Agent Cortex — Jazz Club Example");
  console.log("═══════════════════════════════════════════════\n");

  if (useDashboard) {
    const url = await cortex.startDashboard();
    console.log(`  Dashboard: ${url}`);
    console.log("  Open in your browser to watch the cortex think.\n");

    // Give the browser a moment to connect
    await new Promise((r) => setTimeout(r, 2000));
  }

  const result = await cortex.run(
    "Build the landing page — hero, tonight's schedule, and reservation CTA"
  );

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
    const bar = "\u2588".repeat(eval_.score) + "\u2591".repeat(10 - eval_.score);
    console.log(
      `  ${bar} ${eval_.score}/10  ${eval_.activationPath.join(" > ")}`
    );
  }

  if (result.tensions.length > 0) {
    console.log("\n─── Tensions ───────────────────────────────\n");
    for (const tension of result.tensions) {
      console.log(
        `  [${tension.severity.toUpperCase()}] ${tension.description}`
      );
      if (tension.resolution) {
        console.log(`  \u2192 Resolved: ${tension.resolution.strategy}`);
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
    const flag = decision.requiresHumanReview ? " \u26a0\ufe0f REVIEW" : "";
    console.log(
      `  [${(decision.confidence * 100).toFixed(0)}%] ${decision.description}${flag}`
    );
    console.log(`       ${decision.reasoning}`);
  }

  console.log("\n═══════════════════════════════════════════════\n");
}

main().catch(console.error);

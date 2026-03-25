/**
 * Cerebellum — Smoke Test
 *
 * Verifies the full prediction → outcome → dopamine lifecycle:
 *   1. extractFingerprint() — consultation to fingerprint
 *   2. Similarity functions — Jaccard, stake difference, composite
 *   3. findSimilarEpisodes() — retrieval with thresholds + recency
 *   4. predictFromEpisodes() — receptor-level and sense-fallback
 *   5. Cerebellum.predict() — cold start returns null
 *   6. Cerebellum.recordOutcome() — episode stored, dopamine computed
 *   7. Full lifecycle: seed episodes → predict → verify dopamine
 *   8. Accuracy tracking and recalibration
 *
 * Run: npx tsx examples/cerebellum-smoke.ts
 */

import {
  extractFingerprint,
  jaccardSimilarity,
  meanStakeDifference,
  computeSimilarity,
  findSimilarEpisodes,
  predictFromEpisodes,
  computeOverallConfidence,
} from "../src/subcortical/forward-model.js";
import { computeDopamine, computeAccuracy } from "../src/subcortical/dopamine.js";
import { Cerebellum } from "../src/subcortical/cerebellum.js";
import type { Consultation, EvaluationPlanEntry } from "../src/types/consultation.js";
import type { SenseEvaluation } from "../src/types/sense.js";
import type {
  TaskFingerprint,
  CerebellumEpisode,
  CerebellumPrediction,
} from "../src/types/cerebellum.js";
import { DEFAULT_CEREBELLUM_CONFIG } from "../src/types/cerebellum.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

// ─── Test data factories ─────────────────────────────────────────

function makeConsultation(
  taskId: string,
  senses: { name: string; stake: number; receptors: string[] }[],
): Consultation {
  const perspectives = senses.map((s) => ({
    senseId: s.name.toLowerCase(),
    senseName: s.name,
    perspective: `${s.name} perspective on task`,
    evaluators: s.receptors,
    stake: s.stake,
  }));

  const evaluationPlan: EvaluationPlanEntry[] = senses.flatMap((s) =>
    s.receptors.map((r) => ({
      receptorId: r,
      parentSenseId: s.name.toLowerCase(),
      parentSenseName: s.name,
      parentStake: s.stake,
      parentPerspective: `${s.name} perspective on task`,
    })),
  );

  return {
    taskId,
    producedAt: new Date(),
    perspectives,
    evaluationPlan,
    stakeDistribution: {
      entries: senses.map((s) => ({
        senseId: s.name.toLowerCase(),
        senseName: s.name,
        stake: s.stake,
      })),
      totalStake: senses.reduce((sum, s) => sum + s.stake, 0),
      meanStake: senses.reduce((sum, s) => sum + s.stake, 0) / senses.length,
      max: senses.reduce(
        (max, s) => (s.stake > max.stake ? { senseId: s.name.toLowerCase(), senseName: s.name, stake: s.stake } : max),
        { senseId: "", senseName: "", stake: 0 },
      ),
    },
    conditions: {
      activeSenses: senses.map((s) => ({ senseId: s.name.toLowerCase(), senseName: s.name })),
      inhibitedSenses: [],
    },
  };
}

function makeEvaluations(
  scores: { receptorId: string; senseName: string; score: number }[],
): SenseEvaluation[] {
  return scores.map((s) => ({
    senseId: s.receptorId,
    activationPath: [s.senseName, s.receptorId],
    score: s.score,
    acceptable: s.score >= 5,
    assessment: `Score: ${s.score}`,
    tensions: [],
    suggestions: [],
  }));
}

function makeEpisode(
  taskId: string,
  senseStakes: [string, number][],
  receptorScores: [string, number][],
  senseScores: [string, number][],
  sequenceNumber: number,
): CerebellumEpisode {
  return {
    taskId,
    fingerprint: {
      senseStakes: new Map(senseStakes),
      activeReceptors: new Set(receptorScores.map(([id]) => id)),
    },
    receptorScores: new Map(receptorScores),
    senseScores: new Map(senseScores),
    predictedScores: null,
    sequenceNumber,
    recordedAt: new Date(),
  };
}

// ─── 1. Fingerprinting ───────────────────────────────────────────

console.log("\n1. extractFingerprint()");
{
  const consultation = makeConsultation("t1", [
    { name: "Design", stake: 0.8, receptors: ["color-harmony", "layout-balance"] },
    { name: "Performance", stake: 0.3, receptors: ["load-time"] },
  ]);

  const fp = extractFingerprint(consultation);

  assert(fp.senseStakes.size === 2, "extracts 2 senses");
  assert(fp.senseStakes.get("Design") === 0.8, "Design stake = 0.8");
  assert(fp.senseStakes.get("Performance") === 0.3, "Performance stake = 0.3");
  assert(fp.activeReceptors.size === 3, "extracts 3 receptors");
  assert(fp.activeReceptors.has("color-harmony"), "has color-harmony receptor");
  assert(fp.activeReceptors.has("load-time"), "has load-time receptor");
}

// ─── 2. Similarity functions ─────────────────────────────────────

console.log("\n2. Similarity primitives");
{
  // Jaccard
  const a = new Set(["x", "y", "z"]);
  const b = new Set(["y", "z", "w"]);
  assert(Math.abs(jaccardSimilarity(a, b) - 0.5) < 0.01, "Jaccard {x,y,z} ∩ {y,z,w} = 0.5");
  assert(jaccardSimilarity(new Set(), new Set()) === 0, "Jaccard empty sets = 0");
  assert(jaccardSimilarity(a, a) === 1, "Jaccard identical = 1");

  // Stake difference
  const s1 = new Map([["Design", 0.8], ["Perf", 0.3]]);
  const s2 = new Map([["Design", 0.6], ["Perf", 0.5]]);
  const diff = meanStakeDifference(s1, s2);
  assert(Math.abs(diff - 0.2) < 0.01, "stake diff = mean(0.2, 0.2) = 0.2");

  // No shared keys
  const s3 = new Map([["Security", 0.9]]);
  assert(meanStakeDifference(s1, s3) === 0, "no shared keys = 0");

  // Full similarity
  const fpA: TaskFingerprint = { senseStakes: s1, activeReceptors: new Set(["r1", "r2"]) };
  const fpB: TaskFingerprint = { senseStakes: s2, activeReceptors: new Set(["r1", "r3"]) };
  const sim = computeSimilarity(fpA, fpB, DEFAULT_CEREBELLUM_CONFIG.similarityWeights);
  assert(sim > 0.5, `composite similarity > 0.5 (got ${sim.toFixed(3)})`);
  assert(sim < 1.0, `composite similarity < 1.0 (got ${sim.toFixed(3)})`);
}

// ─── 3. Episode retrieval ────────────────────────────────────────

console.log("\n3. findSimilarEpisodes()");
{
  const episodes: CerebellumEpisode[] = [
    makeEpisode("e1", [["Design", 0.8], ["Perf", 0.3]], [["r1", 7], ["r2", 6]], [["Design", 6.5], ["Perf", 6]], 0),
    makeEpisode("e2", [["Design", 0.7], ["Perf", 0.4]], [["r1", 8], ["r2", 5]], [["Design", 6.5], ["Perf", 5]], 1),
    makeEpisode("e3", [["Security", 0.9]], [["r5", 9]], [["Security", 9]], 2), // very different
  ];

  const query: TaskFingerprint = {
    senseStakes: new Map([["Design", 0.8], ["Perf", 0.3]]),
    activeReceptors: new Set(["r1", "r2"]),
  };

  const matches = findSimilarEpisodes(query, episodes, DEFAULT_CEREBELLUM_CONFIG);

  assert(matches.length === 2, `2 similar episodes found (got ${matches.length})`);
  assert(matches[0].episode.taskId === "e2" || matches[0].episode.taskId === "e1",
    "top match is e1 or e2 (both similar)");
  assert(!matches.some((m) => m.episode.taskId === "e3"),
    "e3 (security-only) not matched");

  // Empty episodes returns empty
  assert(findSimilarEpisodes(query, [], DEFAULT_CEREBELLUM_CONFIG).length === 0,
    "empty episode store → empty results");
}

// ─── 4. Prediction from episodes ─────────────────────────────────

console.log("\n4. predictFromEpisodes()");
{
  const episodes: CerebellumEpisode[] = [
    makeEpisode("e1", [["Design", 0.8]], [["r1", 7], ["r2", 6]], [["Design", 6.5]], 0),
    makeEpisode("e2", [["Design", 0.7]], [["r1", 8], ["r2", 5]], [["Design", 6.5]], 1),
  ];

  const query: TaskFingerprint = {
    senseStakes: new Map([["Design", 0.8]]),
    activeReceptors: new Set(["r1", "r2"]),
  };

  const matches = findSimilarEpisodes(query, episodes, DEFAULT_CEREBELLUM_CONFIG);
  const plan: EvaluationPlanEntry[] = [
    { receptorId: "r1", parentSenseId: "design", parentSenseName: "Design", parentStake: 0.8, parentPerspective: "" },
    { receptorId: "r2", parentSenseId: "design", parentSenseName: "Design", parentStake: 0.8, parentPerspective: "" },
    { receptorId: "r-new", parentSenseId: "design", parentSenseName: "Design", parentStake: 0.8, parentPerspective: "" },
  ];

  const predictions = predictFromEpisodes(matches, plan);

  const r1Pred = predictions.find((p) => p.receptorId === "r1");
  const r2Pred = predictions.find((p) => p.receptorId === "r2");
  const rNewPred = predictions.find((p) => p.receptorId === "r-new");

  assert(r1Pred !== undefined, "r1 has prediction");
  assert(r1Pred!.source === "receptor", "r1 is direct receptor prediction");
  assert(r1Pred!.predicted >= 7 && r1Pred!.predicted <= 8, `r1 predicted in [7,8] (got ${r1Pred!.predicted.toFixed(2)})`);

  assert(r2Pred !== undefined, "r2 has prediction");
  assert(r2Pred!.predicted >= 5 && r2Pred!.predicted <= 6, `r2 predicted in [5,6] (got ${r2Pred!.predicted.toFixed(2)})`);

  assert(rNewPred !== undefined, "r-new has prediction (sense fallback)");
  assert(rNewPred!.source === "sense-fallback", "r-new falls back to sense level");
  assert(rNewPred!.predicted >= 6 && rNewPred!.predicted <= 7, `r-new predicted from sense mean (got ${rNewPred!.predicted.toFixed(2)})`);

  const overall = computeOverallConfidence(predictions);
  assert(overall > 0 && overall <= 1, `overall confidence in (0,1] (got ${overall.toFixed(3)})`);
}

// ─── 5. Cold start ───────────────────────────────────────────────

console.log("\n5. Cerebellum.predict() — cold start");
{
  const cerebellum = new Cerebellum();
  const consultation = makeConsultation("cold-1", [
    { name: "Design", stake: 0.8, receptors: ["r1"] },
  ]);

  const prediction = cerebellum.predict("cold-1", consultation);
  assert(prediction === null, "cold start returns null");
  assert(cerebellum.getEpisodeCount() === 0, "no episodes stored yet");
  assert(cerebellum.getAccuracy() === 0.8, "accuracy = 0.8 (healthy default)");
}

// ─── 6. Record outcome without prediction ────────────────────────

console.log("\n6. Cerebellum.recordOutcome() — no prediction (cold start episode)");
{
  const cerebellum = new Cerebellum();
  const consultation = makeConsultation("seed-1", [
    { name: "Design", stake: 0.8, receptors: ["r1", "r2"] },
  ]);

  // predict returns null (cold start), but stores fingerprint
  cerebellum.predict("seed-1", consultation);

  const evaluations = makeEvaluations([
    { receptorId: "r1", senseName: "Design", score: 7 },
    { receptorId: "r2", senseName: "Design", score: 6 },
  ]);

  const dopamine = cerebellum.recordOutcome("seed-1", evaluations);
  assert(dopamine === null, "no dopamine on cold start");
  assert(cerebellum.getEpisodeCount() === 1, "episode stored for future use");
}

// ─── 7. Full lifecycle ───────────────────────────────────────────

console.log("\n7. Full lifecycle: seed → predict → record → dopamine");
{
  const cerebellum = new Cerebellum({ minEpisodes: 2 });

  // Seed 3 episodes with similar consultations
  const senses = [
    { name: "Design", stake: 0.8, receptors: ["r1", "r2"] },
    { name: "Performance", stake: 0.3, receptors: ["r3"] },
  ];

  for (let i = 0; i < 3; i++) {
    const consultation = makeConsultation(`seed-${i}`, senses);
    cerebellum.predict(`seed-${i}`, consultation);
    cerebellum.recordOutcome(
      `seed-${i}`,
      makeEvaluations([
        { receptorId: "r1", senseName: "Design", score: 7 },
        { receptorId: "r2", senseName: "Design", score: 6 },
        { receptorId: "r3", senseName: "Performance", score: 8 },
      ]),
    );
  }

  assert(cerebellum.getEpisodeCount() === 3, "3 episodes seeded");

  // Now predict on a similar task
  const consultation = makeConsultation("test-1", senses);
  const prediction = cerebellum.predict("test-1", consultation);

  assert(prediction !== null, "prediction made (enough episodes)");
  assert(prediction!.receptorPredictions.length === 3, "3 receptor predictions");
  assert(prediction!.overallConfidence > 0, "positive confidence");

  const r1Pred = prediction!.receptorPredictions.find((p) => p.receptorId === "r1");
  assert(r1Pred !== undefined, "r1 predicted");
  assert(Math.abs(r1Pred!.predicted - 7) < 0.5, `r1 predicted ~7 (got ${r1Pred!.predicted.toFixed(2)})`);

  // Actual outcome matches prediction → small dopamine
  const dopamineSmall = cerebellum.recordOutcome(
    "test-1",
    makeEvaluations([
      { receptorId: "r1", senseName: "Design", score: 7 },
      { receptorId: "r2", senseName: "Design", score: 6 },
      { receptorId: "r3", senseName: "Performance", score: 8 },
    ]),
  );

  assert(dopamineSmall !== null, "dopamine signal produced");
  assert(Math.abs(dopamineSmall!.aggregate) < 0.5, `small dopamine for matching scores (got ${dopamineSmall!.aggregate.toFixed(3)})`);

  // Now predict again, but actual is very different → large dopamine
  const consultation2 = makeConsultation("test-2", senses);
  const prediction2 = cerebellum.predict("test-2", consultation2);
  assert(prediction2 !== null, "second prediction made");

  const dopamineLarge = cerebellum.recordOutcome(
    "test-2",
    makeEvaluations([
      { receptorId: "r1", senseName: "Design", score: 3 },  // predicted ~7, got 3
      { receptorId: "r2", senseName: "Design", score: 2 },  // predicted ~6, got 2
      { receptorId: "r3", senseName: "Performance", score: 3 }, // predicted ~8, got 3
    ]),
  );

  assert(dopamineLarge !== null, "large dopamine signal produced");
  assert(dopamineLarge!.aggregate < -1, `large negative dopamine (got ${dopamineLarge!.aggregate.toFixed(3)})`);
  assert(dopamineLarge!.rawAggregate < dopamineLarge!.aggregate || dopamineLarge!.rawAggregate === dopamineLarge!.aggregate / dopamineLarge!.predictionConfidence,
    "raw aggregate != confidence-modulated aggregate");

  assert(cerebellum.getEpisodeCount() === 5, "5 total episodes");
}

// ─── 8. Accuracy and recalibration ──────────────────────────────

console.log("\n8. Accuracy tracking and recalibration");
{
  const cerebellum = new Cerebellum({ minEpisodes: 1, maxEpisodes: 10 });

  const senses = [{ name: "Design", stake: 0.8, receptors: ["r1"] }];

  // Seed one episode
  const c0 = makeConsultation("a-0", senses);
  cerebellum.predict("a-0", c0);
  cerebellum.recordOutcome("a-0", makeEvaluations([{ receptorId: "r1", senseName: "Design", score: 7 }]));

  // Now make predictions that are accurate
  for (let i = 1; i <= 3; i++) {
    const c = makeConsultation(`a-${i}`, senses);
    cerebellum.predict(`a-${i}`, c);
    cerebellum.recordOutcome(`a-${i}`, makeEvaluations([{ receptorId: "r1", senseName: "Design", score: 7 }]));
  }

  const accuracyGood = cerebellum.getAccuracy();
  assert(accuracyGood > 0.9, `good accuracy when predictions match (got ${accuracyGood.toFixed(3)})`);

  // Now make predictions that are inaccurate
  for (let i = 4; i <= 7; i++) {
    const c = makeConsultation(`a-${i}`, senses);
    cerebellum.predict(`a-${i}`, c);
    // Actual score very different from predicted ~7
    cerebellum.recordOutcome(`a-${i}`, makeEvaluations([{ receptorId: "r1", senseName: "Design", score: 2 }]));
  }

  const accuracyBad = cerebellum.getAccuracy();
  assert(accuracyBad < accuracyGood, `accuracy decreased (${accuracyBad.toFixed(3)} < ${accuracyGood.toFixed(3)})`);

  // Recalibrate
  const result = cerebellum.recalibrate();
  assert(result.recalibrated, "recalibration happened");
  assert(cerebellum.getEpisodeCount() <= 8, `episodes pruned to ≤ 75% of max`);
}

// ─── 9. Dopamine computation (pure function) ─────────────────────

console.log("\n9. computeDopamine() — pure function");
{
  const consultation = makeConsultation("d-1", [
    { name: "Design", stake: 0.8, receptors: ["r1"] },
    { name: "Performance", stake: 0.2, receptors: ["r2"] },
  ]);

  const prediction: CerebellumPrediction = {
    taskId: "d-1",
    receptorPredictions: [
      { receptorId: "r1", activationPath: ["Design", "r1"], predicted: 7, confidence: 0.9, basedOnEpisodes: 3, source: "receptor" },
      { receptorId: "r2", activationPath: ["Performance", "r2"], predicted: 5, confidence: 0.6, basedOnEpisodes: 2, source: "receptor" },
    ],
    overallConfidence: 0.75,
    episodeCount: 3,
    bestSimilarity: 0.9,
    predictedAt: new Date(),
  };

  // Perfect match → zero dopamine
  const perfect = computeDopamine(
    prediction,
    makeEvaluations([
      { receptorId: "r1", senseName: "Design", score: 7 },
      { receptorId: "r2", senseName: "Performance", score: 5 },
    ]),
    consultation,
  );
  assert(perfect.aggregate === 0, `perfect match → 0 aggregate (got ${perfect.aggregate})`);
  assert(perfect.perReceptor.every((r) => r.delta === 0), "all per-receptor deltas = 0");

  // Positive surprise (actual > predicted)
  const positive = computeDopamine(
    prediction,
    makeEvaluations([
      { receptorId: "r1", senseName: "Design", score: 9 },
      { receptorId: "r2", senseName: "Performance", score: 8 },
    ]),
    consultation,
  );
  assert(positive.aggregate > 0, `positive surprise → positive aggregate (got ${positive.aggregate.toFixed(3)})`);
  assert(positive.rawAggregate > positive.aggregate, "confidence modulation reduces magnitude");

  // Negative surprise (actual < predicted)
  const negative = computeDopamine(
    prediction,
    makeEvaluations([
      { receptorId: "r1", senseName: "Design", score: 3 },
      { receptorId: "r2", senseName: "Performance", score: 2 },
    ]),
    consultation,
  );
  assert(negative.aggregate < 0, `negative surprise → negative aggregate (got ${negative.aggregate.toFixed(3)})`);

  // Stake weighting: Design (0.8) matters more than Performance (0.2)
  const stakeTest = computeDopamine(
    prediction,
    makeEvaluations([
      { receptorId: "r1", senseName: "Design", score: 9 },  // +2, stake 0.8
      { receptorId: "r2", senseName: "Performance", score: 3 }, // -2, stake 0.2
    ]),
    consultation,
  );
  assert(stakeTest.rawAggregate > 0,
    `stake-weighted: Design +2 (0.8) outweighs Perf -2 (0.2) → positive (got ${stakeTest.rawAggregate.toFixed(3)})`);
}

// ─── 10. Accuracy computation (pure function) ────────────────────

console.log("\n10. computeAccuracy()");
{
  const prediction: CerebellumPrediction = {
    taskId: "acc-1",
    receptorPredictions: [
      { receptorId: "r1", activationPath: ["A", "r1"], predicted: 7, confidence: 0.9, basedOnEpisodes: 3, source: "receptor" },
    ],
    overallConfidence: 0.9,
    episodeCount: 3,
    bestSimilarity: 0.9,
    predictedAt: new Date(),
  };

  // Perfect
  const perfect = computeAccuracy(prediction, makeEvaluations([
    { receptorId: "r1", senseName: "A", score: 7 },
  ]));
  assert(perfect.accuracy === 1, `perfect prediction → accuracy 1 (got ${perfect.accuracy})`);

  // Off by 2
  const offBy2 = computeAccuracy(prediction, makeEvaluations([
    { receptorId: "r1", senseName: "A", score: 5 },
  ]));
  assert(Math.abs(offBy2.accuracy - (1 - 2 / 9)) < 0.01, `off by 2 → accuracy ~${(1 - 2/9).toFixed(3)} (got ${offBy2.accuracy.toFixed(3)})`);
  assert(offBy2.meanAbsoluteError === 2, "MAE = 2");
}

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`  Cerebellum smoke test: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);

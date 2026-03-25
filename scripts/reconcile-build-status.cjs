/**
 * reconcile-build-status.cjs
 *
 * Claude Code Stop hook — runs when an agent session ends.
 * Scans the codebase, diffs against build-status.json, and patches anything missing.
 *
 * Rules:
 *   - Only ADDS information, never removes entries or changes statuses
 *   - Idempotent — running twice adds nothing new
 *   - Exits silently on any error (must not crash as a hook)
 *   - Zero external dependencies — Node built-ins only
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD_STATUS_PATH = path.join(ROOT, 'build-status.json');
const DIAGRAMS_DIR = path.join(ROOT, 'diagrams');

try {
  main();
} catch (_) {
  process.exit(0);
}

function main() {
  // ── Load build-status.json ──────────────────────────────────────────
  if (!fs.existsSync(BUILD_STATUS_PATH)) return;

  let raw;
  try {
    raw = fs.readFileSync(BUILD_STATUS_PATH, 'utf8');
  } catch (_) {
    return;
  }

  let status;
  try {
    status = JSON.parse(raw);
  } catch (_) {
    return;
  }

  let changed = false;

  // ── Rule 1: Untracked diagrams ──────────────────────────────────────
  changed = reconcileUntracked(status) || changed;

  // ── Rule 2: Unreferenced source files ───────────────────────────────
  changed = reconcileUnreferenced(status) || changed;

  // ── Rule 3: Not-started subtasks with existing files ────────────────
  changed = reconcileNotStarted(status) || changed;

  // ── Write back ──────────────────────────────────────────────────────
  if (changed) {
    fs.writeFileSync(
      BUILD_STATUS_PATH,
      JSON.stringify(status, null, 2) + '\n',
      'utf8'
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Rule 1 — Untracked diagrams
//
// Scan diagrams/*.mmd. If a file has no scope: in its frontmatter AND is
// not already referenced in globalDiagrams or any phase/feature diagrams
// array, add it to globalDiagrams with its title from frontmatter.
// ═══════════════════════════════════════════════════════════════════════

function reconcileUntracked(status) {
  if (!fs.existsSync(DIAGRAMS_DIR)) return false;

  let entries;
  try {
    entries = fs.readdirSync(DIAGRAMS_DIR);
  } catch (_) {
    return false;
  }

  const mmdFiles = entries.filter(function (e) {
    return e.endsWith('.mmd');
  });

  if (mmdFiles.length === 0) return false;

  // Collect every diagram filename already tracked anywhere
  const tracked = new Set();
  collectTrackedDiagrams(status, tracked);

  let changed = false;

  for (const file of mmdFiles) {
    if (tracked.has(file)) continue;

    const fullPath = path.join(DIAGRAMS_DIR, file);
    const frontmatter = parseFrontmatter(fullPath);
    if (!frontmatter) continue;

    // Only add if there is NO scope field in frontmatter
    if (frontmatter.scope !== undefined) continue;

    const title = frontmatter.title || file.replace(/\.mmd$/, '');

    if (!Array.isArray(status.globalDiagrams)) {
      status.globalDiagrams = [];
    }

    status.globalDiagrams.push({ file: file, label: String(title) });
    tracked.add(file);
    changed = true;
  }

  return changed;
}

// ═══════════════════════════════════════════════════════════════════════
// Rule 2 — Unreferenced source files
//
// Scan src/types/*.ts and src/kernel/*.ts. Collect all file paths mentioned
// in subtask detail fields. Any file on disk but not in any detail → add a
// note on the best-matching feature.
// ═══════════════════════════════════════════════════════════════════════

function reconcileUnreferenced(status) {
  const dirs = [
    path.join(ROOT, 'src', 'types'),
    path.join(ROOT, 'src', 'kernel'),
  ];

  // Collect all src-relative file paths on disk
  const onDisk = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    const relDir = path.relative(ROOT, dir);
    for (const entry of entries) {
      if (entry.endsWith('.ts')) {
        onDisk.push(relDir + '/' + entry); // e.g. "src/types/brainstem.ts"
      }
    }
  }

  if (onDisk.length === 0) return false;

  // Collect every src/ path referenced in any subtask detail
  const referencedPaths = new Set();
  forEachFeature(status, function (feature) {
    if (!Array.isArray(feature.subtasks)) return;
    for (const sub of feature.subtasks) {
      if (typeof sub.detail !== 'string') continue;
      extractSrcPaths(sub.detail, referencedPaths);
    }
  });

  // Find unreferenced files
  const unreferenced = onDisk.filter(function (p) {
    return !referencedPaths.has(p);
  });

  if (unreferenced.length === 0) return false;

  // Build feature name lookup (lowercase → feature ref)
  const featuresByName = new Map();
  forEachFeature(status, function (feature) {
    if (feature.name) {
      featuresByName.set(feature.name.toLowerCase(), feature);
    }
  });

  let changed = false;

  for (const filePath of unreferenced) {
    const stem = filenameStem(filePath); // e.g. "cerebellum" from "src/types/cerebellum.ts"
    const note = '[Reconciled] ' + filePath + ' exists but isn\'t referenced in any subtask.';

    // Find best-matching feature by stem
    const feature = findFeatureByStem(featuresByName, stem);

    if (feature) {
      if (addNoteIfNew(feature, note)) changed = true;
    } else {
      // No match — add to top-level reconciliation notes
      if (!status.reconciliation) {
        status.reconciliation = { notes: [] };
      }
      if (!Array.isArray(status.reconciliation.notes)) {
        status.reconciliation.notes = [];
      }
      if (!status.reconciliation.notes.includes(note)) {
        status.reconciliation.notes.push(note);
        changed = true;
      }
    }
  }

  return changed;
}

// ═══════════════════════════════════════════════════════════════════════
// Rule 3 — Not-started subtasks with existing files
//
// For each subtask with status "not-started", extract src/ paths from its
// detail. If those files exist on disk → add a note on the parent feature.
// ═══════════════════════════════════════════════════════════════════════

function reconcileNotStarted(status) {
  let changed = false;

  forEachFeature(status, function (feature) {
    if (!Array.isArray(feature.subtasks)) return;

    for (const sub of feature.subtasks) {
      if (sub.status !== 'not-started') continue;
      if (typeof sub.detail !== 'string') continue;

      const paths = new Set();
      extractSrcPaths(sub.detail, paths);

      for (const srcPath of paths) {
        const fullPath = path.join(ROOT, srcPath);
        if (!fs.existsSync(fullPath)) continue;

        const note =
          '[Reconciled] \'' +
          sub.name +
          '\' references ' +
          srcPath +
          ' which exists on disk but is marked not-started.';

        if (addNoteIfNew(feature, note)) changed = true;
      }
    }
  });

  return changed;
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse YAML-style frontmatter from an .mmd file.
 * Returns an object with parsed key/value pairs, or null on failure.
 */
function parseFrontmatter(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }

  if (!content.startsWith('---')) return null;

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return null;

  const block = content.slice(3, endIdx).trim();
  if (!block) return null;

  const result = {};
  const lines = block.split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

/**
 * Collect all diagram filenames referenced anywhere in build-status.
 */
function collectTrackedDiagrams(status, set) {
  // globalDiagrams
  if (Array.isArray(status.globalDiagrams)) {
    for (const d of status.globalDiagrams) {
      if (d.file) set.add(d.file);
    }
  }

  // Phase-level and feature-level diagrams
  if (Array.isArray(status.phases)) {
    for (const phase of status.phases) {
      if (Array.isArray(phase.diagrams)) {
        for (const d of phase.diagrams) {
          if (typeof d === 'string') {
            set.add(d);
          } else if (d && d.file) {
            set.add(d.file);
          }
        }
      }
      if (Array.isArray(phase.features)) {
        for (const feature of phase.features) {
          if (Array.isArray(feature.diagrams)) {
            for (const d of feature.diagrams) {
              if (typeof d === 'string') {
                set.add(d);
              } else if (d && d.file) {
                set.add(d.file);
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Iterate over every feature in every phase.
 */
function forEachFeature(status, fn) {
  if (!Array.isArray(status.phases)) return;
  for (const phase of status.phases) {
    if (!Array.isArray(phase.features)) continue;
    for (const feature of phase.features) {
      fn(feature);
    }
  }
}

/**
 * Extract all src/ file paths from a detail string.
 * Matches patterns like "src/types/brainstem.ts", "src/kernel/pns.ts", etc.
 */
function extractSrcPaths(detail, set) {
  // Match src/ paths ending in .ts (word boundaries to avoid partial matches)
  const re = /src\/[\w\-./]+\.ts/g;
  let match;
  while ((match = re.exec(detail)) !== null) {
    set.add(match[0]);
  }
}

/**
 * Extract the filename stem from a path.
 * "src/types/cerebellum.ts" → "cerebellum"
 */
function filenameStem(filePath) {
  const base = path.basename(filePath, '.ts');
  return base;
}

/**
 * Find a feature whose name contains the stem (case-insensitive).
 * e.g. stem "cerebellum" matches feature "Cerebellum"
 * stem "inhibitor" matches feature "Inhibitor"
 * stem "motor-cortex" matches feature "Motor Cortex"
 */
function findFeatureByStem(featuresByName, stem) {
  // Normalize: "motor-cortex" → "motor cortex", "working-memory" → "working memory"
  const normalized = stem.replace(/-/g, ' ').toLowerCase();

  // Exact match on normalized name
  if (featuresByName.has(normalized)) {
    return featuresByName.get(normalized);
  }

  // Containment match: feature name contains stem
  for (const [name, feature] of featuresByName) {
    if (name.includes(normalized)) {
      return feature;
    }
  }

  // Reverse containment: stem contains feature name word
  for (const [name, feature] of featuresByName) {
    // Get the first significant word of the feature name
    const words = name.split(/[\s/]+/);
    for (const word of words) {
      if (word.length >= 4 && normalized.includes(word)) {
        return feature;
      }
    }
  }

  return null;
}

/**
 * Add a note to a feature's notes field if not already present.
 * Returns true if a note was added.
 */
function addNoteIfNew(feature, note) {
  if (typeof feature.notes === 'string') {
    if (feature.notes.includes(note)) return false;
    feature.notes = feature.notes + '\n' + note;
    return true;
  }
  if (typeof feature.notes === 'undefined' || feature.notes === null) {
    feature.notes = note;
    return true;
  }
  // Defensive: if notes is somehow something else, coerce
  const existing = String(feature.notes);
  if (existing.includes(note)) return false;
  feature.notes = existing + '\n' + note;
  return true;
}

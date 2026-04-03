/**
 * Terminal Formatters — rich ANSI output for slash commands.
 *
 * Each formatter takes structured data and returns a formatted string
 * ready for terminal display. No side effects — pure functions.
 */

// ─── ANSI ─────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";

// ─── Table ────────────────────────────────────────────────────

export function formatTable(
  rows: string[][],
  headers?: string[],
): string {
  const allRows = headers ? [headers, ...rows] : rows;
  if (allRows.length === 0) return "";

  // Compute column widths
  const colCount = Math.max(...allRows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    widths[c] = Math.max(...allRows.map((r) => stripAnsi(r[c] ?? "").length));
  }

  const lines: string[] = [];

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const cells = row.map((cell, c) => {
      const plain = stripAnsi(cell);
      const pad = " ".repeat(Math.max(0, widths[c] - plain.length));
      return cell + pad;
    });
    const prefix = i === 0 && headers ? BOLD : "";
    const suffix = prefix ? RESET : "";
    lines.push(`  ${prefix}${cells.join("  ")}${suffix}`);

    // Separator after header
    if (i === 0 && headers) {
      lines.push(`  ${DIM}${widths.map((w) => "─".repeat(w)).join("──")}${RESET}`);
    }
  }

  return lines.join("\n");
}

// ─── Progress Bar ─────────────────────────────────────────────

export function formatBar(
  value: number,
  max: number,
  width = 20,
  opts?: { label?: string; threshold?: number },
): string {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  // Color based on ratio
  const color = ratio > 0.8 ? RED : ratio > 0.5 ? YELLOW : GREEN;
  const bar = `${color}${"█".repeat(filled)}${DIM}${"░".repeat(empty)}${RESET}`;
  const pct = `${(ratio * 100).toFixed(0)}%`;
  const label = opts?.label ? `${opts.label} ` : "";

  return `  ${label}${bar} ${pct}`;
}

// ─── Vital Sign ───────────────────────────────────────────────

export function formatVital(
  name: string,
  value: number,
  opts?: { threshold?: number; inverse?: boolean },
): string {
  const ratio = Math.min(1, Math.max(0, value));
  const barWidth = 15;
  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;

  // For inverse vitals (like predictionAccuracy), high = good
  const isGood = opts?.inverse ? ratio > 0.5 : ratio < 0.5;
  const color = isGood ? GREEN : ratio > 0.8 || (opts?.inverse && ratio < 0.2) ? RED : YELLOW;

  const bar = `${color}${"█".repeat(filled)}${DIM}${"░".repeat(empty)}${RESET}`;
  const val = `${(ratio * 100).toFixed(0)}%`;
  const padName = name.padEnd(22);

  return `  ${padName} ${bar} ${val}`;
}

// ─── Tree ─────────────────────────────────────────────────────

export interface TreeNode {
  label: string;
  status?: "pending" | "active" | "complete" | "escalated";
  children?: TreeNode[];
}

export function formatTree(nodes: TreeNode[], indent = 0): string {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const icon = node.status === "complete" ? `${GREEN}✓${RESET}`
      : node.status === "active" ? `${CYAN}▸${RESET}`
      : node.status === "escalated" ? `${RED}!${RESET}`
      : `${DIM}○${RESET}`;

    lines.push(`${prefix}${connector}${icon} ${node.label}`);

    if (node.children && node.children.length > 0) {
      lines.push(formatTree(node.children, indent + 1));
    }
  }

  return lines.join("\n");
}

// ─── Maxim ────────────────────────────────────────────────────

export interface MaximDisplay {
  statement: string;
  cognitive?: string;
  axiological?: string;
  volitional?: string;
  confidence: number;
}

export function formatMaxim(maxim: MaximDisplay, index?: number): string {
  const num = index != null ? `${DIM}${index + 1}.${RESET} ` : "";
  const conf = `${DIM}(${(maxim.confidence * 100).toFixed(0)}%)${RESET}`;
  const lines = [`  ${num}${BOLD}${maxim.statement}${RESET} ${conf}`];

  if (maxim.cognitive) {
    lines.push(`     ${CYAN}cognitive:${RESET} ${maxim.cognitive}`);
  }
  if (maxim.axiological) {
    lines.push(`     ${MAGENTA}axiological:${RESET} ${maxim.axiological}`);
  }
  if (maxim.volitional) {
    lines.push(`     ${YELLOW}volitional:${RESET} ${maxim.volitional}`);
  }

  return lines.join("\n");
}

// ─── Awareness Insight ────────────────────────────────────────

export interface InsightDisplay {
  source: string;
  summary: string;
  severity: "info" | "warn" | "critical";
  timestamp: Date;
  taskId?: string | null;
}

export function formatInsight(insight: InsightDisplay): string {
  const time = formatTime(insight.timestamp);
  const severityColor = insight.severity === "critical" ? RED
    : insight.severity === "warn" ? YELLOW : DIM;
  const severityIcon = insight.severity === "critical" ? "●"
    : insight.severity === "warn" ? "◐" : "○";
  const source = `${DIM}[${insight.source}]${RESET}`;

  return `  ${DIM}${time}${RESET} ${severityColor}${severityIcon}${RESET} ${source} ${insight.summary}`;
}

// ─── Section Header ───────────────────────────────────────────

export function formatHeader(title: string): string {
  return `\n  ${BOLD}${title}${RESET}\n  ${DIM}${"─".repeat(title.length + 4)}${RESET}`;
}

// ─── Empty state ──────────────────────────────────────────────

export function formatEmpty(message: string): string {
  return `  ${DIM}${message}${RESET}`;
}

// ─── Key-value pair ───────────────────────────────────────────

export function formatKV(key: string, value: string, keyWidth = 18): string {
  return `  ${DIM}${key.padEnd(keyWidth)}${RESET} ${value}`;
}

// ─── Helpers ──────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

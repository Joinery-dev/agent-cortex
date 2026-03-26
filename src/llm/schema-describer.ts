/**
 * Schema Describer — walks a Zod v4 schema and produces a human-readable
 * annotated JSON template for LLM prompts.
 *
 * The schema is the source of truth for structured output contracts.
 * This module derives prompt-friendly descriptions from the same artifact
 * that does validation, so they can never diverge.
 *
 * Also provides prompt fingerprinting for versioning persistent artifacts.
 */

import { z } from "zod";
import { createHash } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────

/** Zod v4 internal def — accessed via schema._zod.def */
interface ZodDef {
  type: string;
  // Object
  shape?: Record<string, z.ZodType>;
  // Array
  element?: z.ZodType;
  // Enum
  entries?: Record<string, string>;
  // Literal
  values?: unknown[];
  // Union
  options?: z.ZodType[];
  // Tuple
  items?: z.ZodType[];
  // Optional / Nullable
  innerType?: z.ZodType;
  // Checks (unused — we read from bag instead)
  checks?: unknown[];
}

/** Zod v4 internal bag — processed constraints from checks */
interface ZodBag {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

/** Zod v4 internal _zod property */
interface ZodInternals {
  def: ZodDef;
  bag?: ZodBag;
}

function getZod(schema: z.ZodType): ZodInternals {
  return (schema as unknown as { _zod: ZodInternals })._zod;
}

function getDescription(schema: z.ZodType): string | undefined {
  return z.globalRegistry.get(schema as z.core.$ZodType)?.description;
}

// ─── Walker ──────────────────────────────────────────────────────

/**
 * Walk a Zod schema and produce an annotated JSON template string.
 *
 * Example output:
 * ```
 * {
 *   "perspective": string,
 *   "stake": number (0.0–1.0) — How much would be lost?,
 *   "level": "aligned" | "drifting" | "diverged",
 *   "tags": string[] (1–3 items)
 * }
 * ```
 */
export function describeSchema(schema: z.ZodType): string {
  return describeNode(schema, 0);
}

function describeNode(schema: z.ZodType, indent: number): string {
  const { def, bag } = getZod(schema);
  const desc = getDescription(schema);

  switch (def.type) {
    case "string":
      return appendDesc("string", desc);

    case "number": {
      const range = formatRange(bag);
      return appendDesc(range ? `number ${range}` : "number", desc);
    }

    case "boolean":
      return appendDesc("boolean", desc);

    case "literal": {
      const val = def.values?.[0];
      return appendDesc(JSON.stringify(val), desc);
    }

    case "enum": {
      const values = Object.values(def.entries ?? {});
      const joined = values.map((v) => JSON.stringify(v)).join(" | ");
      return appendDesc(joined, desc);
    }

    case "array": {
      const element = def.element!;
      const range = formatRange(bag);
      const suffix = range ? ` (${range.slice(1, -1)} items)` : "";

      if (isSimpleType(element)) {
        const inner = describeNode(element, indent);
        return appendDesc(`${inner}[]${suffix}`, desc);
      }

      // Complex element — show structure
      const inner = describeNode(element, indent + 1);
      const pad = "  ".repeat(indent);
      return `[${suffix}\n${pad}  ${inner}\n${pad}]` + descSuffix(desc);
    }

    case "object": {
      const pad = "  ".repeat(indent);
      const lines: string[] = ["{"];

      for (const [key, fieldSchema] of Object.entries(def.shape ?? {})) {
        const fieldStr = describeNode(fieldSchema, indent + 1);
        lines.push(`${pad}  "${key}": ${fieldStr},`);
      }

      lines.push(`${pad}}`);
      return lines.join("\n") + descSuffix(desc);
    }

    case "union": {
      const options = def.options ?? [];

      // If all options are simple (literals, strings, etc.), inline them
      if (options.every((o) => isSimpleType(o))) {
        const parts = options.map((o) => describeNode(o, indent));
        return appendDesc(parts.join(" | "), desc);
      }

      // Complex union — show each variant
      const pad = "  ".repeat(indent);
      const parts = options.map((o) => describeNode(o, indent));
      return parts.join(`\n${pad}| `) + descSuffix(desc);
    }

    case "tuple": {
      const items = def.items ?? [];
      const parts = items.map((i) => describeNode(i, indent));
      return appendDesc(
        `[${parts.join(", ")}] (exactly ${items.length})`,
        desc,
      );
    }

    case "optional": {
      const inner = describeNode(def.innerType!, indent);
      // Don't double-tag if inner already has annotations
      return `${inner} (optional)`;
    }

    case "nullable": {
      const inner = describeNode(def.innerType!, indent);
      return `${inner} | null`;
    }

    default:
      return "unknown";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function formatRange(bag?: ZodBag): string | null {
  if (!bag) return null;

  const min = bag.minimum ?? bag.exclusiveMinimum;
  const max = bag.maximum ?? bag.exclusiveMaximum;
  if (min == null && max == null) return null;

  const fmt = (n: number) =>
    Number.isInteger(n) ? String(n) : n.toFixed(1);

  if (min != null && max != null) {
    // For 0–1 ranges, show 0.0–1.0 to signal float intent to the LLM
    const useFloat =
      Number.isInteger(min) && Number.isInteger(max) && max - min <= 1;
    const f = useFloat ? (n: number) => n.toFixed(1) : fmt;
    return `(${f(min)}–${f(max)})`;
  }
  if (min != null) return `(>= ${fmt(min)})`;
  return `(<= ${fmt(max!)})`;
}

function appendDesc(typeHint: string, desc?: string): string {
  return desc ? `${typeHint} — ${desc}` : typeHint;
}

function descSuffix(desc?: string): string {
  return desc ? ` — ${desc}` : "";
}

function isSimpleType(schema: z.ZodType): boolean {
  const { def } = getZod(schema);
  const t = def.type;

  if (t === "optional" || t === "nullable") {
    return isSimpleType(def.innerType!);
  }

  return ["string", "number", "boolean", "literal", "enum"].includes(t);
}

// ─── Prompt fingerprinting ───────────────────────────────────────

/**
 * Compute a short hash of the prompt contract (system prompt + schema
 * description). Used to version persistent LLM artifacts like principles.
 *
 * 12 hex chars = 48 bits. This is a version marker, not a security
 * primitive — collisions are acceptable as long as they're rare.
 */
export function promptFingerprint(
  systemPrompt: string,
  schemaDescription: string,
): string {
  return createHash("sha256")
    .update(systemPrompt + "\n---\n" + schemaDescription)
    .digest("hex")
    .slice(0, 12);
}

import type { Sense } from "../types/sense.js";
import { DESIGN_TREE } from "./personas/design.js";
import { CORRECTNESS_TREE } from "./personas/correctness.js";
import { SYSTEMS_TREE } from "./personas/systems.js";
import { INTENT_ALIGNMENT_TREE } from "./personas/intent-alignment.js";
import { SECURITY_TREE } from "./personas/security.js";
import { MAINTAINABILITY_TREE } from "./personas/maintainability.js";
import { DEVELOPER_EXPERIENCE_TREE } from "./personas/developer-experience.js";
import { CONTENT_CRAFT_TREE } from "./personas/content-craft.js";
import { OBSERVABILITY_TREE } from "./personas/observability.js";
import { COMPLIANCE_PRIVACY_TREE } from "./personas/compliance-privacy.js";
import { ACCESSIBILITY_TREE } from "./personas/accessibility.js";

export class SensoryCortex {
  private senses: Map<string, Sense> = new Map();

  constructor(trees: Sense[][] = []) {
    for (const tree of trees) {
      for (const sense of tree) {
        this.senses.set(sense.id, sense);
      }
    }
  }

  static withDefaults(): SensoryCortex {
    return new SensoryCortex([
      DESIGN_TREE,
      CORRECTNESS_TREE,
      SYSTEMS_TREE,
      INTENT_ALIGNMENT_TREE,
      SECURITY_TREE,
      MAINTAINABILITY_TREE,
      DEVELOPER_EXPERIENCE_TREE,
      CONTENT_CRAFT_TREE,
      OBSERVABILITY_TREE,
      COMPLIANCE_PRIVACY_TREE,
      ACCESSIBILITY_TREE,
    ]);
  }

  get(id: string): Sense | undefined {
    return this.senses.get(id);
  }

  getSenses(): Sense[] {
    return [...this.senses.values()].filter((g) => g.level === "sense");
  }

  getChildren(parentId: string): Sense[] {
    const parent = this.senses.get(parentId);
    if (!parent?.children) return [];
    return parent.children
      .map((id) => this.senses.get(id))
      .filter((g): g is Sense => g !== undefined);
  }

  getSubTree(rootId: string): Sense[] {
    const result: Sense[] = [];
    const root = this.senses.get(rootId);
    if (!root) return result;

    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);
      if (current.children) {
        for (const childId of current.children) {
          const child = this.senses.get(childId);
          if (child) queue.push(child);
        }
      }
    }
    return result;
  }

  getAncestorPath(senseId: string): string[] {
    const path: string[] = [];
    let current = this.senses.get(senseId);
    while (current) {
      path.unshift(current.name);
      current = current.parentId
        ? this.senses.get(current.parentId)
        : undefined;
    }
    return path;
  }

  add(sense: Sense): void {
    this.senses.set(sense.id, sense);
  }

  all(): Sense[] {
    return [...this.senses.values()];
  }

  get size(): number {
    return this.senses.size;
  }
}

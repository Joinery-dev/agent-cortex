/**
 * Token estimation utility.
 *
 * Rough approximation for budget decisions — not exact tokenization.
 * Claude's tokenizer averages ~4 characters per token for English
 * text and code. Good enough for briefing size estimation and
 * contextCapacity vital sign computation.
 */

/**
 * Estimate the number of tokens in a string.
 * Uses the ~4 chars/token heuristic for Claude models.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

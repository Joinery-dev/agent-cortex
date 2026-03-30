/**
 * Approval heuristic — shared between project rhythm and worldview generation.
 *
 * Detects whether a user response is a short affirmative ("yes", "lgtm", etc.)
 * or substantive feedback that should be incorporated.
 */

/**
 * Is the Parsifal's response an approval or a redirect?
 * Short affirmatives → approval. Anything substantive → redirect.
 */
export function isApproval(response: string): boolean {
  const normalized = response.trim().toLowerCase().replace(/[.!,]+$/, "");
  const approvals = [
    "yes", "y", "confirmed", "confirm", "approved", "approve",
    "looks good", "lgtm", "looks right", "that's it", "thats it",
    "proceed", "go ahead", "ship it", "perfect", "exactly",
    "that's what i see", "thats what i see", "correct",
  ];
  return approvals.includes(normalized);
}

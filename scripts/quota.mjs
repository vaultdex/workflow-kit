// GitHub's GraphQL quota is 5000 points an hour for the whole account, shared by every agent on it.
// Pure helpers for board.mjs, kept apart so tests can call them without running a command.

/** A failed `gh api graphql` call: GitHub's error type RATE_LIMITED, its message, or a secondary limit. */
export const isRateLimited = text => /RATE_LIMIT|API rate limit|secondary rate limit/i.test(text);

/**
 * Seconds between two reads of `wait`: 60, then 1.5 times longer per read without news, up to 5 minutes.
 * Below 1000 points left the pause doubles (at most 10 minutes), so a nearly empty quota is not the polling's doing.
 */
export function waitInterval(quietReads, remaining) {
  const base = Math.min(60 * 1.5 ** quietReads, 300);
  return remaining < 1000 ? Math.min(base * 2, 600) : base;
}

/**
 * Monotonic clock for the safety layer.
 *
 * `Date.now()` is settable, so a backward step extends every confirmation-token
 * TTL and its stored dry-run stays "fresh" — fail-open on a money gate.
 * `performance.now()` cannot be set, but does not advance across a system
 * suspend, so callers pair it with a wall-clock check.
 */

/** Milliseconds elapsed on a scale that no clock change can move. */
export function monotonicNow(): number {
  return performance.now();
}

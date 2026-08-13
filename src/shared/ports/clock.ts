/**
 * `ClockPort` (D-004).
 *
 * In D-004's list on purpose: cool-off windows, token expiry and retention
 * clocks are all time-dependent business rules, and they must be testable
 * without sleeping. A test that waits is a test that is slow and flaky; a test
 * that advances a fake clock is neither.
 */
export interface ClockPort {
  now(): Date;
}

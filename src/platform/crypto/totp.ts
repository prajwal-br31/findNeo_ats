import { Secret, TOTP } from 'otpauth';

/**
 * TOTP enrolment and verification (D-006, 05a §5).
 *
 * `otpauth` over speakeasy: maintained, no dependency on Node's deprecated
 * crypto shims, and it produces the `otpauth://` URI authenticator apps expect
 * rather than leaving the caller to assemble one by hand.
 */

const ISSUER = 'FindNeo';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * One step of clock skew either side (±30s).
 *
 * Not zero, because phone clocks drift and a rejected valid code sends people
 * to support. Not larger, because the window is exactly how long a phished
 * code stays usable.
 */
const SKEW_WINDOW = 1;

export interface TotpEnrolment {
  /** base32, to be shown once and stored encrypted. */
  readonly secret: string;
  /** `otpauth://…` — what a QR code encodes. */
  readonly uri: string;
}

function build(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function beginTotpEnrolment(label: string): TotpEnrolment {
  /* 20 bytes — the RFC 4226 recommendation, and what every authenticator app
     is tested against. */
  const secret = new Secret({ size: 20 });
  const totp = build(secret.base32, label);
  return { secret: secret.base32, uri: totp.toString() };
}

/**
 * Verifies a code, returning true only for a code inside the skew window.
 *
 * `validate` returns the delta or `null`; anything non-null within the window
 * is a pass. A malformed secret throws inside `otpauth`, and that is caught
 * here and treated as a failed verification — an enrolment with a corrupt
 * stored secret should reject codes, not 500.
 */
export function verifyTotp(secretBase32: string, label: string, code: string): boolean {
  try {
    const delta = build(secretBase32, label).validate({ token: code, window: SKEW_WINDOW });
    return delta !== null;
  } catch {
    return false;
  }
}

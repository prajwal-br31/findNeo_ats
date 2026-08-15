import { AppError } from '../../../shared/errors/app-error.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import { unsafeUserId } from '../../../shared/types/ids.js';
import type { AuthUserRow, IdentityRepository } from '../infrastructure/identity.repository.js';

import type { MfaAdapters } from './auth.types.js';

/**
 * The second factor at login.
 *
 * **This departs from 08 §3 step 6**, which issues a short-lived challenge
 * token and redeems it at a second endpoint. That indirection buys nothing —
 * the TOTP code is the second factor either way — and it costs a credential
 * that exists between the two calls and can be stolen there. The code travels
 * with the password and is checked in the same transaction, so no challenge is
 * ever minted and there is no window in which one is valid.
 *
 * Returns `false` for a wrong code rather than throwing, so the caller records
 * it as a failed attempt: a second factor that does not count toward lockout
 * is free to brute-force once the password is known. Only an *absent* code
 * throws, because a client that has not yet asked the user for one has to be
 * told to.
 *
 * **The caller must have bound the tenant first.** This reads
 * `users.mfa_secret_encrypted`, and that table is under FORCE RLS — untenanted
 * it returns no row, the check fails closed, and a correct code is rejected.
 *
 * @throws ERR_MFA_REQUIRED when no code was supplied.
 */
export async function secondFactorPasses(
  tx: TxScope,
  user: AuthUserRow,
  mfaCode: string | undefined,
  deps: { repository: IdentityRepository; mfa: MfaAdapters },
): Promise<boolean> {
  if (mfaCode === undefined || mfaCode === '') {
    throw new AppError('ERR_MFA_REQUIRED', {
      detail: 'Multi-factor authentication is required.',
    });
  }

  const stored = await deps.repository.readMfaSecret(tx, unsafeUserId(user.id));
  /* The flag is set but no secret exists: the account cannot produce a second
     factor, so it cannot authenticate. Refused rather than waved through —
     failing open here would make `mfa_enabled` decorative. */
  if (stored === undefined) return false;

  return deps.mfa.verify(deps.mfa.decrypt(stored.secret), stored.email, mfaCode);
}

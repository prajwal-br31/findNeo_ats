import type {
  AuthService,
  LoginResult,
  RequestMeta,
  SignupResult,
} from './application/auth.service.js';
import { unsafeCompanyId, unsafeUserId } from '../../shared/types/ids.js';
import type { LoginBody, SignupBody, VerifyEmailBody } from './identity.schemas.js';

/**
 * Auth controller (ER-002).
 *
 * Validates, calls one application service, shapes the response. It holds no
 * business rule, and it never touches a repository — the boundaries linter
 * enforces both, but the reason is that a rule living here is a rule the
 * worker cannot reach (ER-004).
 *
 * Nothing here reads a Fastify request either: the route handler destructures
 * what it needs and passes plain values in, so these methods are callable
 * from a test without a server.
 */

export class AuthController {
  readonly #service: AuthService;

  constructor(service: AuthService) {
    this.#service = service;
  }

  async signup(body: SignupBody): Promise<SignupResult> {
    return this.#service.signup({
      companyName: body.companyName,
      slug: body.slug,
      countryCode: body.countryCode,
      fullName: body.fullName,
      email: body.email,
      password: body.password,
    });
  }

  async login(body: LoginBody, meta: RequestMeta): Promise<LoginResult> {
    return this.#service.login(body.email, body.password, meta, body.mfaCode);
  }

  async refresh(refreshToken: string, meta: RequestMeta): Promise<LoginResult> {
    return this.#service.refresh(refreshToken, meta);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.#service.logout(refreshToken);
  }

  async beginMfa(companyId: string, userId: string): Promise<{ secret: string; uri: string }> {
    return this.#service.beginMfaEnrolment(unsafeCompanyId(companyId), unsafeUserId(userId));
  }

  async completeMfa(companyId: string, userId: string, code: string): Promise<void> {
    await this.#service.enableMfa(unsafeCompanyId(companyId), unsafeUserId(userId), code);
  }

  async verifyEmail(body: VerifyEmailBody): Promise<void> {
    await this.#service.verifyEmail(
      unsafeCompanyId(body.companyId),
      unsafeUserId(body.userId),
      body.token,
    );
  }
}

/**
 * Licensing — entitlement, NOT authentication.
 *
 * This answers "is this installation entitled to feature X".
 * Authentication ("is this caller allowed to control this gateway") lives in
 * security/auth.ts and runs before this middleware. Neither substitutes for the
 * other: before release 0.4 this file was the only thing between the network and
 * the tool registry, which was the wrong job for it.
 *
 * The OSS build is entitled to everything. This hook exists so downstream
 * distributions can gate their own additions without patching the request path.
 */

import type { Request, Response, NextFunction } from 'express';

export type LicenseTier = 'oss' | 'starter' | 'professional' | 'business' | 'enterprise';

export interface LicenseInfo {
  tier: LicenseTier;
  /** Present when CLERQ_LICENSE is set; opaque to the OSS build. */
  key?: string;
}

export function resolveLicense(): LicenseInfo {
  const key = process.env.CLERQ_LICENSE?.trim();
  return key ? { tier: 'enterprise', key } : { tier: 'oss' };
}

/** Request with entitlement info attached by licenseCheck. */
export type RequestWithLicense = Request & { license?: LicenseInfo };

/**
 * Attach entitlement information to the request. The OSS build never rejects on
 * licensing grounds — every feature in this repository is available to everyone.
 *
 * @param _devMode retained for signature compatibility; licensing no longer
 *                 varies by development mode, because it no longer gates access.
 */
export function licenseCheck(
  _devMode?: boolean
): (req: Request, res: Response, next: NextFunction) => void {
  const license = resolveLicense();
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as RequestWithLicense).license = license;
    next();
  };
}

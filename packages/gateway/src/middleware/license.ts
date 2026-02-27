/**
 * License stub: require CLERQ_LICENSE or CLERQ_DEV to allow requests.
 * When neither is set, respond 403 (except for /health).
 */

import type { Request, Response, NextFunction } from 'express';

export function licenseCheck(devMode?: boolean): (req: Request, res: Response, next: NextFunction) => void {
  const dev = devMode ?? (process.env.CLERQ_DEV === '1' || process.env.CLERQ_DEV === 'true');
  const hasLicense = !!process.env.CLERQ_LICENSE;

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') {
      next();
      return;
    }
    if (dev || hasLicense) {
      next();
      return;
    }
    res.status(403).json({
      error: 'license_required',
      message: 'Clerq requires a valid subscription. Set CLERQ_LICENSE or CLERQ_DEV=1 for development.',
    });
  };
}

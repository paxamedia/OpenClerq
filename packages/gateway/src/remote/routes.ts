/**
 * HTTP endpoints for remote mode and paired devices.
 */

import type { Express, NextFunction, Request, Response } from 'express';
import { logger } from '../logger.js';
import { principalOf } from '../security/auth.js';
import { actorOf } from '../records/routes.js';
import {
  RemoteError,
  createPairingCode,
  getDevice,
  listDevices,
  pairDevice,
  remoteSettings,
  revokeDevice,
  updateRemoteSettings,
} from './devices.js';

function fail(res: Response, e: unknown, code: string): Response {
  if (e instanceof RemoteError) {
    const status = {
      invalid: 400,
      remote_disabled: 409,
      bad_code: 401,
      not_found: 404,
      rate_limited: 429,
    }[e.code];
    return res.status(status).json({ error: e.code, message: e.message });
  }
  const message = e instanceof Error ? e.message : String(e);
  logger.error(code, { err: message });
  return res.status(500).json({ error: code, message });
}

/** With remote mode off, paired devices are turned away until it is back on. */
export function refuseDevicesWhenRemoteOff(req: Request, res: Response, next: NextFunction): void {
  if (principalOf(res)?.kind === 'device' && !remoteSettings().enabled) {
    res
      .status(403)
      .json({ error: 'remote_disabled', message: 'Remote mode is off on this gateway.' });
    return;
  }
  next();
}

export function mountRemoteRoutes(app: Express): void {
  app.get('/remote', (_req: Request, res: Response) => {
    res.json(remoteSettings());
  });

  app.put('/remote', (req: Request, res: Response) => {
    try {
      res.json(updateRemoteSettings((req.body ?? {}) as Record<string, unknown>, actorOf(res)));
    } catch (e) {
      fail(res, e, 'remote_update_failed');
    }
  });

  /** A single-use code, valid five minutes, for the desktop to show as a QR code. */
  app.post('/devices/pairing', (_req: Request, res: Response) => {
    try {
      res.status(201).json(createPairingCode());
    } catch (e) {
      fail(res, e, 'pairing_failed');
    }
  });

  /** Public: the phone trades a pairing code for its device token. */
  app.post('/devices/pair', (req: Request, res: Response) => {
    try {
      const out = pairDevice((req.body ?? {}) as Record<string, unknown>);
      logger.info('Device paired', { deviceId: out.device.id, platform: out.device.platform });
      res.status(201).json(out);
    } catch (e) {
      fail(res, e, 'pair_failed');
    }
  });

  app.get('/devices', (_req: Request, res: Response) => {
    res.json({ devices: listDevices() });
  });

  app.get('/devices/me', (_req: Request, res: Response) => {
    const p = principalOf(res);
    if (p?.kind !== 'device' || !p.subject) {
      return res
        .status(400)
        .json({ error: 'invalid', message: 'Only a device token has a /devices/me.' });
    }
    res.json(getDevice(p.subject));
  });

  /** A phone unpairing itself. */
  app.delete('/devices/me', (_req: Request, res: Response) => {
    const p = principalOf(res);
    if (p?.kind !== 'device' || !p.subject) {
      return res
        .status(400)
        .json({ error: 'invalid', message: 'Only a device token has a /devices/me.' });
    }
    try {
      res.json(revokeDevice(p.subject, `device:${p.subject}`));
    } catch (e) {
      fail(res, e, 'device_revoke_failed');
    }
  });

  /** Revoke a device: its token stops working at once. */
  app.delete('/devices/:id', (req: Request, res: Response) => {
    try {
      res.json(revokeDevice(String(req.params.id), actorOf(res)));
    } catch (e) {
      fail(res, e, 'device_revoke_failed');
    }
  });
}

/** Settings → Remote and Devices: reach OpenClerq from a phone, pair it, revoke it. */

import { useEffect, useState } from 'react';
import { Save, Smartphone, Trash2 } from 'lucide-react';
import type { Device } from '@clerq/gateway-client';
import { Button, IconButton } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { EmptyState, KeyValue } from '../../ui/Display';
import { Input } from '../../ui/Field';
import { Dialog } from '../../ui/Modal';
import { QrCode } from '../../ui/QrCode';
import { StatusTag } from '../../ui/Status';
import { Table } from '../../ui/Table';
import { useToast } from '../../ui/Toast';
import { useClient } from '../../app/client';
import { errorMessage, relativeTime } from '../../app/format';
import { useResource } from '../../app/live';
import { Loaded, Section } from '../../shell/layout';
import { useNow, When } from '../common';

const PLATFORMS: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

export function RemoteSection() {
  const client = useClient();
  const toast = useToast();
  const remote = useResource('remote', () => client.remote(), { on: ['devices'] });
  const [url, setUrl] = useState('');
  const [ntfy, setNtfy] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!remote.data) return;
    setUrl(remote.data.publicUrl ?? '');
    setNtfy(remote.data.ntfyServer ?? '');
  }, [remote.data]);

  let urlError: string | undefined;
  if (url.trim()) {
    try {
      if (new URL(url.trim()).protocol !== 'https:')
        urlError = 'Use an https:// address: anything but this computer must be encrypted.';
    } catch {
      urlError = 'Use a full address, such as https://clerq.example.com.';
    }
  }

  const save = async (
    patch: Partial<{ enabled: boolean; publicUrl: string | null; ntfyServer: string }>,
    done: string
  ) => {
    setBusy(true);
    try {
      await client.setRemote(patch);
      toast({ message: done, tone: 'ok' });
    } catch (e) {
      toast({ message: `Couldn’t save. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(false);
      void remote.reload();
    }
  };

  return (
    <Section title="Remote access">
      <p className="page-hint">
        Lets your phone reach OpenClerq through your own tunnel or reverse proxy. OpenClerq still
        only listens on this computer.
      </p>
      <Loaded resource={remote} what="remote settings" skeleton="text">
        {(r) => (
          <>
            <Switch
              checked={r.enabled}
              onChange={(on) =>
                save(
                  { enabled: on },
                  on ? 'Remote access is on.' : 'Remote access is off. Paired phones can’t connect.'
                )
              }
              label="Allow paired phones to connect"
            />
            <Input
              label="Public address"
              mono
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://clerq.example.com"
              error={urlError}
              hint="Where your tunnel or proxy reaches this computer."
            />
            <Input
              label="Push server"
              mono
              value={ntfy}
              onChange={(e) => setNtfy(e.target.value)}
              placeholder="https://ntfy.sh"
              hint="An ntfy server for notifications on paired phones."
            />
            <div className="page-row">
              <Button
                variant="primary"
                icon={Save}
                busy={busy}
                disabled={Boolean(urlError)}
                onClick={() =>
                  save(
                    { publicUrl: url.trim() || null, ntfyServer: ntfy.trim() || undefined },
                    'Saved.'
                  )
                }
              >
                Save
              </Button>
            </div>
          </>
        )}
      </Loaded>
    </Section>
  );
}

function PairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useClient();
  const pairing = useResource(open ? 'pairing' : null, () => client.createPairingCode());
  const now = useNow(1000);
  const expired = pairing.data ? Date.parse(pairing.data.expiresAt) <= now : false;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Pair a phone"
      description="Open the OpenClerq app on your phone and scan this code. It works once, for five minutes."
      size="md"
      actions={
        <>
          <Button variant="ghost" onClick={() => void pairing.reload()}>
            New code
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <Loaded resource={pairing} what="a pairing code" skeleton="block">
        {(p) => (
          <div className="settings-pair">
            {expired ? (
              <EmptyState icon={Smartphone} title="This code has expired">
                Make a new one.
              </EmptyState>
            ) : (
              <QrCode text={p.qr} label={`Pairing code ${p.code}`} />
            )}
            <KeyValue
              items={[
                { label: 'Code', value: p.code, mono: true },
                { label: 'Address', value: p.url, mono: true },
                { label: 'Expires', value: expired ? 'Expired' : relativeTime(p.expiresAt, now) },
              ]}
            />
          </div>
        )}
      </Loaded>
    </Dialog>
  );
}

export function DevicesSection() {
  const client = useClient();
  const toast = useToast();
  const devices = useResource('devices', async () => (await client.devices()).devices, {
    on: ['devices'],
  });
  const [pairing, setPairing] = useState(false);
  const [revoking, setRevoking] = useState<Device | null>(null);

  const revoke = async (d: Device) => {
    try {
      await client.revokeDevice(d.id);
      toast({ message: `${d.name} can no longer connect.`, tone: 'ok' });
    } catch (e) {
      toast({ message: `Couldn’t revoke ${d.name}. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setRevoking(null);
      void devices.reload();
    }
  };

  return (
    <Section
      title="Devices"
      actions={
        <Button variant="primary" icon={Smartphone} onClick={() => setPairing(true)}>
          Pair a phone
        </Button>
      }
    >
      <Loaded resource={devices} what="devices" skeleton="rows">
        {(list) => (
          <Table
            label="Paired devices"
            rows={list}
            rowKey={(d) => d.id}
            columns={[
              { key: 'name', header: 'Device', cell: (d) => d.name, sortValue: (d) => d.name },
              {
                key: 'platform',
                header: 'System',
                cell: (d) => PLATFORMS[d.platform] ?? d.platform,
                width: 'sm',
                hideOnPhone: true,
              },
              {
                key: 'seen',
                header: 'Last seen',
                cell: (d) => (d.lastSeenAt ? <When at={d.lastSeenAt} /> : 'Never'),
                sortValue: (d) => d.lastSeenAt ?? '',
                width: 'sm',
              },
              {
                key: 'paired',
                hideOnPhone: true,
                header: 'Paired',
                cell: (d) => <When at={d.createdAt} />,
                sortValue: (d) => d.createdAt,
                width: 'sm',
              },
              {
                key: 'state',
                header: <span className="ui-sr-only">Status and actions</span>,
                width: 'md',
                cell: (d) =>
                  d.revokedAt ? (
                    <StatusTag tone="muted">Revoked</StatusTag>
                  ) : (
                    <span className="page-row">
                      <StatusTag tone="ok">Can connect</StatusTag>
                      <IconButton
                        icon={Trash2}
                        label={`Revoke ${d.name}`}
                        size="sm"
                        onClick={() => setRevoking(d)}
                      />
                    </span>
                  ),
              },
            ]}
            empty={
              <EmptyState icon={Smartphone} title="No phones paired">
                Pair one to approve, pause and read replies on the go.
              </EmptyState>
            }
          />
        )}
      </Loaded>
      <PairDialog open={pairing} onClose={() => setPairing(false)} />
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.name ?? 'this device'}?`}
        description="It stops working at once. Pair it again to use it."
        actions={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() => revoking && void revoke(revoking)}
            >
              Revoke
            </Button>
          </>
        }
      />
    </Section>
  );
}

/**
 * "Run with a chosen model": a manual run that uses the model you name, in
 * place of the spec's own. A model a person chose is used as chosen.
 */

import { useState } from 'react';
import { Play } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Dialog } from '../../ui/Modal';
import { QUEUED_NOTE } from '../../ui/Status';
import { useToast } from '../../ui/Toast';
import { useClient, type AutomationInfo, type GatewayClient } from '../../app/client';
import { useProviders } from '../../app/data';
import { errorMessage } from '../../app/format';
import { useLive } from '../../app/live';
import { navigate } from '../../app/router';

/** What the field asks for, by driver: the builtin agent takes provider/model; a CLI takes its own names. */
export function modelHint(driver: string | null): string {
  return driver === 'builtin'
    ? 'Name the provider too, as provider/model, for example anthropic/claude-sonnet-5-5.'
    : 'The name the agent’s program takes, for example sonnet. It is passed to it as written.';
}

/** What choosing a model means, in words. It is the same text wherever the choice is offered. */
export const STRICT_NOTE =
  'A model you choose is used as chosen. If it is unavailable the run fails; it never moves to another model. ' +
  'What the spec says about trying a stronger model after a failed gate still applies.';

/**
 * Start a manual run with the model a person named. Rejects an empty name; the
 * gateway rejects a name it cannot use, and its reason is what the dialog shows.
 */
export function runWithModel(client: GatewayClient, id: string, model: string) {
  const chosen = model.trim();
  if (!chosen) return Promise.reject(new Error('Name the model to run with.'));
  return client.runAutomation(id, chosen);
}

export function RunWithModel({
  automation,
  open,
  onClose,
}: {
  automation: AutomationInfo;
  open: boolean;
  onClose: () => void;
}) {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const providers = useProviders();
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const builtin = automation.driver === 'builtin';
  const refs = builtin
    ? (providers.data?.providers ?? [])
        .filter((p) => p.ready)
        .flatMap((p) => p.models.map((m) => m.ref))
    : [];

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { runId, queued } = await runWithModel(client, automation.id, model);
      live.invalidate(['runs', 'automations']);
      if (queued)
        toast({ message: `${automation.name} is queued. ${QUEUED_NOTE}`, tone: 'neutral' });
      onClose();
      navigate(`/runs/${encodeURIComponent(runId)}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Run with a chosen model"
      description={STRICT_NOTE}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Play} busy={busy} disabled={!model.trim()} onClick={run}>
            Run with this model
          </Button>
        </>
      }
    >
      <Input
        label="Model"
        value={model}
        onChange={(e) => {
          setModel(e.target.value);
          setError(null);
        }}
        list={builtin ? 'run-model-options' : undefined}
        placeholder={builtin ? 'provider/model' : 'sonnet'}
        hint={modelHint(automation.driver)}
        error={error}
        mono
        autoComplete="off"
      />
      {builtin && (
        <datalist id="run-model-options">
          {refs.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      )}
    </Dialog>
  );
}

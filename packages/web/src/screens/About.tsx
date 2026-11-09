import { useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Modal';
import { useHost } from '../app/client';
import { errorMessage } from '../app/format';
import './screens.css';

const GITHUB_URL = 'https://github.com/paxamedia/OpenClerq';

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const host = useHost();
  const [state, setState] = useState<'idle' | 'checking' | 'installing' | 'current' | 'error'>(
    'idle'
  );
  const [error, setError] = useState('');

  const check = async () => {
    if (!host.checkForUpdates) return;
    setState('checking');
    try {
      const result = await host.checkForUpdates();
      setState(result === 'installing' ? 'installing' : 'current');
    } catch (e) {
      setError(errorMessage(e));
      setState('error');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="About OpenClerq"
      size="md"
      actions={
        <>
          <Button variant="ghost" icon={ArrowUpRight} onClick={() => host.openUrl(GITHUB_URL)}>
            Source code
          </Button>
          {host.checkForUpdates && (
            <Button
              variant="primary"
              icon={RefreshCw}
              busy={state === 'checking' || state === 'installing'}
              onClick={check}
            >
              {state === 'installing' ? 'Installing update' : 'Check for updates'}
            </Button>
          )}
        </>
      }
    >
      <div className="about">
        <p>
          OpenClerq {host.version} runs automations and agents on this computer. Your data stays
          here; model calls go only to the providers you add keys for.
        </p>
        <p>
          Numbers such as costs and budgets are computed by code on this computer, never by a model.
        </p>
        <p>
          It works with full access to what you point it at, the same as you would. Free and open
          source under the MIT licence, with no warranty.
        </p>
        {state === 'current' && <p className="page-muted">You have the latest version.</p>}
        {state === 'error' && <p className="about-error">Couldn’t check for updates. {error}</p>}
      </div>
    </Dialog>
  );
}

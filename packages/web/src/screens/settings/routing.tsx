/**
 * Settings → Models & keys → Fallback models: the models chat, tasks and
 * triggers use, in order, when the default model is unavailable
 * (GET and PUT /routing). Empty until the user names some.
 */

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import type { ProviderInfo } from '@clerq/gateway-client';
import { Button, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { StatusTag, type Tone } from '../../ui/Status';
import { useToast } from '../../ui/Toast';
import { useClient } from '../../app/client';
import { useProviders } from '../../app/data';
import { errorMessage } from '../../app/format';
import { useResource } from '../../app/live';
import { Loaded, Section } from '../../shell/layout';

/** What a fallback does, in words: where the prompt goes. */
export const FALLBACK_WARNING =
  'A fallback sends your prompt to another provider. When the default model is unavailable, ' +
  'whatever it would have been sent (your message, the conversation so far, saved notes read into the ' +
  'prompt) goes to the first model below that can answer, and so to that model’s provider. ' +
  'The list is empty until you add models, so nothing goes to a provider you did not name.';

/** What does not use the chain. */
export const FALLBACK_STRICT =
  'A model you pick yourself is used as picked and never replaced: a chat set to one model, ' +
  'every column of a comparison, every message in raw mode, and a run started with a chosen model.';

/** What counts as unavailable, as the gateway decides it. */
export const FALLBACK_WHEN =
  'Unavailable means the provider is down, overloaded or rate limiting, did not answer, refused the key, or has no key. ' +
  'A request the provider refused as malformed never falls back.';

export class ChainError extends Error {}

/** Add a model to the end of the chain. Refuses a repeat, a name without its provider, and a sixth. */
export function addToChain(chain: string[], ref: string, max: number): string[] {
  const model = ref.trim();
  const slash = model.indexOf('/');
  if (!model) throw new ChainError('Name a model.');
  if (slash <= 0 || slash === model.length - 1) {
    throw new ChainError(`${model} must name the provider too, as provider/model.`);
  }
  if (chain.includes(model)) throw new ChainError(`${model} is already in the list.`);
  if (chain.length >= max) throw new ChainError(`The list may hold at most ${max} models.`);
  return [...chain, model];
}

/** Move the model at `index` one place up (-1) or down (1). */
export function moveInChain(chain: string[], index: number, by: -1 | 1): string[] {
  const to = index + by;
  if (index < 0 || index >= chain.length || to < 0 || to >= chain.length) return chain;
  const next = [...chain];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function removeFromChain(chain: string[], index: number): string[] {
  return chain.filter((_, i) => i !== index);
}

/** What the providers say about a model's provider. */
export function providerState(
  ref: string,
  providers: ProviderInfo[]
): { tone: Tone; label: string; provider: string } {
  const id = ref.slice(0, Math.max(0, ref.indexOf('/')));
  const p = providers.find((x) => x.id === id);
  if (!p) return { tone: 'err', label: 'Unknown provider', provider: id };
  if (p.ready) return { tone: 'ok', label: p.local ? 'Ready' : 'Key set', provider: p.label };
  return { tone: 'warn', label: p.local ? 'Not running' : 'No key', provider: p.label };
}

/** Every model the providers list, as provider/model, that is not in the chain already. */
export function modelSuggestions(providers: ProviderInfo[], chain: string[]): string[] {
  return providers.flatMap((p) => p.models.map((m) => m.ref)).filter((r) => !chain.includes(r));
}

export const sameChain = (a: string[], b: string[]) =>
  a.length === b.length && a.every((m, i) => m === b[i]);

/** The editor, without the gateway: the chain as it stands, the draft, and what to do with it. */
export function ChainEditor({
  saved,
  draft,
  defaultRef,
  max,
  providers,
  busy,
  error,
  onChange,
  onSave,
  onReset,
}: {
  saved: string[];
  draft: string[];
  defaultRef: string;
  max: number;
  providers: ProviderInfo[];
  busy: boolean;
  error: string | null;
  onChange: (next: string[]) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const [model, setModel] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const changed = !sameChain(saved, draft);

  const add = () => {
    try {
      onChange(addToChain(draft, model, max));
      setModel('');
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof ChainError ? e.message : errorMessage(e));
    }
  };

  return (
    <>
      <p className="page-hint">{FALLBACK_WARNING}</p>
      <p className="page-hint">
        {FALLBACK_WHEN} {FALLBACK_STRICT}
      </p>
      {draft.length ? (
        <ol className="settings-chain" aria-label="Fallback models, in order">
          <li className="settings-chain-default">
            <span className="settings-chain-index">Default</span>
            <code>{defaultRef}</code>
          </li>
          {draft.map((ref, i) => {
            const state = providerState(ref, providers);
            return (
              <li key={ref}>
                <span className="settings-chain-index">{i + 1}</span>
                <code>{ref}</code>
                <span className="page-hint">{state.provider}</span>
                <StatusTag tone={state.tone}>{state.label}</StatusTag>
                <span className="settings-chain-actions">
                  <IconButton
                    icon={ArrowUp}
                    label={`Move ${ref} up`}
                    size="sm"
                    disabled={i === 0}
                    onClick={() => onChange(moveInChain(draft, i, -1))}
                  />
                  <IconButton
                    icon={ArrowDown}
                    label={`Move ${ref} down`}
                    size="sm"
                    disabled={i === draft.length - 1}
                    onClick={() => onChange(moveInChain(draft, i, 1))}
                  />
                  <IconButton
                    icon={Trash2}
                    label={`Remove ${ref}`}
                    size="sm"
                    onClick={() => onChange(removeFromChain(draft, i))}
                  />
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="settings-chain-empty">
          No fallback models. If <code>{defaultRef}</code> is unavailable, the call fails.
        </p>
      )}
      <div className="settings-inline">
        <Input
          label="Add a fallback model"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          list="fallback-model-options"
          placeholder="provider/model"
          error={problem}
          hint={`Up to ${max}. The provider is the part before the slash.`}
          mono
          autoComplete="off"
          disabled={draft.length >= max}
        />
        <datalist id="fallback-model-options">
          {modelSuggestions(providers, draft).map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <Button icon={Plus} onClick={add} disabled={!model.trim() || draft.length >= max}>
          Add
        </Button>
      </div>
      {error && (
        <p className="settings-chain-error" role="alert">
          {error}
        </p>
      )}
      <div className="page-row">
        <Button variant="primary" icon={Save} busy={busy} disabled={!changed} onClick={onSave}>
          Save fallback models
        </Button>
        <Button variant="ghost" disabled={!changed || busy} onClick={onReset}>
          Discard changes
        </Button>
      </div>
    </>
  );
}

export function FallbackSection() {
  const client = useClient();
  const toast = useToast();
  const routing = useResource('routing', () => client.routing(), { on: ['health'] });
  const providers = useProviders();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A newer answer replaces an untouched draft; an edited one is left alone.
  const saved = routing.data?.fallback;
  useEffect(() => {
    setDraft((d) => (d === null || (saved && sameChain(d, saved)) ? null : d));
  }, [saved]);

  const save = async (list: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await client.setRouting(list);
      setDraft(null);
      await routing.reload();
      toast({
        message: list.length ? 'Saved. Fallback models are in use.' : 'Saved. No fallback models.',
        tone: 'ok',
      });
    } catch (e) {
      setError(`Couldn’t save the fallback models. ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Fallback models">
      <Loaded resource={routing} what="the fallback models" skeleton="rows">
        {(r) => (
          <ChainEditor
            saved={r.fallback}
            draft={draft ?? r.fallback}
            defaultRef={`${r.default.provider}/${r.default.model}`}
            max={r.maxFallback}
            providers={providers.data?.providers ?? []}
            busy={busy}
            error={error}
            onChange={(next) => {
              setError(null);
              setDraft(next);
            }}
            onSave={() => void save(draft ?? r.fallback)}
            onReset={() => {
              setError(null);
              setDraft(null);
            }}
          />
        )}
      </Loaded>
    </Section>
  );
}

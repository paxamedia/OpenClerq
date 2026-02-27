/**
 * Compact status card for agent core / gateway.
 */
export function StatusCard({
  status,
  provider,
  model,
  version,
  uptime,
  onRetry,
}: {
  status: 'connected' | 'unreachable' | 'unknown';
  provider?: string;
  model?: string;
  version?: string;
  uptime?: number;
  onRetry?: () => void;
}) {
  const statusLabel = status === 'connected' ? 'Connected' : status === 'unreachable' ? 'Unreachable' : '—';
  const statusColor =
    status === 'connected' ? 'var(--success)' : status === 'unreachable' ? 'var(--error)' : 'var(--text-muted)';

  const formatUptime = (s: number) => {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };

  return (
    <div className="status-card">
      <div className="status-card__indicator" style={{ backgroundColor: statusColor }} />
      <div className="status-card__body">
        <div className="status-card__row">
          <span className="status-card__label">Gateway</span>
          <span className="status-card__value" style={{ color: statusColor }}>
            {statusLabel}
          </span>
        </div>
        {status === 'connected' && (provider || model) && (
          <div className="status-card__row">
            <span className="status-card__label">LLM</span>
            <span className="status-card__value">
              {provider} · {model}
            </span>
          </div>
        )}
        {version && status === 'connected' && (
          <div className="status-card__row">
            <span className="status-card__label">Version</span>
            <span className="status-card__value">{version}</span>
          </div>
        )}
        {uptime != null && status === 'connected' && (
          <div className="status-card__row">
            <span className="status-card__label">Uptime</span>
            <span className="status-card__value">{formatUptime(uptime)}</span>
          </div>
        )}
      </div>
      {onRetry && status !== 'connected' && (
        <button type="button" className="btn btn-ghost status-card__action" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

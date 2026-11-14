export class SandboxError extends Error {
  readonly code = 'sandbox_error';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * Setting a command up (starting its egress proxy) was stopped by the caller's
 * signal or by the time limit before the command started. `exec` turns it into
 * a result with `cancelled` or `timedOut`; it never reaches a caller.
 */
export class SetupInterrupted extends Error {
  constructor(readonly reason: 'cancelled' | 'timedOut') {
    super(
      reason === 'cancelled'
        ? 'Cancelled before the command started.'
        : 'Out of time before the command started.'
    );
    this.name = 'SetupInterrupted';
  }
}

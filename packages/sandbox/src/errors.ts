export class SandboxError extends Error {
  readonly code = 'sandbox_error';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

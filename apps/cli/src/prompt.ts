/** Reading a token without it landing in the shell's history or on the screen. */

import { CliError, EXIT } from './errors.js';
import type { Io } from './output.js';

const MAX_STDIN = 64 * 1024;

/** All of standard input, as text. Refuses anything long: a token is a line. */
export function readStdin(stdin: Io['stdin']): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    stdin.setEncoding?.('utf8');
    const onData = (chunk: string | Buffer) => {
      text += chunk.toString();
      if (text.length > MAX_STDIN) {
        cleanup();
        reject(new CliError('Standard input is far longer than a token.'));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(text);
    };
    const onError = (e: Error) => {
      cleanup();
      reject(new CliError(`Could not read standard input: ${e.message}`));
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      stdin.pause();
    };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}

/**
 * Ask for a secret on the terminal, without echoing it. Backspace edits, Enter
 * ends, Ctrl-C and Ctrl-D give up. Needs a terminal: without one the answer is
 * to pass `--token-stdin`.
 */
export function readSecret(io: Io, prompt: string): Promise<string> {
  const { stdin } = io;
  if (!stdin.isTTY || !stdin.setRawMode) {
    return Promise.reject(
      new CliError(
        'There is no terminal to ask for the token on. Pass --token-stdin and pipe it in.'
      )
    );
  }
  return new Promise((resolve, reject) => {
    let value = '';
    io.stderr.write(prompt);
    stdin.setRawMode?.(true);
    stdin.setEncoding?.('utf8');
    const finish = (error?: CliError) => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      io.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004')
          return finish(new CliError('Cancelled.', EXIT.interrupted));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where agent CLIs are commonly installed but a GUI-launched process does not
 * look. An app started from the Finder inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin,
 * so a CLI in ~/.local/bin or /opt/homebrew/bin is invisible to it.
 */
export function commonBinDirs(home = os.homedir()): string[] {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(home, '.local', 'bin'),
      path.join(appData, 'npm'),
      path.join(local, 'Programs'),
    ];
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
  ];
}

function isExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an executable by name on PATH, then in the common install locations.
 * Returns its absolute path, or null.
 */
export function locate(name: string, searchPath = process.env.PATH ?? ''): string | null {
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())]
      : [''];
  const dirs = [...searchPath.split(path.delimiter).filter(Boolean), ...commonBinDirs()];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** A tool, as the policy names it, in words. */
export function toolLabel(name: string): string {
  if (name.startsWith('memory.write')) return 'Save a note';
  const labels: Record<string, string> = {
    'fs.read': 'Read a file',
    'fs.list': 'List files',
    'fs.search': 'Search files',
    'fs.write': 'Write a file',
    'fs.edit': 'Edit a file',
    'runtime.shell': 'Run a command',
    'git.status': 'Check changes',
    'git.diff': 'Show changes',
    'git.push': 'Push',
    'memory.search': 'Search saved notes',
    'automation.draft': 'Draft an automation',
    'sessions.spawn': 'Start a sub-agent',
  };
  return labels[name] ?? name;
}

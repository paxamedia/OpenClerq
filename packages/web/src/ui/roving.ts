/**
 * Where focus goes when an arrow, Home or End key is pressed in a row or column
 * of items (tabs, radio options, menu items). Disabled items are skipped and the
 * ends wrap. Returns null for any other key, or when nothing is enabled.
 */
export function nextIndex(
  current: number,
  key: string,
  disabled: boolean[],
  orientation: 'horizontal' | 'vertical'
): number | null {
  const count = disabled.length;
  if (!disabled.some((d) => !d)) return null;
  const [back, forward] =
    orientation === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  const scan = (from: number, step: number) => {
    for (let i = 0, at = from; i < count; i++, at = (at + step + count) % count) {
      if (!disabled[at]) return at;
    }
    return null;
  };
  switch (key) {
    case forward:
      return scan((current + 1) % count, 1);
    case back:
      return scan((current - 1 + count) % count, -1);
    case 'Home':
      return scan(0, 1);
    case 'End':
      return scan(count - 1, -1);
    default:
      return null;
  }
}

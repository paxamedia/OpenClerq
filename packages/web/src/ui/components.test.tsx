import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Play } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Button, IconButton } from './Button';
import { Checkbox, SegmentedControl, Switch } from './Choice';
import { KeyValue, Skeleton } from './Display';
import { Input, Select } from './Field';
import { Dialog } from './Modal';
import { RUN_STATES, RunStatus, runState } from './Status';
import { Table, sortRows, type Column } from './Table';
import { Tabs } from './Tabs';
import { place } from './floating';
import { nextIndex } from './roving';

const html = (node: ReactElement) => renderToStaticMarkup(node);
const noop = () => {};

/** The value of `attr` on the first element that has it after `after` in the markup. */
function attr(markup: string, name: string, after = ''): string | undefined {
  const from = after ? markup.indexOf(after) : 0;
  return new RegExp(`${name}="([^"]*)"`).exec(markup.slice(Math.max(from, 0)))?.[1];
}

describe('nextIndex', () => {
  const none = [false, false, false];

  it('moves along the axis and wraps at the ends', () => {
    expect(nextIndex(0, 'ArrowRight', none, 'horizontal')).toBe(1);
    expect(nextIndex(2, 'ArrowRight', none, 'horizontal')).toBe(0);
    expect(nextIndex(0, 'ArrowLeft', none, 'horizontal')).toBe(2);
    expect(nextIndex(1, 'ArrowDown', none, 'vertical')).toBe(2);
  });

  it('skips disabled items, including for Home and End', () => {
    const middleOff = [false, true, false];
    expect(nextIndex(0, 'ArrowRight', middleOff, 'horizontal')).toBe(2);
    expect(nextIndex(2, 'ArrowLeft', middleOff, 'horizontal')).toBe(0);
    expect(nextIndex(1, 'Home', [true, false, false], 'vertical')).toBe(1);
    expect(nextIndex(0, 'End', [false, false, true], 'vertical')).toBe(1);
  });

  it('ignores other keys, keys for the other axis, and lists with nothing enabled', () => {
    expect(nextIndex(0, 'Enter', none, 'horizontal')).toBeNull();
    expect(nextIndex(0, 'ArrowDown', none, 'horizontal')).toBeNull();
    expect(nextIndex(0, 'ArrowRight', [true, true], 'horizontal')).toBeNull();
  });
});

describe('place', () => {
  const viewport = { width: 1000, height: 800 };
  const tip = { width: 100, height: 40 };

  it('centres below the anchor', () => {
    const at = place({ x: 400, y: 100, width: 60, height: 30 }, tip, 'bottom', viewport);
    expect(at).toEqual({ x: 380, y: 134, side: 'bottom' });
  });

  it('flips above when there is no room below', () => {
    const at = place({ x: 400, y: 750, width: 60, height: 30 }, tip, 'bottom', viewport);
    expect(at.side).toBe('top');
    expect(at.y).toBe(750 - 4 - 40);
  });

  it('aligns to the start or end edge', () => {
    const anchor = { x: 400, y: 100, width: 60, height: 30 };
    expect(place(anchor, tip, 'bottom-start', viewport).x).toBe(400);
    expect(place(anchor, tip, 'bottom-end', viewport).x).toBe(360);
  });

  it('stays 8px inside the window', () => {
    expect(place({ x: 0, y: 100, width: 20, height: 20 }, tip, 'top', viewport).x).toBe(8);
    expect(place({ x: 990, y: 100, width: 10, height: 20 }, tip, 'top', viewport).x).toBe(892);
  });
});

interface Row {
  name: string;
  cost: number | null;
}

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', cell: (r) => r.name, sortValue: (r) => r.name },
  {
    key: 'cost',
    header: 'Cost',
    cell: (r) => String(r.cost),
    sortValue: (r) => r.cost,
    align: 'end',
  },
  { key: 'note', header: 'Note', cell: () => '' },
];

const rows: Row[] = [
  { name: 'run 10', cost: 2 },
  { name: 'run 2', cost: null },
  { name: 'run 1', cost: 5 },
];

describe('sortRows', () => {
  it('sorts text with numbers in natural order', () => {
    const asc = sortRows(rows, columns, { key: 'name', direction: 'asc' });
    expect(asc.map((r) => r.name)).toEqual(['run 1', 'run 2', 'run 10']);
  });

  it('puts empty values last in both directions', () => {
    const desc = sortRows(rows, columns, { key: 'cost', direction: 'desc' });
    expect(desc.map((r) => r.cost)).toEqual([5, 2, null]);
    const asc = sortRows(rows, columns, { key: 'cost', direction: 'asc' });
    expect(asc.map((r) => r.cost)).toEqual([2, 5, null]);
  });

  it('leaves rows as they are for an unsortable column, and does not change the input', () => {
    expect(sortRows(rows, columns, { key: 'note', direction: 'asc' })).toBe(rows);
    sortRows(rows, columns, { key: 'name', direction: 'asc' });
    expect(rows[0].name).toBe('run 10');
  });
});

describe('runState', () => {
  it('names every run state in plain words', () => {
    expect(runState('executing')).toEqual({ label: 'Running', tone: 'accent' });
    expect(runState('awaiting_approval')).toEqual({ label: 'Needs approval', tone: 'warn' });
    expect(runState('failed').tone).toBe('err');
    expect(Object.keys(RUN_STATES)).toHaveLength(10);
  });

  it('shows an unknown state in words, muted', () => {
    expect(runState('waiting_for_lease')).toEqual({ label: 'Waiting for lease', tone: 'muted' });
    expect(html(<RunStatus state="done" />)).toContain('Done');
  });
});

describe('Button', () => {
  it('is a plain button unless told otherwise', () => {
    expect(attr(html(<Button>Save</Button>), 'type')).toBe('button');
  });

  it('is disabled and marked busy while working', () => {
    const markup = html(
      <Button variant="primary" busy>
        Save
      </Button>
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('ui-button--primary');
  });

  it('names an icon button by its label, not twice', () => {
    const markup = html(<IconButton icon={Play} label="Run now" />);
    expect(markup).toContain('aria-label="Run now"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('aria-describedby');
  });
});

describe('fields', () => {
  it('ties the label and hint to the input', () => {
    const markup = html(<Input id="name" label="Name" hint="Shown in the list." />);
    expect(markup).toContain('for="name"');
    expect(attr(markup, 'aria-describedby')).toBe('name-hint');
    expect(markup).not.toContain('aria-invalid');
  });

  it('shows the error in place of the hint and marks the input invalid', () => {
    const markup = html(<Input id="cron" label="Schedule" hint="Cron" error="Use five fields." />);
    expect(markup).toContain('aria-invalid="true"');
    expect(attr(markup, 'aria-describedby')).toBe('cron-error');
    expect(markup).not.toContain('cron-hint');
  });

  it('labels a select', () => {
    const markup = html(
      <Select id="driver" label="Driver">
        <option>Claude Code</option>
      </Select>
    );
    expect(markup).toContain('for="driver"');
    expect(markup).toContain('id="driver"');
  });
});

describe('choices', () => {
  it('reports a switch as on or off', () => {
    const markup = html(<Switch checked label="Enabled" hideLabel onChange={noop} />);
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('ui-sr-only');
  });

  it('wraps a checkbox in its label', () => {
    const markup = html(<Checkbox label="Wait for approval" defaultChecked />);
    expect(markup).toMatch(/<label[^>]*>.*type="checkbox".*Wait for approval.*<\/label>/);
  });

  it('makes only the chosen segment reachable by Tab', () => {
    const markup = html(
      <SegmentedControl
        label="Range"
        value="7d"
        onChange={noop}
        options={[
          { value: '24h', label: '24 h' },
          { value: '7d', label: '7 d' },
        ]}
      />
    );
    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup.indexOf('aria-checked="true"')).toBeGreaterThan(markup.indexOf('24 h'));
  });
});

describe('Tabs', () => {
  it('selects one tab and labels the panel with it', () => {
    const markup = html(
      <Tabs
        label="Automation"
        value="runs"
        onChange={noop}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'runs', label: 'Runs', count: 12 },
        ]}
      >
        Panel
      </Tabs>
    );
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
    const selectedId = /id="([^"]+)"[^>]*aria-selected="true"/.exec(markup)?.[1];
    expect(selectedId).toBeTruthy();
    expect(attr(markup, 'aria-labelledby', 'role="tabpanel"')).toBe(selectedId);
    expect(markup).toContain('>12<');
  });

  it('keeps one tab reachable when the value matches none', () => {
    const markup = html(
      <Tabs
        label="Automation"
        value="gone"
        onChange={noop}
        items={[{ value: 'overview', label: 'Overview' }]}
      />
    );
    expect(markup).toContain('tabindex="0"');
  });
});

describe('Table', () => {
  it('starts in the given order and says so', () => {
    const markup = html(
      <Table
        label="Runs"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        initialSort={{ key: 'cost', direction: 'desc' }}
      />
    );
    expect(markup).toContain('aria-sort="descending"');
    expect(markup).toContain('aria-sort="none"');
    expect(markup.indexOf('run 1<')).toBeLessThan(markup.indexOf('run 10<'));
    expect(markup.indexOf('run 10<')).toBeLessThan(markup.indexOf('run 2<'));
    expect(markup).not.toContain('tabindex');
  });

  it('marks the open row as current', () => {
    const markup = html(
      <Table
        label="Runs"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        selectedKey="run 2"
      />
    );
    expect(markup.match(/aria-current="true"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-selected');
  });

  it('makes rows reachable when they open something, and shows the empty state', () => {
    expect(
      html(
        <Table
          label="Runs"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.name}
          onRowClick={noop}
        />
      )
    ).toContain('tabindex="0"');
    expect(
      html(
        <Table
          label="Runs"
          columns={columns}
          rows={[]}
          rowKey={(r) => r.name}
          empty="No runs yet."
        />
      )
    ).toContain('No runs yet.');
  });
});

describe('display', () => {
  it('shows a dash for an empty value', () => {
    const markup = html(<KeyValue items={[{ label: 'Branch', value: null }]} />);
    expect(markup).toContain('—');
  });

  it('announces loading once and hides the shapes', () => {
    const markup = html(<Skeleton count={3} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Loading');
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(3);
  });
});

describe('Dialog', () => {
  it('labels itself with its title and renders nothing inside while closed', () => {
    const open = html(
      <Dialog open title="Delete automation?" description="Its runs are kept." onClose={noop} />
    );
    const titleId = /<h2 id="([^"]+)"/.exec(open)?.[1];
    expect(attr(open, 'aria-labelledby')).toBe(titleId);
    expect(open).toContain('Its runs are kept.');
    const closed = html(<Dialog open={false} title="Delete automation?" onClose={noop} />);
    expect(closed).not.toContain('Delete automation?');
  });
});

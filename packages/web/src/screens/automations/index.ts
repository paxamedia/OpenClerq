/**
 * Automations as a module: it adds its rail entry, palette commands and search
 * through the slot contract, so the app works without it.
 */

import { Play, Plus, Workflow } from 'lucide-react';
import { loadAutomations } from '../../app/data';
import type { ModuleUI, PaletteCommand } from '../../app/modules';
import { AutomationsScreen } from './Automations';

export const AUTOMATIONS_ID = 'automations';

export const automationsModule: ModuleUI = {
  id: AUTOMATIONS_ID,
  name: 'Automations',
  description: 'Scheduled agent runs that end in a draft pull request.',
  icon: Workflow,
  rail: [
    {
      id: AUTOMATIONS_ID,
      label: 'Automations',
      icon: Workflow,
      path: `/m/${AUTOMATIONS_ID}`,
      order: 10,
    },
  ],
  component: AutomationsScreen,
  commands: ({ navigate, base }) => [
    {
      id: 'automations:new',
      label: 'New automation',
      icon: Plus,
      keywords: 'create add',
      run: () => navigate(`${base}/new`),
    },
  ],
  search: async (query, { client, navigate, base }) => {
    const q = query.toLowerCase();
    const list = await loadAutomations(client);
    const out: PaletteCommand[] = [];
    for (const a of list) {
      if (!`${a.name} ${a.description ?? ''}`.toLowerCase().includes(q)) continue;
      out.push({
        id: `automation:${a.id}`,
        label: a.name,
        hint: 'Automation',
        icon: Workflow,
        run: () => navigate(`${base}/${encodeURIComponent(a.id)}`),
      });
      if (!a.problem && !a.running) {
        out.push({
          id: `automation-run:${a.id}`,
          label: `Run ${a.name} now`,
          hint: 'Action',
          icon: Play,
          run: () => {
            void client
              .runAutomation(a.id)
              .then(({ runId }) => navigate(`/runs/${encodeURIComponent(runId)}`));
          },
        });
      }
    }
    // Runs by id, as pasted from a log or a pull request.
    if (/^run[-_]/i.test(query) || query.length >= 6) {
      const { runs } = await client.runs(200);
      for (const r of runs.filter((r) => r.id.toLowerCase().startsWith(q)).slice(0, 5)) {
        out.push({
          id: `run:${r.id}`,
          label: `Run ${r.id}`,
          hint: r.automationName ?? 'Run',
          run: () => navigate(`/runs/${encodeURIComponent(r.id)}`),
        });
      }
    }
    return out;
  },
};

/**
 * Modules that are not bundled with the app: those the gateway runs, drawn in a
 * frame from their own UI, and folders the desktop found with only a manifest.
 */

import { Blocks, TriangleAlert } from 'lucide-react';
import type { ExtensionItem, ModuleInfo } from '@clerq/gateway-client';
import { moduleBase, type ModuleProps, type ModuleUI, type RailEntry } from '../app/modules';
import { EmptyState, Page, PageHeader } from '../shell/layout';
import { ModuleFrame } from '../shell/ModuleFrame';

/** A module folder with only its manifest: a rail entry and a page that says what it is. */
export function installedModule(m: {
  id: string;
  name: string;
  version: string;
  description?: string;
}): ModuleUI {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    icon: Blocks,
    placeholder: true,
    rail: [
      { id: m.id, label: m.name, icon: Blocks, path: moduleBase(m.id), order: 60, secondary: true },
    ],
    component: () => (
      <Page>
        <PageHeader crumbs={[{ label: m.name }]} />
        <EmptyState icon={Blocks} title={`${m.name} ${m.version}`}>
          {m.description ?? 'This module has no screen in this version of OpenClerq.'}
        </EmptyState>
      </Page>
    ),
  };
}

/** The path inside the module's UI that a shell route points at. */
export function innerPath({ parts, route }: Pick<ModuleProps, 'parts' | 'route'>): string {
  const q = route.query.toString();
  return `/${parts.map(encodeURIComponent).join('/')}${q ? `?${q}` : ''}`;
}

/**
 * The same module object while nothing about it changes, so a refetch (a badge,
 * a service starting) does not remount its page and reload its frame.
 */
const cache = new Map<string, { sig: string; ui: ModuleUI }>();

/** A module the gateway runs: its `nav` extensions become rail entries, its UI the page. */
export function gatewayModule(info: ModuleInfo, nav: ExtensionItem[]): ModuleUI {
  const sig = JSON.stringify([info.name, info.version, info.status, info.error, info.ui, nav]);
  const hit = cache.get(info.id);
  if (hit?.sig === sig) return hit.ui;
  const ui = buildGatewayModule(info, nav);
  cache.set(info.id, { sig, ui });
  return ui;
}

function buildGatewayModule(info: ModuleInfo, nav: ExtensionItem[]): ModuleUI {
  const base = moduleBase(info.id);
  const entries: RailEntry[] = (
    nav.length ? nav : [{ moduleId: info.id, id: 'main', title: info.name, path: '/' }]
  )
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
    .map((n, i) => {
      const inner = (n.path ?? '/').replace(/^\/+/, '');
      return {
        id: i === 0 ? info.id : `${info.id}:${n.id}`,
        label: n.title ?? info.name,
        icon: Blocks,
        path: inner ? `${base}/${inner}` : base,
        order: 60 + i,
        secondary: true,
      };
    });
  return {
    id: info.id,
    name: info.name,
    description: info.version ? `Version ${info.version}` : undefined,
    icon: Blocks,
    rail: entries,
    component: (props) => {
      if (info.status === 'failed') {
        return (
          <Page>
            <PageHeader crumbs={[{ label: info.name }]} />
            <EmptyState icon={TriangleAlert} title={`${info.name} didn’t start`}>
              {info.error ?? 'Check the background service’s log under Developer.'}
            </EmptyState>
          </Page>
        );
      }
      if (!info.ui) {
        return (
          <Page>
            <PageHeader crumbs={[{ label: info.name }]} />
            <EmptyState icon={Blocks} title={`${info.name} has no screen`}>
              It works in the background: its records, inbox items and Home tiles appear where they
              belong.
            </EmptyState>
          </Page>
        );
      }
      return (
        <Page className="module-page">
          <PageHeader crumbs={[{ label: info.name }]} />
          <ModuleFrame moduleId={info.id} path={innerPath(props)} title={info.name} />
        </Page>
      );
    },
  };
}

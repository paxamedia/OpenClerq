/** What a bundled plugin's page says instead of drawing, while it waits for a client or may not run. */

import { Blocks } from 'lucide-react';
import type { PluginAccess } from '../app/plugin-access';
import { EmptyState, Page, PageHeader, PageSkeleton } from '../shell/layout';

export function PluginNotice({
  name,
  access,
}: {
  name: string;
  access: Exclude<PluginAccess, { status: 'ready' }>;
}) {
  if (access.status === 'loading') return <PageSkeleton />;
  return (
    <Page>
      <PageHeader crumbs={[{ label: name }]} />
      <EmptyState
        icon={Blocks}
        title={`${name} is not running`}
        actions={
          <a className="page-link" href="#/settings/plugins">
            Open Settings → Plugins
          </a>
        }
      >
        {access.reason}
      </EmptyState>
    </Page>
  );
}

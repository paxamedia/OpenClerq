import { MapPinOff } from 'lucide-react';
import { Link } from '../app/router';
import { EmptyState, Page, PageHeader } from '../shell/layout';

export function NotFound({ what = 'page' }: { what?: 'page' | 'module' }) {
  return (
    <Page>
      <PageHeader crumbs={[{ label: what === 'module' ? 'Module not found' : 'Page not found' }]} />
      <EmptyState
        icon={MapPinOff}
        title={what === 'module' ? 'This module isn’t installed' : 'Nothing is here'}
        actions={
          <Link className="page-link" to="/">
            Go to Home
          </Link>
        }
      >
        {what === 'module'
          ? 'Install or turn it on in Settings, then open the link again.'
          : 'The link may be from an older version.'}
      </EmptyState>
    </Page>
  );
}

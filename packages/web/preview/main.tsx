/**
 * The interface over the fixture client, for working on screens without a
 * gateway and for `pnpm ui:shots`. Development only; nothing here ships.
 *
 * ?fixture=empty shows the empty states, ?fixture=offline the error states,
 * ?theme=light|dark forces a theme.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { automationsModule, OpenClerqApp, type AppConfig, type Host } from '../src';
// The chat console is a plugin package that depends on this one, so it is imported by path and not
// as a dependency (which would make the two depend on each other).
import { chatPlugin } from '../../plugin-chat/src';
import { createFixtureClient } from '../src/fixtures';

const params = new URLSearchParams(location.search);
const fixture = params.get('fixture');
const client = createFixtureClient({ empty: fixture === 'empty', offline: fixture === 'offline' });

let config: AppConfig = {};
const host: Host = {
  kind: 'web',
  version: '0.6.0',
  openUrl: (url) => window.open(url, '_blank', 'noopener'),
  readConfig: async () => config,
  writeConfig: async (c) => {
    config = c;
  },
  saveApiKey: async () => undefined,
  checkForUpdates: async () => 'up-to-date',
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OpenClerqApp client={client} host={host} modules={[automationsModule, chatPlugin]} />
  </React.StrictMode>
);

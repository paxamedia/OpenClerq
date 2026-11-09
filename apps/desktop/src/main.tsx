/**
 * The desktop app: the OpenClerq screens over the local gateway, with the
 * bundled modules and any installed from module folders.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { installedModule, OpenClerqApp, type AppConfig, type ModuleUI } from '@clerq/web';
import { gateway, initGatewayAuth, setGatewayBaseUrl } from './gateway';
import { desktopHost, readConfig } from './host';
import { loadModules } from './moduleLoader';
import { renderModule } from './ModuleHost';
import { BUNDLED_MODULES, isTurnedOff } from './bundled';

async function start() {
  const config = await readConfig().catch((): AppConfig => ({}));
  if (config.settings?.gatewayUrl) setGatewayBaseUrl(config.settings.gatewayUrl);
  // The gateway writes its token on first start; on a cold launch this waits for it.
  await initGatewayAuth().catch(() => false);

  const modules: ModuleUI[] = BUNDLED_MODULES.filter((m) => !isTurnedOff(config, m)).map(
    (m) => m.ui
  );
  if (config.modulePaths?.length) {
    const { loaded, errors } = await loadModules(config.modulePaths);
    if (errors.length) console.warn('[OpenClerq] Modules that did not load:', errors);
    for (const manifest of loaded) {
      if (!modules.some((m) => m.id === manifest.id)) modules.push(installedModule(manifest));
    }
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <OpenClerqApp
        client={gateway}
        host={desktopHost}
        modules={modules}
        renderModule={renderModule}
      />
    </React.StrictMode>
  );
}

void start();

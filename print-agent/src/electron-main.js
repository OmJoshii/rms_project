'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  app,
  Tray,
  Menu,
  shell,
  nativeImage,
  BrowserWindow,
  ipcMain,
} = require('electron');
const { loadConfig, resolveConfigPath } = require('./config');
const { createRelayServer } = require('./relay');
const { createOdooPrintPoller, pairOdooDevice } = require('./odoo-client');

let tray = null;
let relay = null;
let poller = null;
let mainWindow = null;
let currentConfigPath = null;
let currentConfig = null;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function readRelayJson(route) {
  return new Promise((resolve, reject) => {
    if (!currentConfig) {
      reject(new Error('Relay configuration is not ready'));
      return;
    }

    const req = http.get({
      hostname: currentConfig.bindHost,
      port: currentConfig.bindPort,
      path: route,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Relay returned HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (_) {
          reject(new Error('Relay returned invalid JSON'));
        }
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error('Relay request timed out')));
    req.on('error', reject);
  });
}

function ensureConfigFile() {
  const configPath = resolveConfigPath(process.env.RMS_AGENT_CONFIG);
  if (fs.existsSync(configPath)) return configPath;

  const examplePath = path.join(app.getAppPath(), 'config.example.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.copyFileSync(examplePath, configPath);
  return configPath;
}

function makeTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="10" y="12" width="44" height="26" rx="4" fill="#111827"/>
      <rect x="16" y="18" width="32" height="6" rx="2" fill="#ffffff"/>
      <rect x="16" y="28" width="20" height="3" rx="1.5" fill="#d1d5db"/>
      <rect x="16" y="38" width="32" height="6" rx="2" fill="#111827"/>
      <circle cx="46" cy="48" r="6" fill="#8b1a1a"/>
    </svg>`;
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg)
  );
}

function buildTrayMenu(configPath, config) {
  return Menu.buildFromTemplate([
    {
      label: 'Open Config',
      click: async () => {
        await shell.openPath(configPath);
      },
    },
    {
      label: 'Open Health Check',
      click: async () => {
        await shell.openExternal(`http://${config.bindHost}:${config.bindPort}/health`);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);
}

async function restartRelayWithConfig(config) {
  if (poller) {
    await poller.stop().catch(() => {});
  }
  if (relay) {
    await relay.stop().catch(() => {});
  }
  relay = createRelayServer(config);
  await relay.start();
  poller = createOdooPrintPoller(config, relay);
  poller.start();
  currentConfig = config;

  if (tray) {
    tray.setContextMenu(buildTrayMenu(currentConfigPath, config));
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
    mainWindow = null;
  }

  createMainWindow(currentConfigPath, config);
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function renderWindowHtml(configPath, config) {
  const healthUrl = `http://${config.bindHost}:${config.bindPort}/health`;
  const statusUrl = `http://${config.bindHost}:${config.bindPort}/status`;
  const initialConfig = JSON.stringify({
    printerMode: config.printerMode || 'tcp',
    printerIp: config.printerIp || '',
    printerPort: config.printerPort || 9100,
    bindHost: config.bindHost || '127.0.0.1',
    bindPort: config.bindPort || 17333,
    restaurantName: config.restaurantName || 'Restaurant',
    printTimeoutMs: config.printTimeoutMs || 5000,
    printRetries: config.printRetries != null ? config.printRetries : 2,
    odooUrl: config.odooUrl || '',
    deviceName: config.deviceName || '',
    paired: !!config.deviceToken,
  });
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>RMS Print Relay</title>
      <style>
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #0f172a;
          color: #e5e7eb;
        }
        .wrap {
          padding: 24px;
        }
        .panel {
          background: #111827;
          border: 1px solid #243041;
          border-radius: 14px;
          padding: 20px;
          max-width: 640px;
        }
        h1 {
          margin: 0 0 8px;
          font-size: 20px;
        }
        p {
          margin: 0 0 12px;
          color: #cbd5e1;
          line-height: 1.5;
        }
        code {
          background: #0b1220;
          padding: 2px 6px;
          border-radius: 6px;
        }
        .row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 16px;
        }
        button {
          appearance: none;
          border: 0;
          background: #8b1a1a;
          color: white;
          padding: 10px 14px;
          border-radius: 10px;
          font: inherit;
          cursor: pointer;
        }
        button.secondary {
          background: #1f2937;
        }
        .meta {
          margin-top: 18px;
          font-size: 13px;
          color: #94a3b8;
        }
        .status {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 14px 0 12px;
          padding: 10px 12px;
          border-radius: 999px;
          background: #0b1220;
          border: 1px solid #243041;
          font-size: 14px;
          font-weight: 600;
        }
        .status-dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          background: #64748b;
          box-shadow: 0 0 0 4px rgba(100, 116, 139, 0.16);
        }
        .status-dot.ok {
          background: #22c55e;
          box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.18);
        }
        .status-dot.bad {
          background: #ef4444;
          box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.16);
        }
        .status-dot.warn {
          background: #f59e0b;
          box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.16);
        }
        .status-block {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 10px;
        }
        .status-label {
          font-size: 13px;
          color: #94a3b8;
          min-width: 72px;
        }
        .debug {
          margin-top: 18px;
          border-top: 1px solid #243041;
          padding-top: 14px;
        }
        .debug h2 {
          margin: 0 0 8px;
          font-size: 14px;
          color: #cbd5e1;
        }
        .debug-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          gap: 8px;
          max-height: 260px;
          overflow: auto;
        }
        .debug-item {
          background: #0b1220;
          border: 1px solid #243041;
          border-radius: 10px;
          padding: 8px 10px;
          font-size: 12px;
          color: #dbe4f0;
          line-height: 1.4;
        }
        .debug-meta {
          display: block;
          color: #94a3b8;
          font-size: 11px;
          margin-bottom: 2px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .settings {
          margin-top: 18px;
          border-top: 1px solid #243041;
          padding-top: 14px;
          display: grid;
          gap: 10px;
        }
        .settings h2 {
          margin: 0;
          font-size: 14px;
          color: #cbd5e1;
        }
        .settings-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .field {
          display: grid;
          gap: 6px;
        }
        .field.full {
          grid-column: 1 / -1;
        }
        .field label {
          font-size: 11px;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: .4px;
          font-weight: 700;
        }
        .field input, .field select {
          background: #0b1220;
          border: 1px solid #243041;
          color: #e5e7eb;
          border-radius: 10px;
          padding: 10px 12px;
          font: inherit;
          outline: none;
        }
        .field input:focus, .field select:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, .16);
        }
        .help {
          font-size: 12px;
          color: #94a3b8;
          line-height: 1.4;
        }
        .status-line {
          margin-top: 12px;
          padding: 10px 12px;
          border: 1px solid #334155;
          border-radius: 8px;
          background: #0b1220;
          font-size: 13px;
          color: #cbd5e1;
          line-height: 1.4;
        }
        .status-line:empty {
          display: none;
        }
        .status-line.ok {
          border-color: #166534;
          color: #bbf7d0;
        }
        .status-line.warn {
          border-color: #92400e;
          color: #fde68a;
        }
        .status-line.bad {
          border-color: #991b1b;
          color: #fecaca;
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="panel">
          <h1>RMS Print Relay</h1>
          <p>The relay is running on this laptop and can print to the Epson over raw port 9100.</p>
          <div class="status-block">
            <span class="status-label">Relay</span>
            <div class="status">
              <span class="status-dot warn" id="relay-status-dot"></span>
              <span id="relay-status-text">Checking relay...</span>
            </div>
          </div>
          <div class="status-block">
            <span class="status-label">Odoo</span>
            <div class="status">
              <span class="status-dot warn" id="odoo-status-dot"></span>
              <span id="odoo-status-text">Checking queue...</span>
            </div>
          </div>
          <div class="status-block">
            <span class="status-label">Printer</span>
            <div class="status">
              <span class="status-dot warn" id="printer-status-dot"></span>
              <span id="printer-status-text">Checking printer...</span>
            </div>
          </div>
          <p><strong>Relay:</strong> <code>${healthUrl}</code></p>
          <p><strong>Status:</strong> <code>${statusUrl}</code></p>
          <p><strong>Printer:</strong> <code>${config.printerIp}:${config.printerPort}</code></p>
          <div class="row">
            <button onclick="window.printRelay.openHealth()">Open Health Check</button>
            <button class="secondary" onclick="window.printRelay.openConfig()">Open Config</button>
            <button class="secondary" onclick="window.printRelay.hide()">Hide to Tray</button>
          </div>
          <div class="debug">
            <h2>Live Debug</h2>
            <ul class="debug-list" id="debug-list">
              <li class="debug-item">Waiting for events...</li>
            </ul>
          </div>
          <div class="settings">
            <h2>Odoo Print Queue</h2>
            <div class="settings-grid">
              <div class="field full">
                <label for="odoo-url">Odoo URL</label>
                <input id="odoo-url" type="url" placeholder="https://demo.bhoj.cloud" />
              </div>
              <div class="field full">
                <label for="pairing-code">Pairing Code</label>
                <input id="pairing-code" type="text" maxlength="8" placeholder="Enter the 8-character KDS code" />
              </div>
            </div>
            <div class="help" id="pairing-help">Generate a pairing code from KDS → Print Queue.</div>
            <div class="status-line" id="pairing-status" role="status" aria-live="polite"></div>
            <div class="row">
              <button id="pair-odoo-btn">Pair with Odoo</button>
            </div>
          </div>
          <div class="settings">
            <h2>Printer Mode</h2>
            <div class="settings-grid">
              <div class="field full">
                <label for="mode-select">Mode</label>
                <select id="mode-select">
                  <option value="tcp">Real Epson over 9100</option>
                  <option value="mock">Local mock printer</option>
                </select>
              </div>
              <div class="field">
                <label for="printer-ip">Printer IP</label>
                <input id="printer-ip" type="text" placeholder="10.1.10.118" />
              </div>
              <div class="field">
                <label for="printer-port">Printer Port</label>
                <input id="printer-port" type="number" min="1" max="65535" />
              </div>
            </div>
            <div class="help">
              Mock mode starts a local simulator on <code>127.0.0.1:9100</code> so you can trace order handling without the Epson attached.
            </div>
            <div class="row">
              <button class="secondary" id="save-settings-btn">Save & Restart</button>
            </div>
            <div class="status-line" id="settings-status"></div>
          </div>
          <div class="meta">The tray icon stays available for quick access.</div>
        </div>
      </div>
      <script>
        const initialConfig = ${initialConfig};
        const healthUrl = ${JSON.stringify(healthUrl)};
        const statusUrl = ${JSON.stringify(statusUrl)};
        const debugUrl = statusUrl.replace(/\\/status$/, '/debug');
        const statusDot = document.getElementById('relay-status-dot');
        const statusText = document.getElementById('relay-status-text');
        const printerStatusDot = document.getElementById('printer-status-dot');
        const printerStatusText = document.getElementById('printer-status-text');
        const odooStatusDot = document.getElementById('odoo-status-dot');
        const odooStatusText = document.getElementById('odoo-status-text');
        const debugList = document.getElementById('debug-list');
        const modeSelect = document.getElementById('mode-select');
        const printerIpInput = document.getElementById('printer-ip');
        const printerPortInput = document.getElementById('printer-port');
        const settingsStatus = document.getElementById('settings-status');
        const saveSettingsBtn = document.getElementById('save-settings-btn');
        const odooUrlInput = document.getElementById('odoo-url');
        const pairingCodeInput = document.getElementById('pairing-code');
        const pairOdooBtn = document.getElementById('pair-odoo-btn');
        const pairingStatus = document.getElementById('pairing-status');
        const pairingHelp = document.getElementById('pairing-help');
        let refreshTimer = null;

        function setStatus(kind, text) {
          statusDot.className = 'status-dot ' + kind;
          statusText.textContent = text;
        }

        function setPrinterStatus(kind, text) {
          printerStatusDot.className = 'status-dot ' + kind;
          printerStatusText.textContent = text;
        }

        function setOdooStatus(kind, text) {
          odooStatusDot.className = 'status-dot ' + kind;
          odooStatusText.textContent = text;
        }

        function setPairingStatus(kind, text) {
          pairingStatus.className = 'status-line ' + kind;
          pairingStatus.textContent = text;
        }

        async function refreshRelayStatus() {
          try {
            const data = await window.printRelay.getHealth();
            if (!data || !data.ok) throw new Error('Relay is not ready');
            setStatus('ok', 'Running');
          } catch (err) {
            setStatus('bad', 'Offline');
          }
        }

        async function refreshPrinterStatus() {
          try {
            const data = await window.printRelay.getStatus();
            if (data.odoo && data.odoo.connected) {
              setOdooStatus('ok', 'Connected · ' + (data.odoo.deviceName || data.odoo.url));
            } else if (data.odoo && data.odoo.configured) {
              setOdooStatus('bad', 'Offline' + (data.odoo.error ? ' (' + data.odoo.error + ')' : ''));
            } else {
              setOdooStatus('warn', 'Not paired');
            }
            if (data.printer && data.printer.ok) {
              setPrinterStatus('ok', 'Connected · ' + data.printer.ip + ':' + data.printer.port);
            } else {
              const error = data.printer && data.printer.error ? ' (' + data.printer.error + ')' : '';
              setPrinterStatus('bad', 'Not reachable' + error);
            }
          } catch (err) {
            setPrinterStatus('bad', 'Not reachable');
            setOdooStatus('bad', 'Status unavailable');
          }
        }

        async function refreshDebugFeed() {
          try {
            const data = await window.printRelay.getDebug();
            const events = Array.isArray(data.events) ? data.events : [];
            if (!events.length) {
              debugList.innerHTML = '<li class="debug-item">No debug events yet.</li>';
              return;
            }
            const escapeHtml = (value) => String(value).replace(/[<&>]/g, function (ch) {
              return ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[ch];
            });
            debugList.innerHTML = events.slice(0, 20).map((event) => {
              const parts = [];
              parts.push('<span class="debug-meta">' + escapeHtml((event.ts || '') + ' · ' + (event.type || 'event')) + '</span>');
              parts.push(escapeHtml(event.message || ''));
              if (event.data) {
                parts.push('<br><span class="debug-meta">' + escapeHtml(JSON.stringify(event.data, null, 2)) + '</span>');
              }
              return '<li class="debug-item">' + parts.join('') + '</li>';
            }).join('');
          } catch (_) {
            debugList.innerHTML = '<li class="debug-item">Debug feed unavailable.</li>';
          }
        }

        function syncSettingsForm() {
          modeSelect.value = initialConfig.printerMode || 'tcp';
          printerIpInput.value = initialConfig.printerIp || '';
          printerPortInput.value = initialConfig.printerPort || 9100;
          odooUrlInput.value = initialConfig.odooUrl || '';
          pairingHelp.textContent = initialConfig.paired
            ? 'Paired as ' + (initialConfig.deviceName || 'Kitchen Printer') + '. Generate a new code to replace this pairing.'
            : 'Generate a pairing code from KDS → Print Queue.';
        }

        async function pairWithOdoo() {
          const odooUrl = odooUrlInput.value.trim().replace(/\\/+$/, '');
          const pairingCode = pairingCodeInput.value.trim().toUpperCase();
          if (!/^https?:\\/\\//i.test(odooUrl)) {
            setPairingStatus('bad', 'Enter the full Odoo URL, including https://');
            odooUrlInput.focus();
            return;
          }
          if (!/^[A-Z2-9]{8}$/.test(pairingCode)) {
            setPairingStatus('bad', 'Enter the current 8-character code from KDS Print Queue.');
            pairingCodeInput.focus();
            return;
          }
          if (!window.printRelay || typeof window.printRelay.pairOdoo !== 'function') {
            setPairingStatus('bad', 'Desktop bridge unavailable. Quit the relay completely and reopen the latest build.');
            return;
          }

          pairingCodeInput.value = pairingCode;
          setPairingStatus('warn', 'Contacting Odoo and exchanging the pairing code...');
          setOdooStatus('warn', 'Pairing...');
          pairOdooBtn.disabled = true;
          try {
            const result = await window.printRelay.pairOdoo({
              odooUrl,
              pairingCode,
            });
            setPairingStatus('ok', 'Paired as ' + result.deviceName + '. Restarting the relay...');
            setOdooStatus('ok', 'Paired · restarting...');
          } catch (err) {
            const message = err && err.message ? err.message : String(err);
            setPairingStatus('bad', 'Pairing failed: ' + message);
            setOdooStatus('bad', 'Pairing failed');
          } finally {
            pairOdooBtn.disabled = false;
          }
        }

        async function saveSettings() {
          const next = {
            printerMode: modeSelect.value,
            printerIp: printerIpInput.value.trim(),
            printerPort: Number(printerPortInput.value) || 9100,
            bindHost: initialConfig.bindHost,
            bindPort: initialConfig.bindPort,
            restaurantName: initialConfig.restaurantName,
            printTimeoutMs: initialConfig.printTimeoutMs,
            printRetries: initialConfig.printRetries,
          };
          settingsStatus.textContent = 'Saving...';
          saveSettingsBtn.disabled = true;
          try {
            await window.printRelay.saveConfig(next);
            settingsStatus.textContent = 'Saved. Restarting the relay...';
          } catch (err) {
            settingsStatus.textContent = 'Save failed: ' + (err && err.message ? err.message : err);
          } finally {
            saveSettingsBtn.disabled = false;
          }
        }

        window.addEventListener('DOMContentLoaded', () => {
          syncSettingsForm();
          setStatus('warn', 'Checking...');
          setPrinterStatus('warn', 'Checking...');
          setOdooStatus('warn', 'Checking...');
          refreshRelayStatus();
          refreshPrinterStatus();
          refreshDebugFeed();
          modeSelect.addEventListener('change', () => {
            if (modeSelect.value === 'mock') {
              printerIpInput.value = '127.0.0.1';
              printerPortInput.value = 9100;
            } else if (!printerIpInput.value.trim()) {
              printerIpInput.value = initialConfig.printerIp || '';
            }
          });
          saveSettingsBtn.addEventListener('click', saveSettings);
          pairOdooBtn.addEventListener('click', pairWithOdoo);
          pairingCodeInput.addEventListener('input', () => {
            pairingCodeInput.value = pairingCodeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8);
          });
          refreshTimer = setInterval(() => {
            refreshRelayStatus();
            refreshPrinterStatus();
            refreshDebugFeed();
          }, 3000);
        });
        window.addEventListener('beforeunload', () => {
          if (refreshTimer) clearInterval(refreshTimer);
        });
      </script>
    </body>
  </html>`;
}

function createMainWindow(configPath, config) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 700,
    minHeight: 560,
    resizable: true,
    minimizable: true,
    maximizable: false,
    show: false,
    title: 'RMS Print Relay',
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const healthUrl = `http://${config.bindHost}:${config.bindPort}/health`;
  const html = renderWindowHtml(configPath, config);
  mainWindow.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(html)
  );

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.meta && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

async function main() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  process.env.RMS_AGENT_CONFIG = configPath;
  ensureConfigFile();
  const config = loadConfig({ configPath });
  currentConfigPath = configPath;
  currentConfig = config;

  relay = createRelayServer(config);
  await relay.start();
  poller = createOdooPrintPoller(config, relay);
  poller.start();

  tray = new Tray(makeTrayIcon());
  tray.setToolTip('RMS Print Relay');
  tray.on('double-click', () => {
    createMainWindow(configPath, currentConfig || config);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  tray.setContextMenu(buildTrayMenu(configPath, config));

  log('RMS desktop relay ready.');
  log(`Config: ${configPath}`);
  log(`Listening on http://${config.bindHost}:${config.bindPort}`);
  log(`Printing to ${config.printerIp}:${config.printerPort}`);

  createMainWindow(configPath, config);
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
}

ipcMain.handle('relay:open-health', async () => {
  if (!currentConfig) return;
  await shell.openExternal(`http://${currentConfig.bindHost}:${currentConfig.bindPort}/health`);
});

ipcMain.handle('relay:get-health', () => readRelayJson('/health'));
ipcMain.handle('relay:get-status', () => readRelayJson('/status'));
ipcMain.handle('relay:get-debug', () => readRelayJson('/debug'));

ipcMain.handle('relay:open-config', async () => {
  const configPath = resolveConfigPath(process.env.RMS_AGENT_CONFIG);
  await shell.openPath(configPath);
});

ipcMain.handle('relay:save-config', async (_event, nextConfig) => {
  if (!currentConfigPath) {
    throw new Error('Config path is not ready yet');
  }

  const existing = JSON.parse(fs.readFileSync(currentConfigPath, 'utf8'));
  const merged = {
    ...existing,
    ...nextConfig,
  };

  if (merged.printerMode !== 'mock' && !merged.printerIp) {
    throw new Error('Printer IP is required for tcp mode');
  }

  fs.writeFileSync(currentConfigPath, JSON.stringify(merged, null, 2) + '\n');
  const reloaded = loadConfig({ configPath: currentConfigPath });
  setTimeout(() => {
    restartRelayWithConfig(reloaded).catch((err) => {
      console.error('Failed to restart relay after saving config:', err);
    });
  }, 250);

  return { ok: true };
});

ipcMain.handle('relay:pair-odoo', async (_event, pairing) => {
  if (!currentConfigPath) throw new Error('Config path is not ready yet');
  const odooUrl = String(pairing.odooUrl || '').trim().replace(/\/+$/, '');
  try {
    relay?.recordEvent('odoo', 'Pairing relay with Odoo', { url: odooUrl });
    const result = await pairOdooDevice(odooUrl, pairing.pairingCode);
    const existing = JSON.parse(fs.readFileSync(currentConfigPath, 'utf8'));
    const merged = {
      ...existing,
      odooUrl,
      deviceId: result.device_id,
      deviceName: result.device_name,
      deviceToken: result.device_token,
    };
    fs.writeFileSync(currentConfigPath, JSON.stringify(merged, null, 2) + '\n');
    relay?.recordEvent('odoo', 'Relay paired with Odoo', {
      url: odooUrl,
      deviceName: result.device_name,
    });
    const reloaded = loadConfig({ configPath: currentConfigPath });
    setTimeout(() => {
      restartRelayWithConfig(reloaded).catch((err) => {
        console.error('Failed to restart relay after pairing:', err);
      });
    }, 750);
    return { ok: true, deviceId: result.device_id, deviceName: result.device_name };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    relay?.recordEvent('error', `Odoo pairing failed: ${message}`, { url: odooUrl });
    throw new Error(message);
  }
});

ipcMain.handle('relay:hide-window', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
});

app.whenReady().then(main).catch((err) => {
  console.error('Fatal error:', err);
  app.quit();
});

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', async () => {
  app.isQuiting = true;
  if (poller) {
    await poller.stop().catch(() => {});
  }
  if (relay) {
    await relay.stop().catch(() => {});
  }
});

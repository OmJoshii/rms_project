'use strict';

const { loadConfig } = require('./config');
const { createRelayServer } = require('./relay');
const { createOdooPrintPoller } = require('./odoo-client');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function main() {
  const config = loadConfig();
  const relay = createRelayServer(config);

  await relay.start();
  const poller = createOdooPrintPoller(config, relay);
  poller.start();
  log('RMS local print relay starting.');
  log(`Listening on http://${config.bindHost}:${config.bindPort}`);
  log(`Printing to ${config.printerIp}:${config.printerPort} (${config.printerMode || 'tcp'})`);
  log(config.deviceToken ? `Polling ${config.odooUrl} for print jobs.` : 'Not paired with Odoo.');

  const shutdown = async () => {
    await poller.stop().catch(() => {});
    await relay.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

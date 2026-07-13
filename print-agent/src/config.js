'use strict';

const fs = require('fs');
const path = require('path');

function resolveConfigPath(overridePath) {
  if (overridePath) return overridePath;
  if (process.env.RMS_AGENT_CONFIG) return process.env.RMS_AGENT_CONFIG;
  return path.join(__dirname, '..', 'config.json');
}

function loadConfig(options = {}) {
  const configPath = resolveConfigPath(options.configPath);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing config file at ${configPath}\n` +
      `Copy config.example.json to config.json and fill in your details first.`
    );
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const printerMode = config.printerMode || 'tcp';
  const required = printerMode === 'mock' ? [] : ['printerIp'];
  for (const key of required) {
    if (!config[key]) {
      throw new Error(`config.json is missing required field: "${key}"`);
    }
  }

  return {
    configPath,
    printerMode,
    printerIp: printerMode === 'mock' ? '127.0.0.1' : config.printerIp,
    printerPort: config.printerPort || 9100,
    bindHost: config.bindHost || '127.0.0.1',
    bindPort: config.bindPort || 17333,
    restaurantName: config.restaurantName || 'Restaurant',
    printTimeoutMs: config.printTimeoutMs || 5000,
    printRetries: config.printRetries != null ? config.printRetries : 2,
    odooUrl: String(config.odooUrl || '').trim().replace(/\/+$/, ''),
    deviceId: config.deviceId || null,
    deviceName: config.deviceName || '',
    deviceToken: config.deviceToken || '',
    odooPollIntervalMs: config.odooPollIntervalMs || 2000,
    processedJobsPath: config.processedJobsPath || '',
  };
}

module.exports = { loadConfig, resolveConfigPath };

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function requestJson(baseUrl, route, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = route
        ? new URL(route, `${normalizeBaseUrl(baseUrl)}/`)
        : new URL(normalizeBaseUrl(baseUrl));
    } catch (_) {
      reject(new Error('Invalid Odoo URL'));
      return;
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      reject(new Error('Odoo URL must use HTTP or HTTPS'));
      return;
    }

    const body = options.body == null ? null : JSON.stringify(options.body);
    const headers = {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    };
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: options.method || 'GET',
      headers,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 2_000_000) req.destroy(new Error('Odoo response is too large'));
      });
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < 3) {
          requestJson(new URL(res.headers.location, url).toString(), '', options, redirectCount + 1)
            .then(resolve, reject);
          return;
        }
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch (_) {
          reject(new Error(`Odoo returned invalid JSON (HTTP ${res.statusCode})`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(data.error || `Odoo returned HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        resolve(data);
      });
    });
    req.setTimeout(options.timeoutMs || 15000, () => req.destroy(new Error('Odoo request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class ProcessedJobJournal {
  constructor(filePath, limit = 500) {
    this.filePath = filePath;
    this.limit = limit;
    this.ids = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) this.ids = parsed.filter((id) => typeof id === 'string').slice(-limit);
    } catch (_) {}
  }

  has(jobId) {
    return this.ids.includes(jobId);
  }

  add(jobId) {
    if (this.has(jobId)) return;
    this.ids.push(jobId);
    if (this.ids.length > this.limit) this.ids.splice(0, this.ids.length - this.limit);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.ids, null, 2) + '\n');
    fs.renameSync(tempPath, this.filePath);
  }
}

async function pairOdooDevice(odooUrl, pairingCode) {
  const baseUrl = normalizeBaseUrl(odooUrl);
  if (!baseUrl) throw new Error('Odoo URL is required');
  if (!String(pairingCode || '').trim()) throw new Error('Pairing code is required');
  return requestJson(baseUrl, '/rms/print-agent/pair', {
    method: 'POST',
    body: { pairing_code: String(pairingCode).trim().toUpperCase() },
  });
}

function createOdooPrintPoller(config, relay) {
  let stopped = true;
  let timer = null;
  let inFlight = null;
  const baseUrl = normalizeBaseUrl(config.odooUrl);
  const token = config.deviceToken || '';
  const journalPath = config.processedJobsPath || path.join(
    path.dirname(config.configPath),
    'processed-print-jobs.json'
  );
  const journal = new ProcessedJobJournal(journalPath);

  function schedule(delayMs) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(runPoll, delayMs);
  }

  async function reportResult(job, result, error = null) {
    return requestJson(baseUrl, `/rms/print-agent/jobs/${job.id}/result`, {
      method: 'POST',
      token,
      body: {
        claim_token: job.claim_token,
        result,
        ...(error ? { error } : {}),
      },
    });
  }

  async function pollOnce() {
    const data = await requestJson(baseUrl, '/rms/print-agent/jobs/next', {
      method: 'POST',
      token,
      body: {},
    });
    relay.setOdooStatus({
      configured: true,
      connected: true,
      url: baseUrl,
      deviceName: config.deviceName || '',
      lastPollAt: new Date().toISOString(),
      error: null,
    });
    const job = data.job;
    if (!job) return false;

    relay.setOdooStatus({ lastJobAt: new Date().toISOString() });
    if (journal.has(job.uuid)) {
      relay.recordEvent('odoo', 'Recovered acknowledgement without reprinting completed job', {
        jobId: job.uuid,
        orderId: job.order_id,
      });
      await reportResult(job, 'sent');
      return true;
    }

    relay.recordEvent('odoo', 'Claimed print job from Odoo', {
      jobId: job.uuid,
      orderId: job.order_id,
      source: job.source,
      attempt: job.attempt,
    });
    try {
      await relay.printOrder(job.payload, {
        jobId: job.uuid,
        source: `odoo-${job.source}`,
        message: 'Odoo print job received by relay',
      });
      journal.add(job.uuid);
      await reportResult(job, 'sent');
      relay.recordEvent('odoo', 'Odoo print job acknowledged as sent', { jobId: job.uuid });
    } catch (err) {
      try {
        await reportResult(job, 'failed', err.message);
      } catch (reportErr) {
        relay.recordEvent('error', `Could not report failed job to Odoo: ${reportErr.message}`, {
          jobId: job.uuid,
        });
      }
    }
    return true;
  }

  async function runPoll() {
    if (stopped || inFlight) return;
    inFlight = pollOnce();
    let hadJob = false;
    try {
      hadJob = await inFlight;
    } catch (err) {
      relay.setOdooStatus({
        configured: true,
        connected: false,
        url: baseUrl,
        lastPollAt: new Date().toISOString(),
        error: err.message,
      });
    } finally {
      inFlight = null;
      schedule(hadJob ? 100 : config.odooPollIntervalMs);
    }
  }

  return {
    start() {
      stopped = false;
      if (!baseUrl || !token) {
        relay.setOdooStatus({
          configured: false,
          connected: false,
          url: baseUrl,
          error: 'Relay is not paired with Odoo',
        });
        return;
      }
      schedule(0);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (inFlight) await inFlight.catch(() => {});
    },
  };
}

module.exports = {
  createOdooPrintPoller,
  pairOdooDevice,
  requestJson,
};

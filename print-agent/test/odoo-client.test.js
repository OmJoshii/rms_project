'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createOdooPrintPoller, pairOdooDevice } = require('../src/odoo-client');

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('Timed out waiting for condition'));
      setTimeout(check, 10);
    };
    check();
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

test('pairs, prints a claimed job, and suppresses a reclaimed duplicate', async (t) => {
  const results = [];
  const job = {
    id: 9,
    uuid: 'job-uuid-9',
    source: 'automatic',
    order_id: 42,
    claim_token: 'claim-9',
    payload: { id: 42, name: 'S00042', items: [{ qty: 1, name: 'Test' }] },
    attempt: 1,
    max_attempts: 5,
  };
  let nextJob = job;

  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/rms/print-agent/pair') {
      assert.equal(body.pairing_code, 'ABCD2345');
      res.end(JSON.stringify({
        ok: true,
        device_id: 3,
        device_name: 'Kitchen Printer',
        device_token: 'device-token',
      }));
      return;
    }
    assert.equal(req.headers.authorization, 'Bearer device-token');
    if (req.url === '/rms/print-agent/jobs/next') {
      res.end(JSON.stringify({ ok: true, job: nextJob }));
      nextJob = null;
      return;
    }
    if (req.url === '/rms/print-agent/jobs/9/result') {
      results.push(body);
      res.end(JSON.stringify({ ok: true, state: body.result }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const paired = await pairOdooDevice(baseUrl, 'abcd2345');
  assert.equal(paired.device_token, 'device-token');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-print-agent-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = {
    configPath: path.join(tempDir, 'config.json'),
    processedJobsPath: path.join(tempDir, 'processed.json'),
    odooUrl: baseUrl,
    deviceToken: 'device-token',
    deviceName: 'Kitchen Printer',
    odooPollIntervalMs: 20,
  };
  let printCount = 0;
  const relay = {
    setOdooStatus() {},
    recordEvent() {},
    async printOrder(payload) {
      assert.equal(payload.name, 'S00042');
      printCount += 1;
    },
  };

  const firstPoller = createOdooPrintPoller(config, relay);
  firstPoller.start();
  await waitFor(() => results.length === 1);
  await firstPoller.stop();
  assert.equal(printCount, 1);
  assert.equal(results[0].result, 'sent');

  nextJob = { ...job, claim_token: 'claim-9-reclaimed', attempt: 2 };
  const secondPoller = createOdooPrintPoller(config, relay);
  secondPoller.start();
  await waitFor(() => results.length === 2);
  await secondPoller.stop();
  assert.equal(printCount, 1);
  assert.equal(results[1].result, 'sent');
});

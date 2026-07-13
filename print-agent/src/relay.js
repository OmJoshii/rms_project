'use strict';

const http = require('http');
const net = require('net');
const { randomUUID } = require('crypto');
const { buildEscposTicket } = require('./escpos');
const { sendToPrinterWithRetry } = require('./printer');

function sendJson(res, statusCode, payload, origin = '*') {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeOrderPayload(body) {
  if (body && typeof body === 'object' && body.order && typeof body.order === 'object') {
    return body.order;
  }
  return body;
}

function nowIso() {
  return new Date().toISOString();
}

function summarizeOrder(order) {
  if (!order || typeof order !== 'object') return null;
  return {
    id: order.id || null,
    name: order.name || '',
    delivery_type: order.delivery_type || '',
    is_catering: !!order.is_catering,
    item_count: Array.isArray(order.items) ? order.items.length : 0,
    customer_name: order.customer_name || '',
  };
}

function createEventBuffer(limit = 40) {
  const events = [];
  return {
    push(type, message, data = null) {
      events.unshift({
        ts: nowIso(),
        type,
        message,
        data,
      });
      if (events.length > limit) events.length = limit;
    },
    all() {
      return events.slice();
    },
  };
}

function createMockPrinter(config, events) {
  let server = null;
  let lastJob = null;

  function start() {
    if (server) return Promise.resolve();
    server = net.createServer((socket) => {
      const chunks = [];
      let total = 0;
      const remote = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || '0'}`;

      events.push('printer', `Mock printer accepted connection from ${remote}`);

      socket.on('data', (chunk) => {
        chunks.push(chunk);
        total += chunk.length;
      });

      socket.on('end', () => {
        const bytes = Buffer.concat(chunks, total);
        const preview = bytes
          .toString('utf8')
          .replace(/\x1b/g, '<ESC>')
          .replace(/\x1d/g, '<GS>')
          .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ' ')
          .slice(0, 240)
          .replace(/\s+/g, ' ')
          .trim();
        lastJob = {
          receivedAt: nowIso(),
          bytes: total,
          preview,
        };
        events.push('printer', `Mock printer received ${total} bytes`, lastJob);
      });

      socket.on('error', (err) => {
        events.push('printer', `Mock printer socket error: ${err.message}`);
      });
    });

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.printerPort, '127.0.0.1', () => {
        server.off('error', reject);
        events.push('printer', `Mock printer listening on 127.0.0.1:${config.printerPort}`);
        resolve();
      });
    });
  }

  function stop() {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        server = null;
        resolve();
      });
    });
  }

  return {
    start,
    stop,
    getStatus() {
      return {
        mode: 'mock',
        ok: !!server,
        ip: '127.0.0.1',
        port: config.printerPort,
        lastJob,
      };
    },
  };
}

function probePrinter(ip, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error: error || null });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => finish(false, err.message));
    socket.connect(port, ip);
  });
}

function createRelayServer(config) {
  let queue = Promise.resolve();
  const events = createEventBuffer();
  const mockPrinter = config.printerMode === 'mock' ? createMockPrinter(config, events) : null;
  let odooStatus = {
    configured: !!(config.odooUrl && config.deviceToken),
    connected: false,
    url: config.odooUrl || '',
    deviceName: config.deviceName || '',
    lastPollAt: null,
    lastJobAt: null,
    error: null,
  };

  const enqueue = (task) => {
    const job = queue.then(task, task);
    queue = job.catch(() => {});
    return job;
  };

  async function printOrder(order, options = {}) {
    if (!order || typeof order !== 'object') throw new Error('Missing order payload');
    const jobId = options.jobId || randomUUID();
    const summary = summarizeOrder(order);
    events.push('received', options.message || 'Print job received by relay', {
      jobId,
      source: options.source || 'local',
      order,
    });

    try {
      const result = await enqueue(async () => {
        const ticket = buildEscposTicket(order, config.restaurantName);
        events.push('rendered', `Ticket rendered (${ticket.length} bytes ESC/POS)`, {
          jobId,
          summary,
        });

        const printerIp = config.printerMode === 'mock' ? '127.0.0.1' : config.printerIp;
        events.push('printer', `Sending ticket to ${printerIp}:${config.printerPort}`, {
          jobId,
          summary,
        });
        await sendToPrinterWithRetry(
          ticket,
          {
            ip: printerIp,
            port: config.printerPort,
            timeoutMs: config.printTimeoutMs,
          },
          config.printRetries
        );
        events.push('printed', `Printer accepted ticket at ${printerIp}:${config.printerPort}`, {
          jobId,
          summary,
        });
        return {
          mode: config.printerMode === 'mock' ? 'mock' : 'tcp',
          printer: { ok: true, ip: printerIp, port: config.printerPort },
        };
      });
      return { ...result, jobId };
    } catch (err) {
      const printer = {
        ok: false,
        ip: config.printerMode === 'mock' ? '127.0.0.1' : config.printerIp,
        port: config.printerPort,
      };
      events.push('error', `Printer delivery failed: ${err.message}`, {
        jobId,
        printer,
        order,
      });
      err.jobId = jobId;
      err.printer = printer;
      throw err;
    }
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '*';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        mode: 'relay',
        printerMode: config.printerMode || 'tcp',
        printerIp: config.printerIp,
        printerPort: config.printerPort,
      }, origin);
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      try {
        const printer = config.printerMode === 'mock'
          ? mockPrinter.getStatus()
          : await probePrinter(config.printerIp, config.printerPort);
        sendJson(res, 200, {
          ok: true,
          relay: {
            ok: true,
            host: config.bindHost,
            port: config.bindPort,
          },
          printer: {
            ok: printer.ok,
            mode: config.printerMode || 'tcp',
            ip: printer.ip || config.printerIp,
            port: printer.port || config.printerPort,
            error: printer.error || null,
            lastJob: printer.lastJob || null,
          },
          odoo: odooStatus,
          recentEvents: events.all(),
        }, origin);
      } catch (err) {
        sendJson(res, 200, {
          ok: true,
          relay: {
            ok: true,
            host: config.bindHost,
            port: config.bindPort,
          },
          printer: {
            ok: false,
            mode: config.printerMode || 'tcp',
            ip: config.printerIp,
            port: config.printerPort,
            error: err.message,
          },
          odoo: odooStatus,
          recentEvents: events.all(),
        }, origin);
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/debug') {
      sendJson(res, 200, {
        ok: true,
        mode: config.printerMode || 'tcp',
        printer: config.printerMode === 'mock' ? mockPrinter.getStatus() : {
          mode: 'tcp',
          ip: config.printerIp,
          port: config.printerPort,
        },
        odoo: odooStatus,
        events: events.all(),
      }, origin);
      return;
    }

    if (req.method === 'POST' && req.url === '/print') {
      try {
        const body = await readBody(req);
        const order = normalizeOrderPayload(body);
        if (!order || typeof order !== 'object') {
          sendJson(res, 400, { success: false, error: 'missing_order' }, origin);
          return;
        }
        const result = await printOrder(order, {
          source: 'legacy-browser',
          message: 'Legacy browser print request received by relay',
        });

        sendJson(res, 200, {
          success: true,
          relayReceived: true,
          jobId: result.jobId,
          debug: true,
          mode: result.mode,
          printer: result.printer,
          eventCount: events.all().length,
        }, origin);
      } catch (err) {
        sendJson(res, 502, {
          success: false,
          relayReceived: !!err.jobId,
          jobId: err.jobId || null,
          printer: err.printer || null,
          error: err.message,
        }, origin);
      }
      return;
    }

    sendJson(res, 404, { success: false, error: 'not_found' }, origin);
  });

  return {
    server,
    printOrder,
    recordEvent(type, message, data = null) {
      events.push(type, message, data);
    },
    setOdooStatus(nextStatus) {
      const previous = odooStatus;
      odooStatus = { ...odooStatus, ...nextStatus };
      if (previous.connected !== odooStatus.connected || previous.error !== odooStatus.error) {
        events.push(
          'odoo',
          odooStatus.connected ? 'Connected to Odoo print queue' : `Odoo print queue unavailable: ${odooStatus.error || 'not configured'}`,
          odooStatus
        );
      }
    },
    start() {
      return new Promise((resolve, reject) => {
        try {
          const maybeStartMock = mockPrinter ? mockPrinter.start() : Promise.resolve();
          Promise.resolve(maybeStartMock)
            .then(() => {
              server.once('error', reject);
              server.listen(config.bindPort, config.bindHost, () => {
                server.off('error', reject);
                events.push('relay', `Relay listening on ${config.bindHost}:${config.bindPort}`);
                events.push('relay', `Printer target mode: ${config.printerMode || 'tcp'}`);
                resolve();
              });
            })
            .catch(reject);
        } catch (err) {
          reject(err);
        }
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(async () => {
          if (mockPrinter) {
            await mockPrinter.stop().catch(() => {});
          }
          resolve();
        });
      });
    },
  };
}

module.exports = { createRelayServer };

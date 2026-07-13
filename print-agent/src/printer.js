'use strict';

const net = require('net');

/**
 * Send raw ESC/POS bytes to the printer over TCP port 9100.
 * Resolves on success, rejects with an Error on failure/timeout.
 */
function sendToPrinter(bytes, { ip, port = 9100, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs);

    socket.on('timeout', () => finish(new Error(`Timed out connecting to printer at ${ip}:${port}`)));
    socket.on('error', (err) => finish(new Error(`Printer connection error (${ip}:${port}): ${err.message}`)));

    socket.connect(port, ip, () => {
      socket.write(bytes, (err) => {
        if (err) return finish(err);
        // Give the printer a brief moment to accept the bytes before closing.
        setTimeout(() => finish(), 150);
      });
    });
  });
}

/**
 * Same as sendToPrinter but retries a few times with a short backoff,
 * so a printer that's momentarily busy/out of paper/rebooting doesn't
 * silently drop an order.
 */
async function sendToPrinterWithRetry(bytes, opts, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await sendToPrinter(bytes, opts);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

module.exports = { sendToPrinter, sendToPrinterWithRetry };

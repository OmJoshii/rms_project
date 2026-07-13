'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadRenderer() {
  const filename = path.resolve(__dirname, '../src/electron-main.js');
  const source = fs.readFileSync(filename, 'utf8') +
    '\nmodule.exports.renderWindowHtml = renderWindowHtml;';
  const electron = {
    app: { whenReady: () => new Promise(() => {}), on: () => {} },
    ipcMain: { handle: () => {} },
    Tray: function Tray() {},
    Menu: {},
    shell: {},
    nativeImage: {},
    BrowserWindow: function BrowserWindow() {},
  };
  const localRequire = (id) => {
    if (id === 'electron') return electron;
    return require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id);
  };
  const module = { exports: {} };

  new Function('require', 'module', 'exports', '__dirname', '__filename', source)(
    localRequire,
    module,
    module.exports,
    path.dirname(filename),
    filename
  );
  return module.exports.renderWindowHtml;
}

test('desktop renderer script parses', () => {
  const renderWindowHtml = loadRenderer();
  const html = renderWindowHtml('/tmp/config.json', {
    bindHost: '127.0.0.1',
    bindPort: 17333,
    printerMode: 'tcp',
    printerIp: '10.1.10.118',
    printerPort: 9100,
  });
  const script = html.match(/<script>([\s\S]*)<\/script>/);

  assert.ok(script, 'renderer script should be present');
  assert.doesNotThrow(() => new vm.Script(script[1], { filename: 'renderer.js' }));
});

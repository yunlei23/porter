'use strict';

const { strict: assert } = require('assert');
const path = require('path');
const Porter = require('../..');
const { MODULE_LOADED } = require('../../src/constants');

describe('WasmModule', function() {
  const root = path.resolve(__dirname, '../../../demo-wasm');
  let porter;

  before(async function() {
    porter = new Porter({
      root,
      entries: [ 'home.js' ],
      cache: { clean: true },
    });
    await porter.ready();
  });

  after(async function() {
    await porter.destroy();
  });

  it('should be able to parse wasm module', async function() {
    const packet = porter.packet.find({ name: '@cara/hello-wasm' });
    // the parsing process is deferred
    const mod = await packet.parseFile('pkg/bundler/index_bg.wasm');
    assert.equal(mod.status, MODULE_LOADED);
  });

  it('should reload without error', async function() {
    const packet = porter.packet.find({ name: '@cara/hello-wasm' });
    const mod = await packet.parseFile('pkg/bundler/index_bg.wasm');
    await assert.doesNotReject(async function() {
      await mod.reload();
    });
  });
});

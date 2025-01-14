import expect from 'expect.js';
import { greet } from '@cara/hello-wasm';
import 'regenerator-runtime';
import './web';

describe('demo-wasm', function() {
  it('greet', async function() {
    const called = [];
    global.alert = function alert(text) {
      called.push(text);
    };
    greet('wasm');
    expect(called).to.eql([ 'Hello, wasm!' ]);
  });
});

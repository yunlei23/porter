'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const UglifyJS = require('uglify-js');
const { SourceMapConsumer, SourceMapGenerator, SourceNode } = require('source-map');
const debug = require('debug')('porter');
const Module = require('./module');

function getEntry(packet, entries) {
  return entries && entries.length === 1 ? entries[0] : packet.main;
}

module.exports = class Bundle {
  #entries = null;
  #code = null;
  #map = null;
  #etag = null;
  #contenthash = null;

  static create(options = {}) {
    const { packet, entries } = options;
    const { bundles } = packet;
    const entry = getEntry(packet, entries);
    let bundle = bundles[entry];
    if (!bundle) {
      bundle = new Bundle(options);
      bundles[entry] = bundle;
    }
    return bundle;
  }

  constructor(options = {}) {
    const { packet, entries, loaderConfig } = options;
    const { app } = packet;

    this.app = app;
    this.packet = packet;
    this.#entries = Array.isArray(entries) && entries.length > 0 ? entries : null;
    this.loaderConfig = loaderConfig;
    this.loaderCache = {};

    let scope = 'packet';
    if (app.preload.length > 0 || options.all) {
      scope = 'all';
    } else if (options.package === false) {
      scope = 'module';
    }
    this.scope = scope;
  }

  /**
   * Traverse all the bundled modules. Following modules will be skipped over:
   * - module is just a placeholder object generated by {@link FakePacket}
   * - module is preloaded but the ancestor isn't one of the preload entry
   * - module is one of the bundle exceptions
   */
  * [Symbol.iterator]() {
    const { entries, packet, scope } = this;
    const done = {};

    function* iterate(entry, preload) {
      for (const mod of entry.children) {
        if (done[mod.id]) continue;
        // exclude external modules if module packet is isolated
        if (mod.packet !== packet && scope !== 'all') continue;
        if (mod.preloaded && !preload && !packet.isolated) continue;
        if (mod.packet !== packet && mod.packet.isolated) continue;
        // might be WasmModule
        if (mod.isolated) continue;
        yield* iterateEntry(mod, preload);
      }
    }

    function* iterateEntry(entry, preload = false) {
      done[entry.id] = true;
      yield* iterate(entry, preload);
      yield entry;
      // iterate again in case new dependencies such as @babel/runtime were found
      yield* iterate(entry, preload);
    }

    for (const name of entries) {
      if (name.endsWith('.css')) continue;
      const entry = packet.files[name];
      if (!entry) throw new Error(`unparsed entry ${name} (${packet.dir})`);
      // might be a mocked module from FakePacket
      if (!(entry instanceof Module)) continue;

      /**
       * preloaded modules should be included in following scenarios:
       * - bundling preload.js itself.
       * - bundling a program generated entry that needs to be self contained.
       * - bundling a web worker
       */
      const preload = entry.isPreload || entry.fake || (entry.isWorker);
      yield* iterateEntry(entry, preload);
    }
  }

  get entries() {
    if (this.#entries) return this.#entries;

    const { entries } = this.packet;
    return Object.keys(entries).filter(file => {
      return file.endsWith('.js') && !entries[file].isRootEntry;
    });
  }

  get entry() {
    const { packet } = this;
    return getEntry(packet, this.#entries);
  }

  get output() {
    const { entries } = this;
    const code = this.#code;
    if (entries.length === 0 || !code) return '';
    const { entry, contenthash } = this;
    return entry.replace(/(\.\w+)?$/, (m, ext = '.js') => {
      return `.${contenthash}${ext === '.css' ? ext : '.js'}`;
    });
  }

  get contenthash() {
    const code = this.#code;
    if (!code) return '';
    if (!this.#contenthash) {
      this.#contenthash = crypto.createHash('md5').update(code).digest('hex').slice(0, 8);
    }
    return this.#contenthash;
  }

  get outputPath() {
    const { output, packet } = this;
    const { name, version } = packet;

    return packet.parent ? path.join(name, version, output) : output;
  }

  async createSourceNode({ source, code, map }) {
    if (map instanceof SourceMapGenerator) {
      map = map.toJSON();
    }

    if (map) {
      const consumer = await new SourceMapConsumer(map);
      return SourceNode.fromStringWithSourceMap(code, consumer);
    }

    // Source code need to be mapped line by line to debug in devtools.
    const lines = code.split('\n');
    const node = new SourceNode();
    for (let i = 0; i < lines.length; i++) {
      node.add(new SourceNode(i + 1, 0, source, lines[i]));
    }
    return node.join('\n');
    // return new SourceNode(1, 0, source, code)
  }

  async obtainLoader(loaderConfig) {
    return {
      code: await this.packet.parseLoader(loaderConfig)
    };
  }

  async minifyLoader(loaderConfig = {}) {
    const { loaderCache } = this;
    const searchParams = new URLSearchParams();
    for (const key in loaderConfig) searchParams.set(key, loaderConfig[key]);
    const cacheKey = searchParams.toString();
    if (loaderCache[cacheKey]) return loaderCache[cacheKey];
    const code = await this.packet.parseLoader(loaderConfig);

    return loaderCache[cacheKey] = UglifyJS.minify({ 'loader.js': code }, {
      compress: { dead_code: true },
      output: { ascii_only: true },
      sourceMap: { root: '/' },
      ie8: true
    });
  }

  async reload() {
    const { app, entry, packet, outputPath } = this;
    if (!outputPath) return;
    debug(`reloading ${entry} -> ${outputPath} (${packet.dir})`);
    await fs.unlink(path.join(app.cache.dest, outputPath)).catch(() => {});
    this.#code = null;
    this.#map = null;
    this.#etag = null;
    this.#contenthash = null;
    await this.obtain();
  }

  /**
   * Create a bundle from specified entries
   * @param {string[]} entries
   * @param {Object} opts
   * @param {boolean} opts.loader   include the loader when entry is root entry, set to false to explicitly exclude the loader
   * @param {Object} opts.loaderConfig overrides {@link Packet#loaderConfig}
   */
  async obtain({ loader, minify = false } = {}) {
    const { app, entries, packet, entry } = this;

    if (this.#etag === JSON.stringify({ entries })) {
      return { code: this.#code, map: this.#map };
    }

    if (path.extname(entry) === '.css') {
      const mod = packet.files[entry];
      const result = minify ? await mod.minify() : await mod.obtain();
      this.#code = result.code;
      this.#map = result.map;
      this.#etag = JSON.stringify({ entries });
      return result;
    }

    const node = new SourceNode();
    const loaderConfig = Object.assign(packet.loaderConfig, this.loaderConfig);
    const preloaded = app.preload.length > 0;

    for (const mod of this) {
      const { code, map } = minify ? await mod.minify() : await mod.obtain();
      const source = path.relative(app.root, mod.fpath);
      node.add(await this.createSourceNode({ source, code, map }));
    }
    const mod = packet.files[entries[0]];

    if (!mod) {
      const { name, version } = packet;
      throw new Error(`unable to find ${entries[0]} in packet ${name} v${version}`);
    }

    if (mod.isRootEntry) {
      // make sure packet dependencies are all packed
      for (const dep of packet.all) {
        if (dep !== packet) await dep.pack();
      }
    }

    if (mod.isRootEntry && !mod.isPreload) {
      const lock = preloaded && mod.fake ? mod.lock : packet.lock;
      node.prepend(`Object.assign(porter.lock, ${JSON.stringify(lock)})`);
    }

    if (mod.isRootEntry && loader !== false) {
      // bundle with loader unless turned off specifically
      const { code, map } = minify
        ? await this.minifyLoader(loaderConfig)
        : await this.obtainLoader(loaderConfig);
      const source = 'loader.js';
      node.prepend(await this.createSourceNode({ source, code, map }));
      node.add(`porter["import"](${JSON.stringify(mod.id)})`);
    }

    const result = node.join('\n').toStringWithSourceMap({ sourceRoot: '/' });
    this.#code = result.code;
    this.#map = result.map;
    this.#etag = JSON.stringify({ entries });
    this.#contenthash = null;

    return result;
  }

  async minify(opts) {
    return await this.obtain({ ...opts, minify: true });
  }

  // async minify(opts) {
  //   const { code, map } = await this.obtain(opts);
  //   if (path.extname(this.entry) === '.css') return { code, map };

  //   const result = UglifyJS.minify(code, {
  //     compress: {
  //       dead_code: true,
  //       global_defs: {
  //         process: {
  //           env: {
  //             BROWSER: true,
  //             NODE_ENV: process.env.NODE_ENV
  //           }
  //         }
  //       }
  //     },
  //     output: { ascii_only: true },
  //     sourceMap: {
  //       content: map.toString(),
  //       root: '/'
  //     },
  //   });

  //   if (result.error) throw result.error;
  //   return result;
  // }
};

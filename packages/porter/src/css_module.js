'use strict';

const fs = require('fs/promises');

const Module = require('./module');

const rAtImport = /(?:^|\n)\s*@import\s+(['"])([^'"]+)\1;/g;

module.exports = class CssModule extends Module {
  matchImport(code) {
    const deps = [];
    let m;

    rAtImport.lastIndex = 0;
    while ((m = rAtImport.exec(code))) {
      deps.push(m[2]);
    }

    return deps;
  }

  /**
   * Parse the module code and contruct dependencies. Unlike {@link JsModule}, CssModule uses the original code to parse dependencies instead because the code returned by {@link CssModule#load} would have `@import`s expanded and replaced.
   */
  async parse() {
    if (this.loaded) return;
    this.loaded = true;

    const { fpath } = this;
    const code = this.code || (await fs.readFile(fpath, 'utf8'));
    const deps = this.deps || this.matchImport(code);

    await Promise.all(deps.map(this.parseDep, this));
  }

  async load() {
    const { fpath } = this;
    const code = await fs.readFile(fpath, 'utf8');
    return { code };
  }

  async transpile({ code, map }) {
    const { fpath, app } = this;
    const { cssTranspiler } = this.package.app;

    /**
     * PostCSS doesn't support sourceRoot yet
     * https://github.com/postcss/postcss/blob/master/docs/source-maps.md
     */
    const result = await cssTranspiler.process(code, {
      from: fpath,
      path: this.app.paths,
      map: {
        inline: false,
        sourcesContent: false
      }
    });

    map = JSON.parse(result.map);
    map.sourceRoot = app.source.root;

    return { code: result.css, map };
  }

  async minify() {
    const { code, map } = await this.load();
    return this.transpile({ code, map });
  }
};

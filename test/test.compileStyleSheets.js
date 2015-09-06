'use strict'

require('co-mocha')
var path = require('path')
var exec = require('child_process').execSync
var exists = require('fs').existsSync
var expect = require('expect.js')

var compileStyleSheets = require('../lib/compileStyleSheets')


describe('compileStyleSheets', function() {
  before(function() {
    process.chdir(path.join(__dirname, 'example'))
  })

  it('compiles stylesheets', function* () {
    yield* compileStyleSheets({
      match: 'stylesheets/app.css'
    })

    expect(exists(path.join(__dirname, 'example/public/stylesheets/app.css')))
      .to.be(true)
  })

  after(function() {
    exec('rm -rf ' + path.join(__dirname, 'example', 'public'))
  })
})
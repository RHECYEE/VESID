#!/usr/bin/env node
/*
 * Local preview of the Apps Script web app, for development only.
 *
 * Runs apps-script/Code.gs in Node with in-memory stand-ins for the Google
 * services it uses (SpreadsheetApp, PropertiesService, LockService,
 * HtmlService, Utilities) and serves the pages with a google.script.run shim.
 *
 *   node dev/preview-server.js [port]
 *
 * Then open http://localhost:8787/ (survey) and /?view=map (owner map).
 * Nothing leaves your machine except map tiles / address lookups the pages
 * themselves request. Data is lost when the server stops.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'apps-script');

// ---- Fakes for the Google services Code.gs touches ------------------------

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];        // values as Sheets would store them
    this.rawAppends = [];  // exactly what the script passed to appendRow
    this.frozenRows = 0;
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  appendRow(values) {
    this.rawAppends.push(values.slice());
    // Sheets treats a leading apostrophe as "store as text" and hides it.
    this.rows.push(values.map((v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v)));
    return this;
  }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  getRange() { return { setFontWeight: () => this }; }
  getDataRange() {
    const width = Math.max(0, ...this.rows.map((r) => r.length));
    return {
      getValues: () => this.rows.map((r) => {
        const out = r.slice();
        while (out.length < width) out.push('');
        return out;
      }),
    };
  }
}

function makeGoogleServices(state) {
  const sheets = new Map();
  const spreadsheet = {
    getId: () => 'fake-spreadsheet',
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
  };
  const props = new Map();
  const noUi = () => { throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); };
  return {
    sheets,
    props,
    globals: {
      SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, getUi: noUi },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k) => (props.has(k) ? props.get(k) : null),
          setProperty: (k, v) => { props.set(k, String(v)); },
        }),
      },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
      Utilities: { getUuid: () => crypto.randomUUID() },
      HtmlService: {
        createTemplateFromFile(name) {
          const file = path.join(SRC, name + '.html');
          const template = {
            evaluate() {
              const vars = Object.assign({}, template);
              delete vars.evaluate;
              const html = fs.readFileSync(file, 'utf8').replace(/<\?(!?=)([\s\S]*?)\?>/g, (_, kind, expr) => {
                const value = new Function(...Object.keys(vars), 'return (' + expr + ');')(...Object.values(vars));
                const s = String(value);
                return kind === '!=' ? s : s.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
              });
              const output = {
                title: '', meta: [],
                setTitle(t) { this.title = t; return this; },
                addMetaTag(n, c) { this.meta.push([n, c]); return this; },
                getContent() { return html; },
              };
              return output;
            },
          };
          return template;
        },
      },
      console,
    },
  };
}

/** Loads Code.gs into a fresh sandbox and returns {context, services}. */
function loadApp() {
  const services = makeGoogleServices();
  const context = vm.createContext(Object.assign({}, services.globals));
  // Top-level const/let in a script are not context properties, so expose the
  // function declarations (which are) plus CONFIG via a tiny epilogue.
  const code = fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8') + '\n;this.__CONFIG = CONFIG;';
  vm.runInContext(code, context, { filename: 'Code.gs' });
  return { context, services };
}

/** Mimics google.script.run: only global functions without a trailing "_". */
function callServer(context, fn, args) {
  if (!/^[A-Za-z$][\w$]*$/.test(fn) || fn.endsWith('_') || typeof context[fn] !== 'function') {
    throw new Error('Script function not found: ' + fn);
  }
  const value = context[fn](...args);
  // google.script.run cannot return Dates (they come back as null); mimic it.
  // (toString check, because Dates made inside the vm are from another realm.)
  return JSON.parse(JSON.stringify(value === undefined ? null : value, function (k, v) {
    return Object.prototype.toString.call(this[k]) === '[object Date]' ? null : v;
  }));
}

const SHIM = `<script>
(function () {
  function runner(h) {
    return new Proxy({}, { get: function (_, prop) {
      if (prop === 'withSuccessHandler') return function (fn) { return runner(Object.assign({}, h, { ok: fn })); };
      if (prop === 'withFailureHandler') return function (fn) { return runner(Object.assign({}, h, { fail: fn })); };
      if (prop === 'withUserObject') return function (o) { return runner(Object.assign({}, h, { user: o })); };
      return function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/__rpc/' + String(prop), { method: 'POST', body: JSON.stringify(args) })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if ('error' in res) { if (h.fail) h.fail(new Error(res.error), h.user); }
            else if (h.ok) h.ok(res.value, h.user);
          });
      };
    }});
  }
  window.google = { script: { run: runner({}) } };
})();
</script>`;

function startServer({ port = 8787, latencyMs = 250, quiet = false } = {}) {
  const app = loadApp();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname.startsWith('/__rpc/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => setTimeout(() => {
        let out;
        try {
          out = { value: callServer(app.context, url.pathname.slice(7), JSON.parse(body || '[]')) };
        } catch (err) {
          out = { error: 'Error: ' + err.message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      }, latencyMs));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const output = app.context.doGet({ parameter: Object.fromEntries(url.searchParams) });
      const meta = output.meta.map(([n, c]) => `<meta name="${n}" content="${c}">`).join('');
      const html = output.getContent().replace(/<head>/i, `<head>${meta}<title>${output.title}</title>${SHIM}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
  return new Promise((resolve) => {
    server.listen(port, () => {
      const actualPort = server.address().port;
      // Same as choosing "Set up" in the Sheet menu (it logs the key here).
      if (!quiet) app.context.setup();
      const key = vm.runInContext('ensureAdminKey_()', app.context);
      if (!quiet) {
        console.log(`\nSurvey:    http://localhost:${actualPort}/`);
        console.log(`Owner map: http://localhost:${actualPort}/?view=map   (key: ${key})\n`);
      }
      resolve({ server, port: actualPort, app, adminKey: key });
    });
  });
}

module.exports = { startServer, loadApp, callServer };

if (require.main === module) {
  startServer({ port: Number(process.argv[2]) || 8787 });
}

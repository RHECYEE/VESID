#!/usr/bin/env node
/*
 * End-to-end check of the survey and the owner map against the local preview
 * (dev/preview-server.js). Needs Playwright with Chromium installed.
 *
 *   node dev/e2e-test.js [screenshot-dir]
 *
 * Address lookups (Nominatim) are stubbed so the test is repeatable; map
 * tiles and the Leaflet CDN are loaded for real.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { startServer, loadApp, callServer } = require('./preview-server');

const shotDir = process.argv[2] || null;
const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push(['PASS', name]); },
    (err) => { results.push(['FAIL', name, err]); }
  );
}

const valid = (over) => Object.assign({
  lat: 38.534712, lng: -105.998901, label: 'Miller Ranch', consent: true,
  street: '', name: '', phone: '', notes: '', website: '',
}, over);

async function serverChecks() {
  const { context, services } = loadApp();
  const rpc = (fn, ...args) => callServer(context, fn, args);
  const throwsWith = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

  await check('server: rejects a missing pin', () =>
    throwsWith(() => rpc('submitLocation', valid({ lat: '', lng: '' })), /drop a pin/));
  await check('server: rejects out-of-range coordinates', () =>
    throwsWith(() => rpc('submitLocation', valid({ lat: 91 })), /drop a pin/));
  await check('server: rejects a blank address name', () =>
    throwsWith(() => rpc('submitLocation', valid({ label: '   ' })), /what you call/));
  await check('server: requires consent === true', () =>
    throwsWith(() => rpc('submitLocation', valid({ consent: 'yes' })), /confirm/));
  await check('server: enforces length limits', () =>
    throwsWith(() => rpc('submitLocation', valid({ notes: 'x'.repeat(1001) })), /1000 characters/));
  await check('server: map is locked before setup', () =>
    throwsWith(() => rpc('getSubmissions', 'anything'), /not set up/));

  await check('server: honeypot submissions are accepted but not stored', () => {
    const res = rpc('submitLocation', valid({ website: 'http://spam.example' }));
    assert.equal(res.ok, true);
    const sheet = services.sheets.get('Responses');
    assert.ok(!sheet || sheet.rows.length <= 1, 'bot row was stored');
  });

  await check('server: stores a valid row with user text forced to plain text', () => {
    const res = rpc('submitLocation', valid({ label: '=HYPERLINK("http://x","y")', phone: '+1 555 0100', notes: '3-4' }));
    assert.match(res.reference, /^[0-9A-F]{8}$/);
    const sheet = services.sheets.get('Responses');
    assert.equal(sheet.rows[0][2], 'Address Name');
    const raw = sheet.rawAppends[sheet.rawAppends.length - 1];
    assert.equal(raw[2], '\'=HYPERLINK("http://x","y")');
    assert.equal(raw[7], "'+1 555 0100");
    assert.equal(raw[8], "'3-4");
    assert.equal(Object.prototype.toString.call(raw[0]), '[object Date]');
    assert.equal(raw[3], 38.534712);
    assert.equal(raw[11], 'New');
  });

  await check('server: browser cannot call private helpers', () =>
    throwsWith(() => rpc('ensureAdminKey_'), /not found/));
  await check('server: setup() via browser returns nothing (no key leak)', () => {
    const quiet = context.console;
    context.console = { log() {} };
    try { assert.equal(rpc('setup'), null); } finally { context.console = quiet; }
  });
  await check('server: replaceAdminKey() via browser fails and keeps the key', () => {
    const before = services.props.get('VESID_ADMIN_KEY');
    throwsWith(() => rpc('replaceAdminKey'), /getUi/);
    assert.equal(services.props.get('VESID_ADMIN_KEY'), before);
  });
  await check('server: wrong key is refused', () =>
    throwsWith(() => rpc('getSubmissions', 'wrong'), /not correct/));
  await check('server: right key returns rows with ISO dates (survives google.script.run)', () => {
    const key = services.props.get('VESID_ADMIN_KEY');
    assert.ok(key && key.length >= 32);
    const rows = rpc('getSubmissions', key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, '=HYPERLINK("http://x","y")');
    assert.match(rows[0].submittedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(rows[0].row, 2);
  });
}

const SEARCH_FIXTURE = [
  { lat: '38.534712', lon: '-105.998901', display_name: '123, Main Street, Salida, Chaffee County, Colorado, 81201, United States',
    address: { house_number: '123', road: 'Main Street', town: 'Salida', state: 'Colorado', postcode: '81201' } },
  { lat: '38.540100', lon: '-106.010400', display_name: '123, Main Road, Elsewhere, Colorado, United States',
    address: { house_number: '123', road: 'Main Road', village: 'Elsewhere', state: 'Colorado' } },
];
const REVERSE_FIXTURE = {
  address: { house_number: '125', road: 'Main Street', town: 'Salida', state: 'Colorado', postcode: '81201' },
};

async function stubNominatim(page) {
  await page.route('https://nominatim.openstreetmap.org/**', (route) => {
    const u = new URL(route.request().url());
    const body = u.pathname.startsWith('/search') ? SEARCH_FIXTURE : REVERSE_FIXTURE;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

function trackErrors(page, bucket) {
  page.on('pageerror', (e) => bucket.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') bucket.push('console: ' + m.text()); });
}

async function shot(page, name) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await page.waitForTimeout(900); // let tiles finish
  await page.screenshot({ path: path.join(shotDir, name), fullPage: true });
}

async function browserChecks() {
  const { server, port, app, adminKey } = await startServer({ port: 0, latencyMs: 120, quiet: true });
  const base = `http://localhost:${port}/`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
    const page = await ctx.newPage();
    trackErrors(page, errors);
    await stubNominatim(page);
    await page.goto(base);

    await check('form: renders title from CONFIG and loads Leaflet', async () => {
      await page.waitForFunction(() => window.L && document.querySelector('.leaflet-tile-pane'));
      assert.equal(await page.textContent('#title'), app.context.__CONFIG.title);
    });

    await check('form: empty submit flags pin, address name and consent', async () => {
      await page.click('#submit-btn');
      for (const id of ['q-pin', 'q-label', 'q-consent']) {
        assert.ok(await page.$eval('#' + id, (n) => n.classList.contains('has-error')), id + ' not flagged');
      }
      assert.equal(await page.$eval('#q-street', (n) => n.classList.contains('has-error')), false);
    });

    await check('form: address search lists matches; picking one drops the pin and fills street', async () => {
      await page.fill('#search', '123 Main');
      await page.press('#search', 'Enter');
      await page.waitForSelector('#results:not([hidden]) li button');
      assert.equal(await page.$$eval('#results li button', (b) => b.length), 2);
      await page.click('#results li button >> nth=0');
      await page.waitForSelector('.leaflet-marker-icon.pin');
      assert.match(await page.textContent('#pin-status'), /38\.534712, -105\.998901/);
      assert.equal(await page.inputValue('#street'), '123 Main Street, Salida, Colorado 81201');
      assert.equal(await page.$eval('#q-pin', (n) => n.classList.contains('has-error')), false);
    });

    await check('form: tapping the map moves the pin and re-suggests the street', async () => {
      const before = await page.textContent('#pin-status');
      const box = await page.locator('#map').boundingBox();
      await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.45);
      await page.waitForFunction((b) => document.getElementById('pin-status').textContent !== b, before);
      await page.waitForFunction(() => document.getElementById('street').value.startsWith('125 '));
      assert.equal(await page.$$eval('.leaflet-marker-icon.pin', (m) => m.length), 1);
    });

    await check('form: a typed street address is not overwritten by later pin moves', async () => {
      await page.fill('#street', '125 Main St, Salida CO');
      const box = await page.locator('#map').boundingBox();
      await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5);
      await page.waitForTimeout(1200);
      assert.equal(await page.inputValue('#street'), '125 Main St, Salida CO');
    });

    const xssLabel = '<img src=x onerror="window.__xss=1">Miller Ranch';
    await check('form: valid submit shows confirmation with a reference', async () => {
      await page.fill('#label', xssLabel);
      await page.fill('#name', 'Pat Miller');
      await page.fill('#phone', '+1 555 0100');
      await page.fill('#notes', 'Green gate on the north side. Long gravel driveway.');
      await page.check('#consent');
      await shot(page, 'survey-desktop-filled.png');
      await page.click('#submit-btn');
      await page.waitForSelector('#done:not([hidden])');
      assert.match(await page.textContent('#done-ref'), /^[0-9A-F]{8}$/);
      await shot(page, 'survey-desktop-done.png');
      const sheet = app.services.sheets.get('Responses');
      assert.equal(sheet.rows.length, 2);
      assert.equal(sheet.rows[1][2], xssLabel);
      assert.equal(sheet.rows[1][9], 'Yes');
    });

    await check('form: "Submit another response" resets everything', async () => {
      await page.click('#again-btn');
      await page.waitForSelector('#form:not([hidden])');
      assert.equal(await page.inputValue('#label'), '');
      assert.equal(await page.isChecked('#consent'), false);
      assert.equal(await page.$$eval('.leaflet-marker-icon.pin', (m) => m.length), 0);
    });

    // A few more local sample pins (never committed) so the map has content.
    const rpc = (fn, ...args) => callServer(app.context, fn, args);
    rpc('submitLocation', valid({ lat: 38.5391, lng: -106.0042, label: 'The old schoolhouse', street: '410 F St, Salida, Colorado 81201', consent: true }));
    rpc('submitLocation', valid({ lat: 38.5298, lng: -105.9921, label: 'Blue house past the river bridge', notes: 'Use back door', consent: true }));
    rpc('submitLocation', valid({ lat: 38.5442, lng: -105.9889, label: 'Lot 14, Pine Ridge Park', consent: true }));
    const total = app.services.sheets.get('Responses').rows.length - 1;

    await check('form: "Clear form" needs a second click, then clears', async () => {
      await page.fill('#label', 'Temporary');
      await page.click('#clear-btn');
      assert.equal(await page.inputValue('#label'), 'Temporary');
      assert.equal(await page.textContent('#clear-btn'), 'Click again to clear');
      await page.click('#clear-btn');
      assert.equal(await page.inputValue('#label'), '');
      assert.equal(await page.textContent('#clear-btn'), 'Clear form');
    });

    await check('map: wrong key is refused', async () => {
      await page.goto(base + '?view=map');
      await page.fill('#key', 'not-the-key');
      await page.click('#gate-btn');
      await page.waitForSelector('#gate-error:not([hidden])');
      assert.match(await page.textContent('#gate-error'), /not correct/);
      assert.equal(await page.isHidden('#app'), true);
    });

    await check('map: right key shows every pin with its label', async () => {
      await page.fill('#key', adminKey);
      await page.click('#gate-btn');
      await page.waitForSelector('#app:not([hidden]) .leaflet-marker-icon');
      assert.equal(await page.$$eval('.leaflet-marker-icon.pin', (m) => m.length), total);
      assert.equal(await page.textContent('#count'), total + ' pins');
      const labels = await page.$$eval('.pin-label', (t) => t.map((n) => n.textContent));
      assert.ok(labels.includes(xssLabel), 'label shown literally');
      assert.ok(labels.includes('Lot 14, Pine Ridge Park'));
    });

    await check('map: submitted HTML is shown as text, never run', async () => {
      await page.click('#list li button >> text=Miller Ranch');
      await page.waitForSelector('.leaflet-popup-content .popup');
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.equal(await page.$$eval('.leaflet-popup-content img, #list img', (n) => n.length), 0);
      assert.match(await page.textContent('.leaflet-popup-content'), /Green gate on the north side/);
      await shot(page, 'map-desktop.png');
    });

    await check('map: filter narrows list and pins', async () => {
      await page.fill('#filter', 'pine ridge');
      await page.waitForFunction(() => /^1 of /.test(document.getElementById('count').textContent));
      assert.equal(await page.$$eval('.leaflet-marker-icon.pin', (m) => m.length), 1);
      await page.fill('#filter', '');
      await page.waitForFunction((t) => document.getElementById('count').textContent === t + ' pins', total);
    });

    const download = async (kind) => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`[data-export=${kind}]`)]);
      return fs.readFileSync(await dl.path(), 'utf8');
    };
    await check('map: GeoJSON export has every pin as [lng, lat]', async () => {
      const fc = JSON.parse(await download('geojson'));
      assert.equal(fc.features.length, total);
      const f = fc.features.find((x) => x.properties.label === 'Lot 14, Pine Ridge Park');
      assert.deepEqual(f.geometry.coordinates, [-105.9889, 38.5442]);
    });
    await check('map: KML export is escaped and complete', async () => {
      const kml = await download('kml');
      assert.equal((kml.match(/<Placemark>/g) || []).length, total);
      assert.ok(kml.includes('&lt;img src=x'));
      assert.ok(!kml.includes('<img'));
    });
    await check('map: CSV export has a header plus one line per pin, formulas neutralised', async () => {
      const csv = (await download('csv')).replace(/^\ufeff/, '');
      const lines = csv.split('\r\n');
      assert.equal(lines.length, total + 1);
      assert.ok(csv.includes('"\'=HYPERLINK') || !csv.includes('=HYPERLINK'));
      assert.ok(csv.includes('"\'+1 555 0100"'));
    });

    await check('map: key is remembered on reload, and Lock forgets it', async () => {
      await page.reload();
      await page.waitForSelector('#app:not([hidden]) .leaflet-marker-icon');
      await page.click('#lock-btn');
      await page.waitForSelector('#gate:not([hidden])');
      assert.equal(await page.isHidden('#app'), true);
    });

    await ctx.close();

    // Phone-sized screenshots and a layout check.
    const phone = await browser.newContext(Object.assign({}, devices['iPhone 13'], { acceptDownloads: true }));
    const p = await phone.newPage();
    trackErrors(p, errors);
    await stubNominatim(p);
    await check('phone: survey fits the screen with no sideways scroll', async () => {
      await p.goto(base);
      await p.waitForSelector('#map .leaflet-tile-loaded');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'horizontal overflow ' + overflow + 'px');
      await p.fill('#search', '123 Main');
      await p.click('#search-btn');
      await p.click('#results li button >> nth=0');
      await p.fill('#label', 'Miller Ranch');
      await p.click('.seg button[data-layer=satellite]');
      await shot(p, 'survey-phone.png');
    });
    await check('phone: owner map fits the screen', async () => {
      await p.goto(base + '?view=map');
      await p.fill('#key', adminKey);
      await p.click('#gate-btn');
      await p.waitForSelector('#app:not([hidden]) .leaflet-marker-icon');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'horizontal overflow ' + overflow + 'px');
      await shot(p, 'map-phone.png');
    });
    await phone.close();

    await check('no JavaScript errors on any page', () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    server.close();
  }
}

(async () => {
  await serverChecks();
  await browserChecks();
  let failed = 0;
  for (const [status, name, err] of results) {
    console.log(`${status}  ${name}`);
    if (err) { failed++; console.log('      ' + String(err && err.stack || err).split('\n').slice(0, 4).join('\n      ')); }
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

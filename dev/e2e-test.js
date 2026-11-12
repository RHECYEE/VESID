#!/usr/bin/env node
/*
 * Browser test of the survey (index.html) and the owner map (map.html).
 * Needs Playwright with Chromium.
 *
 *   node dev/e2e-test.js [screenshot-dir]
 *
 * The Google Form and the "Publish to web" CSV are stubbed, so nothing is sent
 * to Google. Map tiles and the Leaflet CDN load for real.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { startServer } = require('./serve');

const shotDir = process.argv[2] || null;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (err) { results.push(['FAIL', name, err]); }
}

const FORM_ID = '1FAIpQLSdTESTONLY0000000000000000000000000000000000000';
const FORM_LINK = `https://docs.google.com/forms/d/e/${FORM_ID}/viewform?usp=pp_url` +
  '&entry.1111111111=ADDRESS&entry.2222222222=LAT&entry.3333333333=LNG&entry.4444444444=PHONE';
const CENTER = [45.6770, -111.0429];

function configJs(over) {
  const cfg = Object.assign({
    title: 'Voluntary 911 Address Registry', organization: 'Test County 911',
    intro: 'Drop a pin on your home and type the address the way you call it.',
    formLink: FORM_LINK, mapCenter: CENTER, mapZoom: 13, themeColor: '#b3261e',
  }, over);
  return 'window.VESID_CONFIG = ' + JSON.stringify(cfg) + ';';
}

/** Serves a test config.js and records every request to Google / Nominatim. */
async function prepare(page, over, log) {
  await page.route('**/config.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: configJs(over) }));
  await page.route('https://docs.google.com/forms/**', (route) => {
    log.posts.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
    if (log.failNext) { log.failNext = false; return route.abort('internetdisconnected'); }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>ok</html>' });
  });
  page.on('request', (r) => { if (/nominatim/.test(r.url())) log.geocoder.push(r.url()); });
  page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') log.errors.push('console: ' + m.text()); });
}

async function shot(page, name) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(shotDir, name), fullPage: true });
}

async function clickMap(page, fx = 0.5, fy = 0.5) {
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

const SHEET_CSV = [
  'Timestamp,Address,Latitude,Longitude,Phone,Status',
  '11/10/2026 9:14:02,Curly Pig Ranch,45.684210,-111.051230,406-555-0100,Verified',
  '11/10/2026 10:02:44,"John Smith\'s house, east gate",45.672001,-111.031950,,',
  '11/11/2026 8:30:10,175621 HWY 212,45.669500,-111.060010,,New',
  '11/11/2026 8:45:00,"<img src=x onerror=""window.__xss=1"">Bad Label",45.680100,-111.040100,,',
  '11/11/2026 9:00:00,"Line one\nline two",45.675000,-111.045000,,',
  '11/11/2026 9:05:00,No pin row,,,,',
].join('\r\n');

(async () => {
  const { server, port } = await startServer(0);
  const base = `http://localhost:${port}/`;
  const browser = await chromium.launch();
  const log = { posts: [], geocoder: [], errors: [], failNext: false };
  try {
    // ---------------- Survey ----------------
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
    const page = await ctx.newPage();
    await prepare(page, {}, log);
    await page.goto(base);
    await page.waitForSelector('#map .leaflet-tile-loaded');

    await check('survey: configured form hides the setup notice and shows the phone question', async () => {
      assert.equal(await page.isHidden('#setup'), true);
      assert.equal(await page.isVisible('#q-phone'), true);
      assert.match(await page.textContent('#agree'), /Test County 911/);
    });

    await check('survey: has no address search or auto-filled street field', async () => {
      assert.equal(await page.$$eval('input[type=search], #street, #fill-btn', (n) => n.length), 0);
    });

    await check('survey: empty submit flags the pin and the address, sends nothing', async () => {
      await page.click('#submit-btn');
      assert.ok(await page.$eval('#q-pin', (n) => n.classList.contains('has-error')));
      assert.ok(await page.$eval('#q-address', (n) => n.classList.contains('has-error')));
      assert.equal(log.posts.length, 0);
    });

    await check('survey: vague answers are caught, specific ones are not (no pin yet, so nothing is sent)', async () => {
      const verdicts = await page.evaluate(() => {
        const out = {};
        for (const t of ['home', 'my house', "grandma's farm", 'The Ranch', 'Dads place',
          'Curly Pig Ranch', "John Smith's house", '175621 HWY 212', 'Lot 14 Pine Ridge']) {
          document.getElementById('address').value = t;
          document.getElementById('q-address').classList.remove('has-warn', 'has-error');
          document.getElementById('submit-btn').click();
          out[t] = document.getElementById('q-address').classList.contains('has-warn');
        }
        document.getElementById('address').value = '';
        return out;
      });
      assert.deepEqual(verdicts, {
        home: true, 'my house': true, "grandma's farm": true, 'The Ranch': true, 'Dads place': true,
        'Curly Pig Ranch': false, "John Smith's house": false, '175621 HWY 212': false, 'Lot 14 Pine Ridge': false,
      });
      assert.equal(log.posts.length, 0);
    });

    await check('survey: tapping the map drops a pin and zooms in', async () => {
      await clickMap(page, 0.5, 0.5);
      await page.waitForSelector('.leaflet-marker-icon.pin');
      assert.match(await page.textContent('#pin-status'), /^Pin placed at 45\.\d{6}, -111\.\d{6}/);
      assert.equal(await page.evaluate(() => document.querySelector('.leaflet-marker-icon.pin') !== null), true);
      assert.equal(await page.$eval('#q-pin', (n) => n.classList.contains('has-error')), false);
    });

    await check('survey: a second tap moves the same pin (still one pin)', async () => {
      const before = await page.textContent('#pin-status');
      await clickMap(page, 0.56, 0.47);
      await page.waitForFunction((b) => document.getElementById('pin-status').textContent !== b, before);
      assert.equal(await page.$$eval('.leaflet-marker-icon.pin', (m) => m.length), 1);
    });

    await check('survey: "Mom\'s house" gets a vague-answer warning and is not sent', async () => {
      await page.fill('#address', 'Mom\u2019s house');
      await page.click('#submit-btn');
      assert.ok(await page.$eval('#q-address', (n) => n.classList.contains('has-warn')));
      assert.match(await page.textContent('#address-msg'), /too vague/);
      assert.equal(log.posts.length, 0);
    });

    await check('survey: pressing Submit again keeps a vague answer the person insists on', async () => {
      await clickMap(page, 0.5, 0.5);
      await page.fill('#address', 'Home');
      await page.click('#submit-btn');
      assert.equal(log.posts.length, 0);
      await page.click('#submit-btn');
      await page.waitForSelector('#done:not([hidden])');
      assert.equal(log.posts.length, 1);
      await page.click('#again-btn');
      log.posts.length = 0;
    });

    await check('survey: sends address, pin and phone to the Google Form', async () => {
      await clickMap(page, 0.5, 0.5);
      await page.fill('#address', 'Curly Pig Ranch');
      await page.fill('#phone', '406-555-0100');
      await shot(page, 'survey-desktop.png');
      const status = await page.textContent('#pin-status');
      const [lat, lng] = status.match(/(-?\d+\.\d{6}), (-?\d+\.\d{6})/).slice(1);
      await page.click('#submit-btn');
      await page.waitForSelector('#done:not([hidden])');
      assert.equal(log.posts.length, 1);
      const post = log.posts[0];
      assert.equal(post.method, 'POST');
      assert.equal(post.url, `https://docs.google.com/forms/d/e/${FORM_ID}/formResponse`);
      const sent = Object.fromEntries(new URLSearchParams(post.body));
      assert.deepEqual(sent, {
        'entry.1111111111': 'Curly Pig Ranch', 'entry.2222222222': lat,
        'entry.3333333333': lng, 'entry.4444444444': '406-555-0100',
      });
      await shot(page, 'survey-done.png');
    });

    await check('survey: "Submit another address" clears the pin and answers', async () => {
      await page.click('#again-btn');
      assert.equal(await page.inputValue('#address'), '');
      assert.equal(await page.inputValue('#phone'), '');
      assert.equal(await page.$$eval('.leaflet-marker-icon.pin', (m) => m.length), 0);
    });

    await check('survey: a network failure shows an error and keeps the answers', async () => {
      log.posts.length = 0;
      log.failNext = true;
      await clickMap(page, 0.5, 0.5);
      await page.fill('#address', '175621 HWY 212');
      await page.click('#submit-btn');
      await page.waitForSelector('#submit-error:not([hidden])');
      assert.match(await page.textContent('#submit-error'), /Could not send/);
      assert.equal(await page.isVisible('#form'), true);
      assert.equal(await page.inputValue('#address'), '175621 HWY 212');
    });

    await check('survey: never contacts an address lookup service', async () => {
      assert.deepEqual(log.geocoder, []);
    });
    await ctx.close();

    await check('survey: without formLink it says setup is needed and sends nothing', async () => {
      const c = await browser.newContext();
      const p = await c.newPage();
      const l = { posts: [], geocoder: [], errors: [] };
      await prepare(p, { formLink: '' }, l);
      await p.goto(base);
      await p.waitForSelector('#map .leaflet-tile-loaded');
      assert.equal(await p.isVisible('#setup'), true);
      assert.equal(await p.isHidden('#q-phone'), true);
      await clickMap(p);
      await p.fill('#address', 'Curly Pig Ranch');
      await p.click('#submit-btn');
      await p.waitForSelector('#submit-error:not([hidden])');
      assert.match(await p.textContent('#submit-error'), /not set up/);
      assert.equal(l.posts.length, 0);
      log.errors.push(...l.errors);
      await c.close();
    });

    await check('survey: a form link without a PHONE question hides the phone field', async () => {
      const c = await browser.newContext();
      const p = await c.newPage();
      const l = { posts: [], geocoder: [], errors: [] };
      await prepare(p, { formLink: FORM_LINK.replace('&entry.4444444444=PHONE', '') }, l);
      await p.goto(base);
      await p.waitForSelector('#map .leaflet-tile-loaded');
      assert.equal(await p.isHidden('#setup'), true);
      assert.equal(await p.isHidden('#q-phone'), true);
      log.errors.push(...l.errors);
      await c.close();
    });

    // ---------------- Owner map ----------------
    const mctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
    const m = await mctx.newPage();
    await prepare(m, {}, log);
    const LIVE = 'https://docs.google.com/spreadsheets/d/e/2PACX-TEST/pub?gid=0&single=true&output=csv';
    let liveBody = SHEET_CSV;
    await m.route('https://docs.google.com/spreadsheets/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/csv', headers: { 'Access-Control-Allow-Origin': '*' }, body: liveBody }));
    const csvFile = path.join(require('os').tmpdir(), 'vesid-test-responses.csv');
    fs.writeFileSync(csvFile, SHEET_CSV);

    await m.goto(base + 'map.html');
    await check('map: asks you to open your responses first', async () => {
      assert.equal(await m.isVisible('#start'), true);
    });

    await check('map: opening the Sheet CSV shows every pinned row, labelled', async () => {
      await m.setInputFiles('#file-start', csvFile);
      await m.waitForSelector('#start', { state: 'hidden' });
      assert.equal(await m.$$eval('.leaflet-marker-icon.pin', (x) => x.length), 5);
      assert.equal(await m.textContent('#count'), '5 pins');
      const labels = await m.$$eval('.pin-label', (t) => t.map((n) => n.textContent));
      for (const want of ['Curly Pig Ranch', "John Smith's house, east gate", '175621 HWY 212', 'Line one\nline two']) {
        assert.ok(labels.includes(want), 'missing label ' + JSON.stringify(want));
      }
    });

    await check('map: submitted HTML is shown as text, never run', async () => {
      assert.equal(await m.evaluate(() => window.__xss), undefined);
      assert.equal(await m.$$eval('#list img, .leaflet-tooltip img', (x) => x.length), 0);
      const labels = await m.$$eval('.pin-label', (t) => t.map((n) => n.textContent));
      assert.ok(labels.some((l) => l.startsWith('<img src=x')));
    });

    await check('map: Status column colours pins (Verified is green)', async () => {
      const fills = await m.$$eval('.leaflet-marker-icon.pin path', (p) => p.map((x) => x.getAttribute('fill')));
      assert.equal(fills.filter((f) => f === '#188038').length, 1);
    });

    await check('map: clicking a list item opens its popup', async () => {
      await m.click('#list li button >> text=Curly Pig Ranch');
      await m.waitForSelector('.leaflet-popup-content .popup');
      assert.match(await m.textContent('.leaflet-popup-content'), /406-555-0100/);
      await shot(m, 'map-desktop.png');
    });

    await check('map: filter narrows the pins', async () => {
      await m.fill('#filter', 'hwy');
      await m.waitForFunction(() => document.getElementById('count').textContent === '1 of 5 pins');
      await m.fill('#filter', '');
      await m.waitForFunction(() => document.getElementById('count').textContent === '5 pins');
    });

    const dl = async (kind) => {
      const [d] = await Promise.all([m.waitForEvent('download'), m.click(`[data-export=${kind}]`)]);
      return fs.readFileSync(await d.path(), 'utf8');
    };
    await check('map: KML export is complete and escaped', async () => {
      const kml = await dl('kml');
      assert.equal((kml.match(/<Placemark>/g) || []).length, 5);
      assert.ok(kml.includes('<name>Curly Pig Ranch</name>'));
      assert.ok(kml.includes('-111.05123,45.68421,0'));
      assert.ok(!kml.includes('<img'));
    });
    await check('map: GeoJSON export uses [lng, lat]', async () => {
      const fc = JSON.parse(await dl('geojson'));
      assert.equal(fc.features.length, 5);
      const f = fc.features.find((x) => x.properties.address === '175621 HWY 212');
      assert.deepEqual(f.geometry.coordinates, [-111.06001, 45.6695]);
    });

    await check('map: a CSV without Latitude/Longitude gives a clear error', async () => {
      const bad = path.join(require('os').tmpdir(), 'vesid-bad.csv');
      fs.writeFileSync(bad, 'Name,Thing\nA,B\n');
      await m.setInputFiles('#file-top', bad);
      await m.waitForFunction(() => /Latitude/.test(document.getElementById('status').textContent));
      assert.ok(await m.$eval('#status', (s) => s.classList.contains('error')));
    });

    await check('map: live link loads, is remembered on reload, and refreshes', async () => {
      await m.click('#link-btn');
      await m.fill('#link-input', LIVE);
      await m.click('#link-form button[type=submit]');
      await m.waitForFunction(() => /from your live link/.test(document.getElementById('status').textContent));
      assert.equal(await m.textContent('#count'), '5 pins');
      await m.waitForSelector('#refresh-btn:not([hidden])');
      await m.reload();
      await m.waitForFunction(() => document.getElementById('count').textContent === '5 pins');
      liveBody = SHEET_CSV + '\r\n11/12/2026 7:00:00,Hilltop Water Tower Place,45.690000,-111.020000,,';
      await m.click('#refresh-btn');
      await m.waitForFunction(() => document.getElementById('count').textContent === '6 pins');
    });

    await check('map: a link that returns a web page explains what to use instead', async () => {
      liveBody = '<!DOCTYPE html><html><body>Sheet</body></html>';
      await m.click('#refresh-btn');
      await m.waitForFunction(() => /not a CSV/.test(document.getElementById('status').textContent));
      liveBody = SHEET_CSV;
    });

    await check('map: Forget link removes it from this device', async () => {
      await m.click('#link-btn');
      await m.click('#forget-btn');
      await m.reload();
      assert.equal(await m.isVisible('#start'), true);
      assert.equal(await m.isHidden('#refresh-btn'), true);
    });
    await mctx.close();

    // ---------------- Phone ----------------
    const ph = await browser.newContext(Object.assign({}, devices['iPhone 13'], { acceptDownloads: true }));
    const p = await ph.newPage();
    await prepare(p, {}, log);
    await check('phone: survey fits with no sideways scroll', async () => {
      await p.goto(base);
      await p.waitForSelector('#map .leaflet-tile-loaded');
      await p.click('.seg button[data-layer=satellite]');
      await clickMap(p, 0.5, 0.5);
      await p.fill('#address', 'Curly Pig Ranch');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'horizontal overflow ' + overflow + 'px');
      await shot(p, 'survey-phone.png');
    });
    await check('phone: owner map fits with no sideways scroll', async () => {
      await p.goto(base + 'map.html');
      await p.setInputFiles('#file-start', csvFile);
      await p.waitForSelector('#start', { state: 'hidden' });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'horizontal overflow ' + overflow + 'px');
      await shot(p, 'map-phone.png');
    });
    await ph.close();

    await check('no JavaScript errors on any page', () => {
      assert.deepEqual(log.errors.filter((e) => !/net::ERR_INTERNET_DISCONNECTED/.test(e)), []);
    });
  } finally {
    await browser.close();
    server.close();
  }

  let failed = 0;
  for (const [status, name, err] of results) {
    console.log(`${status}  ${name}`);
    if (err) { failed++; console.log('      ' + String((err && err.stack) || err).split('\n').slice(0, 5).join('\n      ')); }
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

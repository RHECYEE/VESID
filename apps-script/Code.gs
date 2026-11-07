/**
 * @OnlyCurrentDoc
 *
 * VESID: voluntary 911 address pin survey.
 *
 * Residents open the survey link, drop a pin on their home, say what they
 * call that address, and submit. Each response becomes a row in this Google
 * Sheet. The owner views every pin on a private map (?view=map + access key).
 *
 * Setup steps are in README.md.
 *
 * Note: every top-level function WITHOUT a trailing underscore can be called
 * from the browser via google.script.run, so helpers end in "_".
 */

// ---- Edit these to fit your community -------------------------------------
const CONFIG = {
  title: 'Voluntary 911 Address Registry',
  // Who receives the responses, shown on the survey (e.g. 'Smith County 911').
  organization: '',
  intro:
    'Help emergency responders find your home faster. Drop a pin exactly ' +
    'where your home is and tell us what you call it. Sharing is completely ' +
    'voluntary.',
  // Where the map starts: [latitude, longitude] and zoom (4 = whole US,
  // 10 = a county, 13 = a town).
  mapCenter: [39.8283, -98.5795],
  mapZoom: 4,
  // Limit address search to these countries (ISO codes, e.g. 'us' or 'us,ca').
  // Leave '' to search worldwide.
  searchCountryCodes: 'us',
  themeColor: '#b3261e',
  sheetName: 'Responses',
};
// ---------------------------------------------------------------------------

const HEADERS = [
  'Submitted At',
  'Reference',
  'Address Name',
  'Latitude',
  'Longitude',
  'Street Address',
  'Contact Name',
  'Phone',
  'Notes for Responders',
  'Consent',
  'Map Link',
  'Status',
];

const LIMITS = { label: 120, street: 200, name: 100, phone: 40, notes: 1000 };
const ADMIN_KEY_PROP = 'VESID_ADMIN_KEY';

/** Serves the survey (default) or the owner map (?view=map). */
function doGet(e) {
  const isMap = !!(e && e.parameter && e.parameter.view === 'map');
  const template = HtmlService.createTemplateFromFile(isMap ? 'Map' : 'Form');
  template.configJson = safeJson_(publicConfig_());
  return template
    .evaluate()
    .setTitle(isMap ? CONFIG.title + ' - Map' : CONFIG.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called by the survey page. Validates and stores one response. */
function submitLocation(payload) {
  const clean = validateSubmission_(payload);
  const reference = Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  // Honeypot field filled in: almost certainly a bot. Pretend success.
  if (clean.isBot) return { ok: true, reference: reference };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    getResponsesSheet_().appendRow([
      new Date(),
      reference,
      asText_(clean.label),
      clean.lat,
      clean.lng,
      asText_(clean.street),
      asText_(clean.name),
      asText_(clean.phone),
      asText_(clean.notes),
      'Yes',
      'https://www.google.com/maps/search/?api=1&query=' + clean.lat + ',' + clean.lng,
      'New',
    ]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, reference: reference };
}

/** Called by the owner map page. Returns every response with a valid pin. */
function getSubmissions(key) {
  requireAdminKey_(key);
  const values = getResponsesSheet_().getDataRange().getValues();
  if (values.length < 2) return [];

  const header = values[0].map(String);
  const col = function (name) { return header.indexOf(name); };
  const idx = {
    submittedAt: col('Submitted At'),
    reference: col('Reference'),
    label: col('Address Name'),
    lat: col('Latitude'),
    lng: col('Longitude'),
    street: col('Street Address'),
    name: col('Contact Name'),
    phone: col('Phone'),
    notes: col('Notes for Responders'),
    status: col('Status'),
  };
  const read = function (row, i) {
    if (i < 0) return '';
    const v = row[i];
    // google.script.run cannot return Date objects; send ISO strings.
    if (v instanceof Date) return v.toISOString();
    return v === null || v === undefined ? '' : String(v);
  };

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const lat = Number(row[idx.lat]);
    const lng = Number(row[idx.lng]);
    if (!isFinite(lat) || !isFinite(lng) || row[idx.lat] === '' || row[idx.lng] === '') continue;
    out.push({
      row: r + 1,
      submittedAt: read(row, idx.submittedAt),
      reference: read(row, idx.reference),
      label: read(row, idx.label),
      lat: lat,
      lng: lng,
      street: read(row, idx.street),
      name: read(row, idx.name),
      phone: read(row, idx.phone),
      notes: read(row, idx.notes),
      status: read(row, idx.status) || 'New',
    });
  }
  return out;
}

// ---- Sheet menu (owner only) ----------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('911 Address Map')
    .addItem('Set up / show map access key', 'setup')
    .addItem('Replace map access key', 'replaceAdminKey')
    .addToUi();
}

/**
 * Creates the Responses tab and the map access key (only if missing), then
 * shows the key. Safe to run more than once. Never returns the key, so a
 * browser calling it through google.script.run learns nothing.
 */
function setup() {
  getResponsesSheet_();
  const key = ensureAdminKey_();
  const message =
    'The Responses tab is ready.\n\n' +
    'Map access key (keep it private):\n' + key + '\n\n' +
    'After you deploy (Deploy > New deployment > Web app), open your web app URL ' +
    'with ?view=map on the end and enter this key to see every pin.';
  try {
    SpreadsheetApp.getUi().alert('911 Address Map', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (err) {
    // Run from the script editor: no UI there, so print to the execution log.
    console.log(message);
  }
}

/** Replaces the access key. Anyone holding the old key loses map access. */
function replaceAdminKey() {
  // getUi() throws outside the Sheet, so a browser cannot trigger this.
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'Replace map access key?',
    'Anyone using the current key will need the new one.',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;
  const key = newKey_();
  PropertiesService.getScriptProperties().setProperty(ADMIN_KEY_PROP, key);
  ui.alert('New map access key', key, ui.ButtonSet.OK);
}

// ---- Helpers (private: trailing underscore) -------------------------------

function publicConfig_() {
  return {
    title: CONFIG.title,
    organization: CONFIG.organization,
    intro: CONFIG.intro,
    mapCenter: CONFIG.mapCenter,
    mapZoom: CONFIG.mapZoom,
    searchCountryCodes: CONFIG.searchCountryCodes,
    themeColor: CONFIG.themeColor,
    limits: LIMITS,
  };
}

function validateSubmission_(p) {
  if (!p || typeof p !== 'object') throw new Error('Nothing was submitted.');

  const text = function (value, max, label) {
    const s = value === undefined || value === null ? '' : String(value).trim();
    if (s.length > max) throw new Error(label + ' must be ' + max + ' characters or fewer.');
    return s;
  };

  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (p.lat === '' || p.lng === '' || p.lat === null || p.lng === null ||
      !isFinite(lat) || !isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error('Please drop a pin on the map.');
  }

  const label = text(p.label, LIMITS.label, 'Address name');
  if (!label) throw new Error('Please say what you call this address.');
  if (p.consent !== true) throw new Error('Please confirm you agree to share this location.');

  return {
    isBot: !!(p.website && String(p.website).trim()),
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    label: label,
    street: text(p.street, LIMITS.street, 'Street address'),
    name: text(p.name, LIMITS.name, 'Name'),
    phone: text(p.phone, LIMITS.phone, 'Phone'),
    notes: text(p.notes, LIMITS.notes, 'Notes'),
  };
}

/**
 * Stores user text as plain text: the leading apostrophe stops Sheets from
 * running "=..." as a formula or turning "3-4" into a date. Sheets hides the
 * apostrophe and getValues() returns the text without it.
 */
function asText_(s) {
  return s ? "'" + s : '';
}

function getResponsesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('This script must be attached to a Google Sheet (open the Sheet, then Extensions > Apps Script).');
  }
  let sheet = ss.getSheetByName(CONFIG.sheetName);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureAdminKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty(ADMIN_KEY_PROP);
  if (!key) {
    key = newKey_();
    props.setProperty(ADMIN_KEY_PROP, key);
  }
  return key;
}

function newKey_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function requireAdminKey_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty(ADMIN_KEY_PROP);
  if (!expected) {
    throw new Error('The map is not set up yet. In the Google Sheet, choose 911 Address Map > Set up.');
  }
  if (typeof key !== 'string' || key.trim() !== expected) {
    throw new Error('That access key is not correct.');
  }
}

/** JSON that is safe to place inside a <script> tag. */
function safeJson_(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

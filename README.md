# VESID: Voluntary 911 Address Pins

A survey that looks like a Google Form, where residents can choose to share
where their home is for 911:

1. **Drop a pin** on their home. They can search an address, use their current
   location, or tap the map, and switch to a satellite view to put the pin on
   the right building.
2. **Say what they call that address**, for example "Grandma's farm", "the blue
   house past the Cedar Creek bridge", or "Lot 14, Pine Ridge Park".
3. Optionally add a street address (filled in from the pin when possible), a
   name, a phone number, and notes for responders. They must tick a consent box.
4. **Submit.** Each response becomes a row in **your** Google Sheet. You see
   every pin, with its name, on a private map, and can export the pins as CSV,
   GeoJSON or KML.

Everything runs as a free Google Apps Script attached to a Google Sheet, so
you don't need a server or a separate hosting account.

```
apps-script/
  Code.gs          server: saves responses, serves the pages, Sheet menu
  Form.html        the survey residents fill in
  Map.html         your private map of every response
  appsscript.json  optional manifest (only needed if you deploy with clasp)
dev/
  preview-server.js  run the survey locally with a fake Sheet
  e2e-test.js        browser test of the survey and the map
```

## Set it up (about 10 minutes)

1. **Create a Google Sheet** (go to <https://sheets.new>) and give it a name,
   such as "911 Address Pins".
2. In the Sheet, open **Extensions > Apps Script**.
3. **Code.gs:** delete what is in the editor, then paste in all of
   [`apps-script/Code.gs`](apps-script/Code.gs). Edit the `CONFIG` block at the
   top:
   - `organization`: who receives the responses (shown on the survey).
   - `mapCenter` and `mapZoom`: where the map opens. To get coordinates,
     right-click your town in Google Maps and click the numbers at the top of
     the menu to copy them. Use zoom `10` for a county or `13` for a town.
   - `searchCountryCodes`: `'us'` by default.
4. **Form and Map pages:** click **+** next to *Files*, choose **HTML**, and
   name it exactly `Form`. Paste in
   [`apps-script/Form.html`](apps-script/Form.html). Do the same with a file
   named exactly `Map`, pasting in [`apps-script/Map.html`](apps-script/Map.html).
5. Click **Save** (the disk icon).
6. Go back to the Sheet tab and **reload it**. A **911 Address Map** menu
   appears. Choose **911 Address Map > Set up / show map access key**.
   - The first time, Google asks you to authorize the script. Choose your
     account. On "Google hasn't verified this app", click **Advanced > Go to
     (your project) (unsafe)** and then **Allow**. This is your own script.
     Then click the menu item again.
   - A **Responses** tab is created, and you are shown your **map access
     key**. Keep it private.
7. Back in Apps Script, click **Deploy > New deployment**. Click the gear,
   choose **Web app**, and set:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**

   Click **Deploy**, then copy the **Web app URL** (it ends in `/exec`).

You now have two links:

| Link | Who it's for |
| --- | --- |
| `https://script.google.com/macros/s/.../exec` | **The survey.** Share it with residents. |
| `https://script.google.com/macros/s/.../exec?view=map` | **Your map.** Enter the access key to see every pin. |

### After you change the code or `CONFIG`

Go to **Deploy > Manage deployments**, click the pencil, set *Version* to
**New version**, and click **Deploy**. The links stay the same. Saving the
code without doing this does not change the live survey.

## Using the responses

- **The Sheet:** each response is one row: time, reference number, address
  name, latitude, longitude, street address, contact name, phone, notes,
  consent, a Google Maps link, and **Status**.
- **Status:** new responses are `New` (red pins). Change a cell to `Verified`
  once you've checked it and the pin turns green. Any other value shows grey.
  Click **Refresh** on the map to see changes.
- **Get an email when someone responds:** in the Sheet, use **Tools >
  Notification settings > Edit notifications**.
- **Exports:** the map's **CSV**, **GeoJSON** and **KML** buttons download the
  pins currently shown (the filter applies). KML opens in Google Earth, and
  GeoJSON or KML import into most GIS and 911 mapping systems (ArcGIS, QGIS,
  and others). If your browser blocks the download, use **File > Download >
  CSV** in the Sheet instead.
- **Map access key:** anyone with the key can see every response. To revoke
  it, choose **911 Address Map > Replace map access key**. **Lock** on the map
  page makes that device forget the key.

## Privacy and limits

- Responses are stored only in your Google Sheet. Anyone you share the Sheet
  with can read them, and the map page needs the access key.
- The script does not record respondents' IP addresses or Google accounts.
  Respondents don't need a Google account.
- Address search and the "Fill from pin" lookup send the search text and pin
  coordinates to OpenStreetMap's Nominatim service. Map tiles come from
  OpenStreetMap, and satellite images come from Esri. These services are free
  for light use with attribution. For a large campaign (thousands of people at
  once), check the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
  and Esri's terms, or switch to a paid provider.
- Text people type is saved as plain text: it can't become a spreadsheet
  formula, and it's shown as text on the map.
- Google shows a "created by another user" banner above web apps run from
  personal Google accounts. That's normal.
- Some browsers may block "Use my current location" inside Google's page. If
  that happens the survey says so, and searching or tapping the map still
  works.
- This is a voluntary supplement. It does not change official 911 addressing,
  so share the exports with your 911 center or county GIS office.

## Development

Run the survey locally against a fake, in-memory Sheet. Nothing is sent to
Google.

```bash
node dev/preview-server.js        # prints the survey and map URLs and the key
node dev/e2e-test.js [shots-dir]  # server checks plus a browser test (needs Playwright + Chromium)
```

# VESID: Voluntary 911 Address Pins

A survey that looks like a Google Form. Residents open a link (no sign-in),
**drop a pin on their home**, **type the address the way they call it**, and
submit. Each response goes into **your Google Form** and its Google Sheet.
You then see every pin, labelled, on your own map.

Good answers: `Curly Pig Ranch`, `John Smith's house`, `175621 HWY 212`.
Too vague: `Mom's house`. The survey warns about vague answers once before it
sends them.

The survey never looks addresses up or fills them in automatically. People
drop the pin and type the address themselves.

| File | What it is |
| --- | --- |
| `index.html` | The survey residents fill in |
| `map.html` | Your map of every response |
| `config.js` | Your settings: Google Form link, title, where the map starts |
| `dev/` | Local preview and automated test (for development) |

## Setup

### 1. Make the Google Form (5 minutes)

1. Go to <https://forms.new>. Give the form a title, such as "911 Address Pins".
2. Add these **Short answer** questions, named exactly:
   - `Address`
   - `Latitude`
   - `Longitude`
   - `Phone` (optional: if you leave it out, the survey has no phone box)
3. Open the **Settings** tab. Under *Responses*, keep **Collect email
   addresses** set to *Do not collect*, keep **Limit to 1 response** **off**,
   and don't set **Send responders a copy** to *Always*. Any of these makes
   Google ask people to sign in. Don't add a file-upload question either,
   because that also needs sign-in.
4. Click **Publish** (top right). Next to **Responders**, click **Manage** and
   choose **Anyone with the link**. A form that isn't published, or is set to
   *Restricted*, sends everyone to a Google sign-in page.
5. Open the **Responses** tab:
   - Click **Link to Sheets**, then **Create**. Responses now also go to a
     Google Sheet.
   - Click the **⋮** menu, then **Get email notifications for new responses**,
     if you want an email for each one.

### 2. Connect the survey to your Form

1. In the form editor, click the **⋮** menu (top right), then **Get pre-filled
   link**.
2. Type these exact words into the questions:

   | Question | Type this |
   | --- | --- |
   | Address | `ADDRESS` |
   | Latitude | `LAT` |
   | Longitude | `LNG` |
   | Phone | `PHONE` |

3. Click **Get link**, then **Copy link**.
4. On GitHub, open [`config.js`](config.js) and click the **pencil** icon. Paste
   the link between the quotes on the `formLink: ''` line, then click
   **Commit changes**.

While you're in `config.js`, set `organization` (who receives the responses),
and set `mapCenter` and `mapZoom` so the map opens on your area. Also set
`serviceArea`: the survey refuses pins farther than `radiusKm` from its
`center`, and your map hides older ones as *Outside area*. Use `radiusKm: 0`
to turn this off. To get
coordinates, right-click your area in Google Maps and click the numbers at the
top of the menu to copy them. Use zoom `10` for a county or `13` for a town.

### 3. Put the survey online (GitHub Pages, free)

1. On the free GitHub plan, Pages needs a **public** repository. Go to
   **Settings → General**, scroll to **Danger Zone**, and click **Change
   visibility → Public**. Only the code becomes public. Responses stay in your
   Google Sheet, never in this repository.
2. Go to **Settings → Pages**. Under *Build and deployment*, set:
   - *Source:* **Deploy from a branch**
   - *Branch:* **ccr-1fbf19ad-njh2bq**, folder **/ (root)**

   Then click **Save**.
3. Wait a minute or two, then reload that settings page. It shows the link.

Your links:

- **Survey (send to residents):** `https://rhecyee.github.io/VESID/`
- **Your map:** `https://rhecyee.github.io/VESID/map.html`

If you'd rather not make the repository public, you can drag the folder onto
<https://app.netlify.com/drop> instead. That needs a free Netlify account.

## Seeing the pins

Open `map.html` and choose one of these:

- **Open CSV:** in the Sheet, choose **File → Download → Comma Separated
  Values (.csv)**, then open that file on the map. The file stays on your
  device.
- **Live link** (updates itself): in the Sheet, choose **File → Share → Publish
  to web**. Pick the **Form Responses 1** tab and **Comma-separated values
  (.csv)**, click **Publish**, and copy the link. Paste it into **Live link** on
  the map. It is remembered in that browser, and **Refresh** pulls in new
  responses. **Anyone who has that link can read the responses**, so keep it
  private. To turn it off, use *Publish to web → Stop publishing*.

On the map you can:

- **Mark checked pins:** add a column named `Status` at the right end of the
  Sheet. Type `Verified` in a row and that pin turns green.
- **Filter out junk:** in that `Status` column, type `Junk` (or `Spam`,
  `Test`, `Delete`). The row is hidden from the map and left out of exports.
  Tick **Show hidden** on the map to review hidden rows. You can also delete
  the row in the Sheet.
- **Export:** **KML** opens in Google Earth and imports into most 911 and GIS
  systems. **GeoJSON** is for GIS tools.

Prefer Google's own map? In [Google My Maps](https://mymaps.google.com), click
**Import** and pick the Sheet. Choose *Latitude* and *Longitude* for the
position and *Address* for the title.

## Not getting responses?

Test the Form the way a resident would. Open its responder link (the part of
`formLink` before `?usp=`, ending in `/viewform`) in a **private or incognito
window**:

- **It asks you to sign in:** residents can't respond, and the survey can't
  detect that. Redo step 1, items 3 and 4, until the Form opens without
  signing in.
- **It opens without sign-in:** submit once through the survey, then check the
  Form's **Responses** tab.

## Good to know

- If someone opens the Google Form directly, it has no map. Add a line to the
  Form's description pointing people to the survey link.
- The survey can't read Google's reply, so it reports "sent" unless the
  internet connection fails. Check the Sheet after your first test.
- Map tiles come from OpenStreetMap, and satellite images come from Esri. Both
  are free for light use with attribution.
- This is a voluntary supplement. It does not change official 911 addressing,
  so share the exports with your 911 center or county GIS office.

## Development

```bash
node dev/serve.js                # http://localhost:8787/ and /map.html
node dev/e2e-test.js [shots-dir] # browser test (needs Playwright + Chromium); Google is stubbed
```

// Settings for the survey (index.html) and your map (map.html).
// Edit on GitHub with the pencil icon, then "Commit changes". See README.md.
window.VESID_CONFIG = {
  title: 'Voluntary 911 Address Registry',

  // Who receives the responses, shown on the survey. Example: 'Smith County 911'
  organization: '',

  intro: 'Help emergency responders find your home. Drop a pin on your home and ' +
    'type the address the way you call it. Sharing is voluntary.',

  // Paste your Google Form's pre-filled link here, between the quotes
  // (README step 2). It starts with https://docs.google.com/forms/d/e/
  formLink: 'https://docs.google.com/forms/d/e/1FAIpQLSetNljHkGsTQnG2wOo9iFIz3sApgVtTQKcK_7C9Dxxp2SUwlQ/viewform?usp=pp_url&entry.1979933496=ADDRESS&entry.510112754=LAT&entry.480992973=LNG&entry.1947435929=PHONE',

  // Where the map starts: [latitude, longitude] and zoom
  // (4 = whole US, 10 = a county, 13 = a town).
  mapCenter: [44.976394976857975, -101.2487890368622],
  mapZoom: 6,

  themeColor: '#b3261e'
};

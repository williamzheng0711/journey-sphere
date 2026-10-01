# Remote embed

JourneySphere owns the map renderer, Leaflet, styles, names, geometry and loading
behavior. A website supplies its layout and a list of visited places.

```html
<script type="module" src="/journey-sphere/embed.js"></script>
<journey-sphere places='["Shanghai", "香港", "Tokyo"]'
  center="31.5,121.8" zoom="4"></journey-sphere>
```

For a remote deployment, publish this complete repository under one immutable
revision and use its full commit SHA in the script URL:
`https://cdn.jsdelivr.net/gh/williamzheng0711/journey-sphere@<full-commit-sha>/embed.js`.
Code and all data must come from that same revision. The older `d883c187` embed
does not contain zoom refinement; pointing a consumer at that release does not
pick up changes to the main branch. The current working tree must be published
before a website can use its new immutable URL.

The script derives package URLs from its own URL. Serve modules with JavaScript
MIME types and anonymous CORS, and serve JSON and styles with their correct MIME
types. Compress static files and use immutable caching for pinned URLs.

For a separate place list, omit the `places` attribute until the list is ready:

```js
const element = document.querySelector('journey-sphere');
const places = await (await fetch('./data/travel-places.json')).json();
await customElements.whenDefined('journey-sphere');
element.places = places;
const journey = await element.ready;
```

Names are normalized and resolved against this atlas. Qualify ambiguous names,
such as `Middlesex County, Massachusetts, USA`. Unknown or ambiguous names show
an error. Stable region IDs also work. Add aliases in `data/place-aliases.json`,
then run `npm run build:embed` in this repository.

`element.ready` resolves when the initial map is usable; `element.journey`
exposes the map API. The default view fits the supplied places. Optional `center`
and `zoom` attributes override it. Set `--journey-sphere-height: 480px` to change
height. `element.reset()` restores visits and the original view. Listen for
`journey-ready` and `journey-error` events. Removal cancels outstanding requests
and destroys the map; reconnecting initializes it again.

First display uses a small overview plus exact selected-region chunks. The
engine and overview start loading before a separately fetched place list is
assigned. Refinement starts only after two frame opportunities: compact visible
country outlines at zoom 4–5.5, and full outlines at zoom 6 and above. Moving away
cancels obsolete requests. Cached detail stays visible during a further upgrade.
The nearest country outline gets a head start; once it finishes, or after two
seconds, other visible countries load with up to three requests at a time.
No full administrative country shard is required for first display, panning,
zooming or selected-region clicks. Call `journey.loadDetails()` when complete
editable administrative context is needed.

Await `journey.loadOutlineDetails()` after changing the view to wait for that
view's refinement, including a retry after a download failure. A failure leaves
the already visible map usable. Geometry remains limited by the atlas sources;
these changes do not invent additional survey precision.

Run the example and browser regression checks with the bundled Playwright
Chromium, or set `PLAYWRIGHT_CHANNEL=chrome` for an installed Google Chrome:

```sh
npm run check
PLAYWRIGHT_MODULE=/path/to/playwright npm run test:embed
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-embed-refinement.mjs
```

The refinement benchmark compares the previous main-branch release by default.
Set `BASELINE_REF` to another Git revision to compare a different release.

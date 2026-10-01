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

The repaint fix is included in `ff0d7d6b095a4b1278e37fc5e40af1410614e864`.
The older `cd88b044655967c8d103e0b2b9c0abf891694294` release still clears the map
briefly during repainting. If a consumer continues to flash after a library
update, check its actual script URL: an immutable pin must also be updated in
the consuming website. Reloading the older pinned URL still loads older code.

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
and `zoom` attributes override the corresponding part of that view. Set
`--journey-sphere-height: 480px` to change height. Listen for `journey-ready` and
`journey-error` events. Removal cancels outstanding requests and destroys the map;
reconnecting initializes it again.

Update `element.places` at any time and await the new `element.ready`. Place lookup
and selected-region downloads happen while the current map remains usable. A
successful update reuses the map, updates its labels and selection, and fits the
new places using any explicit view attributes. It does not reload the overview or
download full administrative country shards. An invalid name or failed download
rejects `ready`, emits `journey-error`, and preserves the working map. Assign the
same places again to retry a failed update. Changing `data-base-url` prepares a
replacement map before removing the working one.

Changing `center` moves the existing map and keeps its current zoom; changing
`zoom` keeps its current center. Both preserve interactive visit changes and
require no place lookup or selected-region download. Removing either attribute
restores that part of the automatic view. If a place update is pending, it uses
the latest view attributes when it commits. Invalid coordinates or zoom values
leave the current map usable and reject `ready`. A successful update emits
`journey-ready` with the current map API.

`element.reset()` restores the most recently applied places. Each successful
place or view-attribute update makes its resulting view the new reset view,
including the center or zoom retained by a view-only update. Later
panning, zooming with the map controls, and toggling visits do not change that
reset baseline.

First display uses a small overview plus exact selected-region chunks. The
engine and overview start loading before a separately fetched place list is
assigned. Refinement starts only after two frame opportunities: compact visible
country outlines at zoom 4–5.5, and full outlines at zoom 6 and above. Moving away
cancels obsolete requests. Cached detail stays visible during a further upgrade.
Boundary and visit updates preserve the displayed map throughout repainting;
completed downloads that leave the visible geometry unchanged skip repainting.
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
PLAYWRIGHT_MODULE=/path/to/playwright npm run test:embed:updates
PLAYWRIGHT_MODULE=/path/to/playwright npm run test:flashing
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-embed-refinement.mjs
```

The refinement benchmark compares the previous main-branch release by default.
Set `BASELINE_REF` to another Git revision to compare a different release.

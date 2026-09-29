# Global scope clarification

User instruction: Hong Kong is only an example; apply the same principle to all parts of the map.

Completion therefore also requires:
- One atlas-wide zoom/viewport refinement path, with no Hong Kong-specific runtime behavior.
- All 259 atlas entries covered by compatible outline metadata; explicit source fallbacks where no separate higher-resolution outline is available.
- Representative visual and interaction checks for Japan, Norway, inland Europe, Alaska, and the date line, retaining canonical ADM1/ADM2 selection geometry and IDs.
- Spatial selection avoids fetching USA/UMI for Hong Kong and USA/Russia for London solely because their country bounding boxes span empty space.
- Startup benchmark checks East Asia, Europe and the Pacific, with five alternating baseline/current measurements per view.

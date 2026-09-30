#!/usr/bin/env node

// Derive a display tier from the exact shipped outlines. Geometry is processed
// only at build time; the browser keeps the same compact transport and decoder.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
const dataDir = path.resolve(argument('--data-dir') || path.join(root, 'data'));
const python = argument('--python') || process.env.JOURNEY_SPHERE_PYTHON || 'python3';
const tolerance = Number(argument('--tolerance') || 700);
if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error('--tolerance must be positive.');
const sourceDir = path.join(dataDir, 'outlines');
const outputDir = path.join(sourceDir, 'overview');
const staging = await mkdtemp(path.join(sourceDir, '.overview-'));

const build = String.raw`
import hashlib, json, math, pathlib, sys, gzip
try:
    import shapely
    from shapely.geometry import MultiPolygon, Polygon
except ImportError:
    raise SystemExit('Outline overview build requires Python with Shapely 2.x; pass --python or JOURNEY_SPHERE_PYTHON.')
if int(shapely.__version__.split('.')[0]) < 2:
    raise SystemExit('Outline overview build requires Shapely 2.x.')

source_dir = pathlib.Path(sys.argv[1])
output_dir = pathlib.Path(sys.argv[2])
tolerance = float(sys.argv[3])
manifest_text = (source_dir / 'manifest.json').read_bytes()
manifest = json.loads(manifest_text)
if manifest.get('format') != 1 or manifest.get('extent') != 2 ** 24 or not isinstance(manifest.get('countries'), dict):
    raise ValueError('Invalid exact outline manifest.')

def decode(feature):
    if feature.get('pathEncoding') != 'relative-delta-v1' or not feature.get('paths'):
        raise ValueError('Overview build requires relative-delta-v1 exact outlines.')
    rings = []
    origin_x = origin_y = 0
    for path in feature['paths']:
        if len(path) < 6 or len(path) % 2 or not all(isinstance(value, int) for value in path):
            raise ValueError('Invalid exact outline ring.')
        origin_x += path[0]
        origin_y += path[1]
        x, y = origin_x, origin_y
        ring = [(x, y)]
        for index in range(2, len(path), 2):
            x += path[index]
            y += path[index + 1]
            ring.append((x, y))
        ring.append(ring[0])
        rings.append(ring)
    widths = feature.get('strokeWidths')
    if widths is not None and len(widths) != len(rings):
        raise ValueError('Stroke widths must identify every exact ring.')
    return rings

def encode(rings):
    paths = []
    origin_x = origin_y = 0
    for ring in rings:
        path = [ring[0][0] - origin_x, ring[0][1] - origin_y]
        origin_x, origin_y = ring[0]
        for previous, point in zip(ring, ring[1:-1]):
            path.extend([point[0] - previous[0], point[1] - previous[1]])
        paths.append(path)
    return paths

def displacement(original, candidate):
    # GEOS retains input vertices. Check their cyclic order and every omitted
    # vertex against its replacement segment, independently of the simplifier.
    points = []
    for point in original[:-1]:
        if not points or point != points[-1]:
            points.append(point)
    while len(points) > 1 and points[-1] == points[0]:
        points.pop()
    indices = {point: index for index, point in enumerate(points)}
    kept = []
    coordinates = []
    for coordinate in list(candidate.coords)[:-1]:
        if not coordinates or coordinate != coordinates[-1]:
            coordinates.append(coordinate)
    while len(coordinates) > 1 and coordinates[-1] == coordinates[0]:
        coordinates.pop()
    for coordinate in coordinates:
        point = tuple(int(value) for value in coordinate)
        if tuple(coordinate) != point or point not in indices:
            raise ValueError('Simplifier introduced a new vertex.')
        kept.append(indices[point])
    if len(kept) < 3 or len(set(kept)) != len(kept):
        raise ValueError('Simplifier collapsed or repeated a ring.')
    start = kept.index(min(kept))
    kept = kept[start:] + kept[:start]
    if kept != sorted(kept):
        raise ValueError('Simplifier changed ring orientation or order.')
    maximum = 0.0
    count = len(points)
    for left, right in zip(kept, kept[1:] + [kept[0] + count]):
        a, b = points[left], points[right % count]
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = dx * dx + dy * dy
        for index in range(left + 1, right):
            point = points[index % count]
            fraction = max(0.0, min(1.0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) if length else 0.0
            error = math.hypot(point[0] - a[0] - fraction * dx, point[1] - a[1] - fraction * dy)
            maximum = max(maximum, error)
    if maximum > tolerance + 1e-6:
        raise ValueError('Simplified boundary exceeds projected error tolerance.')
    ring = [points[index] for index in kept]
    return ring + [ring[0]], maximum

def simplify(feature, rings):
    widths = feature.get('strokeWidths')
    groups = []
    for index, ring in enumerate(rings):
        exterior = widths is None or widths[index] is None
        if exterior:
            groups.append([index, []])
        elif groups:
            groups[-1][1].append(index)
        else:
            raise ValueError('Interior ring has no exterior.')

    # Integer projection can leave rings with fewer than three distinct points.
    # They have no fill area. Keep their transport and stroke metadata exactly;
    # exclude them only from the temporary GEOS validity check.
    polygons = []
    positions = []
    degenerate = 0
    for exterior, holes in groups:
        if len(set(rings[exterior][:-1])) < 3:
            degenerate += 1 + len(holes)
            continue
        retained_holes = [index for index in holes if len(set(rings[index][:-1])) >= 3]
        degenerate += len(holes) - len(retained_holes)
        polygons.append(Polygon(rings[exterior], [rings[index] for index in retained_holes]))
        positions.append([exterior, retained_holes])
    source = MultiPolygon(polygons)
    if not source.is_valid:
        return rings, {'mode': 'exact-invalid-source', 'degenerateRingsRetained': degenerate, 'maxError': 0}
    if not polygons:
        return rings, {'mode': 'exact-degenerate-source', 'degenerateRingsRetained': degenerate, 'maxError': 0}
    candidate = source.simplify(tolerance, preserve_topology=True)
    if candidate.geom_type == 'Polygon' and len(polygons) == 1:
        candidate = MultiPolygon([candidate])
    if candidate.geom_type != 'MultiPolygon' or not candidate.is_valid or len(candidate.geoms) != len(polygons):
        return rings, {'mode': 'exact-topology-fallback', 'degenerateRingsRetained': degenerate, 'maxError': 0}
    result = list(rings)
    maximum = 0.0
    fallback_rings = 0
    try:
        for polygon, (exterior, holes) in zip(candidate.geoms, positions):
            if len(polygon.interiors) != len(holes):
                raise ValueError('Simplification changed the hole count.')
            for index, boundary in [(exterior, polygon.exterior)] + list(zip(holes, polygon.interiors)):
                try:
                    result[index], error = displacement(rings[index], boundary)
                except ValueError:
                    # GEOS can exceed the requested displacement while retaining
                    # a minimum triangle for a tiny island. Preserve that exact
                    # ring, then validate the complete reconstructed geometry.
                    result[index], error = rings[index], 0
                    fallback_rings += 1
                maximum = max(maximum, error)
    except ValueError as error:
        return rings, {'mode': 'exact-error-fallback', 'reason': str(error), 'degenerateRingsRetained': degenerate, 'maxError': 0}
    # Reconstruct from the exact integer transport that will be shipped, then
    # repeat validity and ring-count checks rather than trusting a GEOS object.
    actual = MultiPolygon([Polygon(result[outer], [result[hole] for hole in holes]) for outer, holes in positions])
    if not actual.is_valid:
        return rings, {'mode': 'exact-topology-fallback', 'degenerateRingsRetained': degenerate, 'maxError': 0}
    return result, {'mode': 'topology-preserving', 'degenerateRingsRetained': degenerate,
                    'errorFallbackRingsRetained': fallback_rings, 'maxError': round(maximum, 6)}

def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()

countries = {}
sources = {}
exact_bytes = overview_bytes = 0
for code, entry in sorted(manifest['countries'].items()):
    source_text = (source_dir / (code + '.json')).read_bytes()
    envelope = json.loads(source_text)
    if (envelope.get('format') != manifest['format'] or envelope.get('version') != manifest['version'] or
        envelope.get('extent') != manifest['extent'] or envelope.get('fingerprint') != manifest['fingerprint'] or
        not isinstance(envelope.get('features'), list) or len(envelope['features']) != 1):
        raise ValueError('Exact outline identity mismatch for ' + code)
    feature = envelope['features'][0]
    if feature.get('countryCode') != code or feature.get('bounds') != entry.get('bounds'):
        raise ValueError('Exact country outline mismatch for ' + code)
    rings = decode(feature)
    simplified, audit = simplify(feature, rings)
    feature['paths'] = encode(simplified)
    body = json_bytes(envelope)
    (output_dir / (code + '.json')).write_bytes(body)
    countries[code] = {'file': '../outlines/overview/' + code + '.json', 'sourceSha256': hashlib.sha256(source_text).hexdigest()}
    sources[code] = dict(audit, source='../' + code + '.json', sha256=hashlib.sha256(source_text).hexdigest(), outputSha256=hashlib.sha256(body).hexdigest(),
                        sourceVertices=sum(len(ring) - 1 for ring in rings), vertices=sum(len(ring) - 1 for ring in simplified))
    sources[code]['sourceGzipBytes'] = len(gzip.compress(source_text, mtime=0))
    sources[code]['gzipBytes'] = len(gzip.compress(body, mtime=0))
    exact_bytes += sources[code]['sourceGzipBytes']
    overview_bytes += sources[code]['gzipBytes']

tier_manifest = {key: manifest[key] for key in ['format', 'version', 'extent', 'fingerprint']}
tier_manifest.update(minZoom=4, detailZoom=6, tolerance=tolerance, countries=countries)
(output_dir / 'manifest.json').write_bytes(json_bytes(tier_manifest))
provenance = {'format': 1, 'sourceAttribution': '../sources.json', 'sourceManifestSha256': hashlib.sha256(manifest_text).hexdigest(),
              'algorithm': 'Shapely simplify(preserve_topology=True), with independent integer-ring displacement and validity checks',
              'shapelyVersion': shapely.__version__, 'tolerance': tolerance, 'minZoom': 4, 'detailZoom': 6,
              'degenerateRingPolicy': 'Rings with fewer than three distinct vertices are retained exactly; excluded only from temporary geometry validation.',
              'invalidSourcePolicy': 'Retain the complete exact country geometry; never repair source topology.',
              'countries': sources}
(output_dir / 'provenance.json').write_bytes(json_bytes(provenance))
print(json.dumps({'countries': len(countries), 'tolerance': tolerance, 'exactGzipBytes': exact_bytes,
                  'overviewGzipBytes': overview_bytes, 'simplifiedCountries': sum(value['mode'] == 'topology-preserving' for value in sources.values()),
                  'fallbackCountries': [code for code, value in sources.items() if value['mode'] != 'topology-preserving']}))
`;

try {
  const result = spawnSync(python, ['-c', build, sourceDir, staging, String(tolerance)], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Outline overview build failed.');
  let backup;
  try { await rename(outputDir, `${staging}-previous`); backup = `${staging}-previous`; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(staging, outputDir); }
  catch (error) { if (backup) await rename(backup, outputDir); throw error; }
  if (backup) await rm(backup, { recursive: true, force: true });
  console.log(result.stdout.trim());
} finally {
  await rm(staging, { recursive: true, force: true });
}

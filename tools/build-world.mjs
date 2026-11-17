// Converts Natural Earth 110m admin-0 countries (public domain) into compact data/world.json.
// Usage: node tools/build-world.mjs <path/to/ne_110m_admin_0_countries.geojson>
import fs from 'node:fs';
const src = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const r = (v) => Math.round(v * 10) / 10;
const ring = (pts) => {
  const out = [];
  for (const [x, y] of pts) {
    const p = [r(x), r(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out.length >= 4 ? out : null;
};
const countries = src.features.map((f) => {
  const P = f.properties, g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return {
    id: P.ISO_A3 !== '-99' ? P.ISO_A3 : P.ADM0_A3,
    name: P.NAME_PT || P.NAME,
    nameEn: P.NAME,
    continent: P.CONTINENT,
    labelLon: r(P.LABEL_X), labelLat: r(P.LABEL_Y),
    polygons: polys.map((poly) => poly.map(ring).filter(Boolean)).filter((p) => p.length),
  };
});
const out = { source: 'Natural Earth 1:110m Admin 0 Countries (public domain), naturalearthdata.com', countries };
fs.writeFileSync('data/world.json', JSON.stringify(out));
console.log(countries.length, 'countries', (fs.statSync('data/world.json').size / 1024).toFixed(0), 'KB');

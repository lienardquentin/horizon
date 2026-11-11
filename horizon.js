"use strict";
// What you can see from here. The terrain comes as height tiles; from your eye, lines of sight run out across it
// (the Earth curving away below them, the air bending them a little back down), and a place gets a label only
// if nothing stands between you and it. Directions on screen work as in the sky app: east-north-up unit vectors,
// projected through the phone's orientation.
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const RE = 6371000, REFRACTION = 0.13, RADIUS = 40000, Z = 10;  // Earth radius (m), light bending, how far to look (m), tile zoom
const $ = (s) => document.querySelector(s);
const canvas = $("#view"), g = canvas.getContext("2d"), video = $("#cam");
let W = 0, H = 0, DPR = 1;
function resize() { DPR = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight; canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR); }
addEventListener("resize", resize); resize();
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem("hz." + k)); return v ?? d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem("hz." + k, JSON.stringify(v)); } catch (e) {} };

const PRESETS = [
  { name: "Aiguille du Midi, above Chamonix (the Alps)", lat: 45.8786, lon: 6.8873, az: 200, ground: 3777 },  // the terrace: the tiles blur the needle lower
  { name: "Citadelle de Namur", lat: 50.4547, lon: 4.8548, az: 45 },
  { name: "Signal de Botrange, Belgium's highest point", lat: 50.5013, lon: 6.0939, az: 250 },
  { name: "Ciney", lat: 50.2969, lon: 5.1006, az: 0 },
];
const S = {
  lat: 50.2969, lon: 5.1006, placeName: "", eye: load("eye", 1.7), ground: 0, hv: 0,
  mode: "drag", view: { az: 0, alt: 0.3, fov: 28 }, camFov: load("camFov", 68), yawOffset: load("yawOffset", 0),
  opts: Object.assign({ hidden: false, villages: true, turbines: true, castles: true }, load("opts", {})),
  camera: false, target: null, q: null, aligning: false, selected: null, ready: false, pois: [],
};

// ---- terrain: Terrarium height tiles (a height in each pixel's colour): sharp close by, coarser far away ----
// zoom 12 is about 24 m a pixel here, zoom 10 about 100 m
const LEVELS = [{ z: 12, radius: 4500 }, { z: 10, radius: RADIUS * 1.05 }];
let GRIDS = [];
const tileXY = (lat, lon, z) => { const n = 2 ** z, s = Math.sin(lat * D2R); return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n]; };
async function tile(z, x, y) {
  const img = new Image(); img.crossOrigin = "anonymous";
  img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  await img.decode();
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const cx = c.getContext("2d", { willReadFrequently: true }); cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  return h;
}
async function loadTerrain(progress) {
  const grids = [], jobs = []; let done = 0, total = 0;
  for (const { z, radius } of LEVELS) {
    const dLat = (radius / RE) * R2D, dLon = dLat / Math.cos(S.lat * D2R);
    const [x0, y0] = tileXY(S.lat + dLat, S.lon - dLon, z).map(Math.floor), [x1, y1] = tileXY(S.lat - dLat, S.lon + dLon, z).map(Math.floor);
    const grid = { z, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1, tiles: [] };
    grids.push(grid); total += grid.w * grid.h;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y - y0) * grid.w + (x - x0);
      jobs.push(tile(z, x, y).then((h) => (grid.tiles[i] = h)).catch(() => (grid.tiles[i] = null)).finally(() => progress(++done, total)));
    }
  }
  await Promise.all(jobs);
  GRIDS = grids;
}
function hpx(G, gx, gy) {
  const tx = (gx >> 8) - G.x0, ty = (gy >> 8) - G.y0;
  if (tx < 0 || ty < 0 || tx >= G.w || ty >= G.h) return NaN;
  const t = G.tiles[ty * G.w + tx];
  return t ? t[((gy & 255) << 8) | (gx & 255)] : NaN;
}
function elevAt(lat, lon) {  // metres above sea level, from the sharpest tiles that cover the spot, between the four nearest pixels
  for (const G of GRIDS) {
    const [tx, ty] = tileXY(lat, lon, G.z), gx = tx * 256 - 0.5, gy = ty * 256 - 0.5, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const v = hpx(G, x0, y0) * (1 - fx) * (1 - fy) + hpx(G, x0 + 1, y0) * fx * (1 - fy) + hpx(G, x0, y0 + 1) * (1 - fx) * fy + hpx(G, x0 + 1, y0 + 1) * fx * fy;
    if (!Number.isNaN(v)) return v;
  }
  return 0;
}

// ---- lines of sight ----
const drop = (d) => (d * d) / (2 * RE) * (1 - REFRACTION);  // how far the ground falls away below a straight line, bent air included
const step = (d) => 25 + d * 0.004;  // finer close by, where a small bump hides a lot
// lines of sight start 100 m out: the tiles can't resolve the spot you stand on (a summit's tip, a terrace, a tower's
// foot), and their blur would hide the view straight down from it
const NEAR = 100;
function angleTo(d, h) { return Math.atan2(h - drop(d) - S.hv, d); }
const BANDS = [1500, 4000, 10000, 20000, RADIUS];  // the drawn panorama's layers, near to far
function horizon() {
  // 720 rays, one every half degree: the highest angle the ground reaches is the skyline
  const n = 720, cl = Math.cos(S.lat * D2R);
  S.skyline = new Float32Array(n); S.skyDist = new Float32Array(n); S.bands = BANDS.map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const az = i * 0.5 * D2R, dn = Math.cos(az) / RE * R2D, de = Math.sin(az) / (RE * cl) * R2D;
    let max = -Math.PI / 2, maxD = 0, b = 0;
    for (let d = NEAR; d <= RADIUS; d += step(d)) {
      while (d > BANDS[b]) S.bands[b++][i] = max;
      const a = angleTo(d, elevAt(S.lat + d * dn, S.lon + d * de));
      if (a > max) { max = a; maxD = d; }
    }
    for (; b < BANDS.length; b++) S.bands[b][i] = max;
    S.skyline[i] = max; S.skyDist[i] = maxD;
  }
}
function blockedAt(d, az, h) {  // null when the place is in sight; otherwise how far away the ground that hides it is
  const cl = Math.cos(S.lat * D2R), dn = Math.cos(az * D2R) / RE * R2D, de = Math.sin(az * D2R) / (RE * cl) * R2D, aim = angleTo(d, h);
  for (let x = NEAR; x < d - 80; x += step(x)) if (angleTo(x, elevAt(S.lat + x * dn, S.lon + x * de)) > aim + 0.0006) return x;
  return null;
}

// ---- places, from OpenStreetMap ----
const KINDS = {  // kind: [label, default height (m), priority, how far to look (m)]
  city: ["City", 25, 1, 45000], town: ["Town", 15, 2, 45000], peak: ["Hill", 0, 3, 45000], tower: ["Tower", 60, 4, 35000],
  castle: ["Castle", 20, 6, 12000], village: ["Village", 10, 5, 12000], turbine: ["Wind turbine", 150, 7, 25000],
};
function overpassQuery() {
  const a = (r) => `(around:${r},${S.lat.toFixed(4)},${S.lon.toFixed(4)})`;
  return `[out:json][timeout:25];(node["place"~"^(city|town)$"]["name"]${a(45000)};node["place"="village"]["name"]${a(12000)};` +
    `node["natural"="peak"]["name"]${a(45000)};nwr["man_made"~"^(tower|mast)$"]["name"]${a(35000)};nwr["man_made"="mast"]["height"]${a(25000)};` +
    `node["power"="generator"]["generator:source"="wind"]${a(25000)};nwr["historic"~"^(castle|fort)$"]["name"]${a(12000)};);out center tags;`;
}
async function places() {
  const key = `places.${S.lat.toFixed(2)},${S.lon.toFixed(2)}`, cached = load(key, null);
  if (cached && Date.now() - cached.at < 7 * 864e5) return cached.elements;  // a week: places don't move
  // the public servers fill up at busy times: try each, then wait and go round once more
  const servers = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
  let lastError;
  for (let round = 0; round < 2; round++) {
    if (round) await new Promise((r) => setTimeout(r, 4000));
    for (const url of servers) {
      try {
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);  // a busy server can hold a request for minutes
        const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: overpassQuery() }), signal: ctl.signal }).finally(() => clearTimeout(timer));
        if (!r.ok) throw new Error("HTTP " + r.status);
        const elements = (await r.json()).elements;
        save(key, { at: Date.now(), elements }); return elements;
      } catch (e) { lastError = e; }
    }
  }
  if (cached) return cached.elements;
  throw lastError;
}
function kindOf(t) {
  if (t.place === "city" || t.place === "town" || t.place === "village") return t.place;
  if (t.natural === "peak") return "peak";
  if (t.power === "generator") return "turbine";
  if (t.man_made === "tower" || t.man_made === "mast") return "tower";
  if (t.historic === "castle" || t.historic === "fort") return "castle";
  return null;
}
const num = (v) => { const n = parseFloat(String(v || "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
function placePois(elements) {
  const cl = Math.cos(S.lat * D2R), out = [], seen = new Set();
  for (const e of elements) {
    const t = e.tags || {}, kind = kindOf(t), lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (!kind || lat == null || seen.has(e.type + e.id)) continue;
    seen.add(e.type + e.id);
    const dy = (lat - S.lat) * D2R * RE, dx = (lon - S.lon) * D2R * RE * cl, d = Math.hypot(dx, dy);
    if (d < 150 || d > KINDS[kind][3]) continue;
    const az = (Math.atan2(dx, dy) * R2D + 360) % 360, ground = Math.max(elevAt(lat, lon), kind === "peak" ? num(t.ele) ?? 0 : 0);
    const height = num(t.height) ?? KINDS[kind][1], top = ground + height;
    out.push({ kind, name: t.name || (kind === "turbine" ? "Wind turbine" : t.man_made === "mast" || t["tower:type"] === "communication" ? "Mast" : KINDS[kind][0]), lat, lon, d, az, ground, height, top,
               alt: angleTo(d, top) * R2D, blocked: blockedAt(d, az, top), tags: t, osm: `${e.type}/${e.id}` });
  }
  return out.sort((a, b) => KINDS[a.kind][2] - KINDS[b.kind][2] || a.d - b.d);
}

// ---- getting there: the terrain, the places, what's in sight ----
async function begin(lat, lon, name, ground = null) {
  S.lat = lat; S.lon = lon; S.placeName = name; S.ready = false;
  const status = (text, frac) => { $("#status").hidden = false; $("#status-text").textContent = text; $("#status-bar").style.width = `${Math.round(frac * 100)}%`; };
  status("Reading the terrain…", 0);
  await loadTerrain((k, n) => status(`Reading the terrain… ${k} of ${n}`, (k / n) * 0.6));
  S.ground = ground ?? elevAt(lat, lon); S.hv = S.ground + S.eye;
  status("Working out the skyline…", 0.7);
  await new Promise((r) => setTimeout(r, 30));
  horizon();
  if (S.mode === "drag") {  // frame the landscape: flat country wants a long lens, mountains a wide one
    const top = Math.max(0.2, ...S.skyline) * R2D;
    S.view.fov = Math.max(24, Math.min(70, top * 5)); S.view.alt = top / 3;
  }
  $("#status").hidden = true; S.ready = true; showPlace();
  // the landscape first; the names follow when OpenStreetMap answers
  $("#place").textContent += " · finding places…";
  try { S.pois = placePois(await places()); showPlace(); }
  catch (e) { showPlace(); toast("OpenStreetMap's servers are busy: the skyline only for now. Tap here to try again.", retryPlaces); }
}
async function retryPlaces() {
  toast("Asking OpenStreetMap again…");
  try { S.pois = placePois(await places()); showPlace(); toast(`${S.pois.filter((p) => p.blocked == null).length} places in sight.`); }
  catch (e) { toast("Still busy. Try again in a minute: tap here.", retryPlaces); }
}
function rethink() {  // after a change of eye height: the same terrain and places, new lines of sight
  if (!GRIDS.length) return;
  S.hv = S.ground + S.eye; horizon();
  for (const p of S.pois) { p.alt = angleTo(p.d, p.top) * R2D; p.blocked = blockedAt(p.d, p.az, p.top); }
  showPlace();
}
function showPlace() {
  const vis = S.pois.filter((p) => p.blocked == null).length;
  $("#place").textContent = `${S.placeName ? S.placeName + " · " : ""}${Math.round(S.ground)} m${S.eye > 3 ? ` + ${Math.round(S.eye)} m` : ""} · ${vis} places in sight`;
}

// ---- the phone's orientation (as in the sky app) ----
function matFromEuler(a, b, c) {
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(c), sG = Math.sin(c);
  return [[cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG], [cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB], [-cB * sG, sB, cB * cG]];
}
function m2q(m) {
  const tr = m[0][0] + m[1][1] + m[2][2]; let s;
  if (tr > 0) { s = Math.sqrt(tr + 1) * 2; return [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]; }
  if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; return [(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s]; }
  if (m[1][1] > m[2][2]) { s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; return [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s]; }
  s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; return [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s];
}
function q2m([w, x, y, z]) {
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
}
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((v) => -v); d = -d; }
  if (d > 0.9995) { const r = a.map((v, i) => v + (b[i] - v) * t), n = Math.hypot(...r); return r.map((v) => v / n); }
  const th = Math.acos(d), s = Math.sin(th), k1 = Math.sin((1 - t) * th) / s, k2 = Math.sin(t * th) / s;
  return a.map((v, i) => v * k1 + b[i] * k2);
}
let absoluteSeen = false;
function onOrientation(e, absolute) {
  if (e.alpha == null) return;
  let alpha = e.alpha;
  if (e.webkitCompassHeading != null) { alpha = 360 - e.webkitCompassHeading; absolute = true; }
  if (absolute) absoluteSeen = true; else if (absoluteSeen) return;
  S.target = m2q(matFromEuler(alpha * D2R, e.beta * D2R, e.gamma * D2R)); S.absolute = absolute;
}
addEventListener("deviceorientationabsolute", (e) => onOrientation(e, true));
addEventListener("deviceorientation", (e) => onOrientation(e, e.absolute === true));
const yaw = (v, deg) => { const p = deg * D2R, c = Math.cos(p), s = Math.sin(p); return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]]; };
const altAzVec = (alt, az) => [Math.sin(az * D2R) * Math.cos(alt * D2R), Math.cos(az * D2R) * Math.cos(alt * D2R), Math.sin(alt * D2R)];
const vecAltAz = (v) => [Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D, (Math.atan2(v[0], v[1]) * R2D + 360) % 360];
function view() {
  if (S.mode === "sensors" && S.q) {
    const m = q2m(S.q), th = (screen.orientation ? screen.orientation.angle : window.orientation || 0) * D2R, c = Math.cos(th), s = Math.sin(th);
    const dx = [m[0][0], m[1][0], m[2][0]], dy = [m[0][1], m[1][1], m[2][1]], dz = [m[0][2], m[1][2], m[2][2]];
    return { right: yaw(dx.map((v, i) => v * c - dy[i] * s), S.yawOffset), up: yaw(dx.map((v, i) => v * s + dy[i] * c), S.yawOffset), back: yaw(dz, S.yawOffset), f: H / 2 / Math.tan((S.camFov * D2R) / 2) };
  }
  const az = S.view.az * D2R, alt = S.view.alt * D2R;
  return { right: [Math.cos(az), -Math.sin(az), 0], up: [-Math.sin(az) * Math.sin(alt), -Math.cos(az) * Math.sin(alt), Math.cos(alt)],
           back: [-Math.sin(az) * Math.cos(alt), -Math.cos(az) * Math.cos(alt), -Math.sin(alt)], f: H / 2 / Math.tan((S.view.fov * D2R) / 2) };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function project(V, v) { const depth = -dot(v, V.back); return depth <= 0.02 ? null : [W / 2 + (dot(v, V.right) / depth) * V.f, H / 2 - (dot(v, V.up) / depth) * V.f]; }
const onScreen = (p, m = 0) => p && p[0] > -m && p[0] < W + m && p[1] > -m && p[1] < H + m;

// ---- drawing ----
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const dirName = (az) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(az / 45) % 8];
const km = (d) => (d < 10000 ? (d / 1000).toFixed(1) : Math.round(d / 1000)) + " km";
let shown = [];
function draw() {
  requestAnimationFrame(draw);
  if (!S.ready) return;
  if (S.mode === "sensors" && S.target) S.q = S.q ? slerp(S.q, S.target, 0.18) : S.target;
  const V = view(); S.V = V; shown = [];
  g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, W, H);
  if (S.camera) skylineLine(V); else panorama(V);
  compassTape(V);
  drawPois(V);
  const [alt, az] = vecAltAz(V.back.map((v) => -v));
  $("#looking").textContent = `${DIRS[Math.round(az / 45) % 8]} ${Math.round(az)}° · ${alt >= 0 ? "up" : "down"} ${Math.abs(Math.round(alt))}°`;
}
function visibleRange(V) {  // the skyline's indexes across the view, with some to spare
  const [, az] = vecAltAz(V.back.map((v) => -v)), half = Math.atan((W / 2) / V.f) * R2D + 8, c = Math.round(az * 2), k = Math.min(360, Math.ceil(half * 2));
  return [c - k, c + k];
}
const idx = (i) => ((i % 720) + 720) % 720;
function mix(a, b, t) { const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); const x = p(a), y = p(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",")})`; }
function panorama(V) {
  // no camera: the landscape drawn in layers, the far hills pale with haze, the near ground dark
  const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, "#3f6f9f"); grd.addColorStop(0.55, "#a9c3d6"); grd.addColorStop(1, "#d9e3e6");
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const [i0, i1] = visibleRange(V), far = "#b4c4cf", near = "#26391f";
  for (let b = BANDS.length - 1; b >= 0; b--) {
    g.beginPath(); let started = false;
    for (let i = i0; i <= i1; i++) {
      const p = project(V, altAzVec(S.bands[b][idx(i)] * R2D, idx(i) * 0.5)); if (!p) continue;
      started ? g.lineTo(p[0], p[1]) : (g.moveTo(-50, H + 50), g.lineTo(p[0], p[1]), (started = true));
    }
    if (!started) continue;
    g.lineTo(W + 50, H + 50); g.closePath();
    g.fillStyle = mix(near, far, b / (BANDS.length - 1) * 0.9 + 0.05); g.fill();
  }
}
function skylineLine(V) {  // over the camera: the computed skyline in gold, to check it lies on the real one
  const [i0, i1] = visibleRange(V); g.beginPath(); let pen = false;
  for (let i = i0; i <= i1; i++) { const p = project(V, altAzVec(S.skyline[idx(i)] * R2D, idx(i) * 0.5)); if (!p) { pen = false; continue; } pen ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); pen = true; }
  g.strokeStyle = "rgba(242,196,109,.9)"; g.lineWidth = 1.6; g.shadowColor = "rgba(0,0,0,.6)"; g.shadowBlur = 3; g.stroke(); g.shadowBlur = 0;
}
function compassTape(V) {  // degrees along the bottom of the screen
  const y = H - 26 - (S.selected ? 0 : 0);
  g.font = "600 12px ui-sans-serif, system-ui, sans-serif"; g.textAlign = "center";
  for (let a = 0; a < 360; a += 5) {
    const v = altAzVec(0, a), depth = -dot(v, V.back); if (depth <= 0.05) continue;
    const x = W / 2 + (dot(v, V.right) / depth) * V.f; if (x < 0 || x > W) continue;
    const major = a % 45 === 0;
    g.fillStyle = major ? "#f2c46d" : "rgba(255,255,255,.55)"; g.fillRect(x - 0.5, H - (major ? 14 : 8), 1, major ? 14 : 8);
    if (major) { g.fillText(DIRS[a / 45], x, y); } else if (a % 15 === 0) { g.fillStyle = "rgba(255,255,255,.6)"; g.fillText(a, x, y + 2); }
  }
}
const COLORS = { city: "#ffffff", town: "#ffffff", village: "#e6e9ee", peak: "#f2c46d", tower: "#9fd0ff", castle: "#f0b48a", turbine: "#dfe6ee" };
function icon(kind, x, y) {
  g.fillStyle = g.strokeStyle = COLORS[kind]; g.lineWidth = 1.6;
  if (kind === "peak") { g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 6, y + 3); g.lineTo(x - 6, y + 3); g.closePath(); g.fill(); }
  else if (kind === "tower") { g.fillRect(x - 1, y - 9, 2, 12); g.beginPath(); g.arc(x, y - 10, 2.5, 0, 7); g.fill(); }
  else if (kind === "turbine") { g.beginPath(); g.moveTo(x, y + 4); g.lineTo(x, y - 5); for (const a of [-90, 30, 150]) { g.moveTo(x, y - 5); g.lineTo(x + 6 * Math.cos(a * D2R), y - 5 + 6 * Math.sin(a * D2R)); } g.stroke(); }
  else if (kind === "castle") { g.fillRect(x - 5, y - 4, 10, 7); g.fillRect(x - 5, y - 7, 2, 3); g.fillRect(x - 1, y - 7, 2, 3); g.fillRect(x + 3, y - 7, 2, 3); }
  else { g.beginPath(); g.arc(x, y, kind === "village" ? 3 : 4.5, 0, 7); g.fill(); g.strokeStyle = "rgba(0,0,0,.5)"; g.lineWidth = 1; g.stroke(); }
}
function drawPois(V) {
  // labels stand above their places on leader lines, in rows, the more important first; a label that can't find room is left out
  const placed = [], fov = S.mode === "sensors" ? S.camFov : S.view.fov;
  for (const p of S.pois) {
    const hidden = p.blocked != null;
    if (hidden && !S.opts.hidden && p !== S.selected) continue;
    if ((p.kind === "village" && !S.opts.villages) || (p.kind === "turbine" && !S.opts.turbines) || (p.kind === "castle" && !S.opts.castles)) continue;
    const pt = project(V, altAzVec(p.alt, p.az)); if (!onScreen(pt, 30)) continue;
    g.globalAlpha = hidden ? 0.45 : 1; icon(p.kind, pt[0], pt[1]); g.globalAlpha = 1;
    shown.push({ p, x: pt[0], y: pt[1] });
    if (p.kind === "turbine" && p !== S.selected) continue;  // turbines are many: an icon each, a name only when picked
    if (p.kind === "village" && fov > 70 && p !== S.selected) continue;
    const big = p.kind === "city" || p.kind === "town";
    g.font = `${big ? 600 : 500} ${p.kind === "city" ? 15 : big ? 14 : 13}px ui-sans-serif, system-ui, sans-serif`;
    const text = `${p.name}  ${km(p.d)}`, w = g.measureText(text).width + 12;
    let spot = null;
    for (let row = 0; row < 7 && !spot; row++) {
      const y = pt[1] - 26 - row * 21, box = [pt[0] - 6, y - 15, pt[0] - 6 + w, y + 5];
      if (box[1] < 70) break;
      if (!placed.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) spot = box;
    }
    if (!spot) continue;
    placed.push(spot);
    g.strokeStyle = hidden ? "rgba(255,255,255,.3)" : "rgba(255,255,255,.65)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(pt[0], pt[1] - 8); g.lineTo(pt[0], spot[3] - 2); g.stroke();
    g.fillStyle = "rgba(10,14,20,.55)"; g.beginPath(); g.roundRect(spot[0], spot[1], spot[2] - spot[0], spot[3] - spot[1], 6); g.fill();
    g.fillStyle = hidden ? "rgba(241,243,246,.6)" : p === S.selected ? "#f2c46d" : "#f1f3f6"; g.textAlign = "left"; g.fillText(text, spot[0] + 6, spot[3] - 5);
    shown.push({ p, x: spot[0] + w / 2, y: spot[1] + 10 });
  }
}

// ---- touch ----
const pointers = new Map(); let dragged = 0, pinch = null;
canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); dragged = 0;
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: S.mode === "sensors" ? S.camFov : S.view.fov }; } });
canvas.addEventListener("pointermove", (e) => {
  const last = pointers.get(e.pointerId); if (!last) return;
  const dx = e.clientX - last[0], dy = e.clientY - last[1]; pointers.set(e.pointerId, [e.clientX, e.clientY]); dragged += Math.abs(dx) + Math.abs(dy);
  if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()], f = Math.max(5, Math.min(100, pinch.fov * pinch.d / Math.hypot(a[0] - b[0], a[1] - b[1]))); if (S.mode === "sensors") S.camFov = f; else S.view.fov = f; return; }
  const V = S.V; if (!V) return;
  const deg = (px) => Math.atan(px / V.f) * R2D;
  if (S.mode === "sensors") { if (S.aligning) S.yawOffset -= deg(dx); return; }
  S.view.az = (S.view.az - deg(dx) + 360) % 360; S.view.alt = Math.max(-45, Math.min(45, S.view.alt + deg(dy)));
});
canvas.addEventListener("pointerup", (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (S.mode === "sensors") save("camFov", Math.round(S.camFov)); if (dragged < 8 && !S.aligning) tap(e.clientX, e.clientY); });
canvas.addEventListener("pointercancel", (e) => { pointers.delete(e.pointerId); pinch = null; });
addEventListener("wheel", (e) => { if (S.mode === "drag") S.view.fov = Math.max(5, Math.min(100, S.view.fov * (e.deltaY > 0 ? 1.08 : 0.93))); }, { passive: true });
function tap(x, y) {
  let best = null, bd = 30;
  for (const o of shown) { const d = Math.hypot(o.x - x, o.y - y); if (d < bd) { bd = d; best = o.p; } }
  S.selected = best;
  if (!best) { $("#card").hidden = true; return; }
  const c = $("#card"), h = (t, p = {}) => Object.assign(document.createElement(t), p), t = best.tags;
  c.replaceChildren(h("div", { className: "kind", textContent: KINDS[best.kind][0] }), h("h2", { textContent: best.name }));
  const rows = [["Distance", km(best.d)], ["Direction", `${dirName(best.az)} (${Math.round(best.az)}°)`],
    ["Height", `${Math.round(best.ground)} m above sea level${best.height ? `, ${Math.round(best.height)} m tall${num(t.height) == null ? " (about)" : ""}` : ""}`],
    ["From here", best.blocked == null ? `In sight, ${best.alt >= 0 ? best.alt.toFixed(1) + "° up" : (-best.alt).toFixed(1) + "° down"}` : `Hidden by the ground ${km(best.blocked)} away`],
    ["Population", t.population ? Number(t.population).toLocaleString() : ""], ["Operator", t.operator || ""]];
  const dl = h("dl"); for (const [k, v] of rows) if (v) dl.append(h("dt", { textContent: k }), h("dd", { textContent: v }));
  c.append(dl);
  const wiki = (t.wikipedia || "").match(/^([a-z-]+):(.+)$/);
  const link = h("a", { href: wiki ? `https://${wiki[1]}.wikipedia.org/wiki/${encodeURIComponent(wiki[2].replace(/ /g, "_"))}` : `https://www.openstreetmap.org/${best.osm}`, target: "_blank", rel: "noopener", textContent: wiki ? "Read about it on Wikipedia" : "See it on OpenStreetMap" });
  const more = h("p", { style: "margin:10px 0 0;font-size:14px" }); more.append(link); c.append(more);
  c.hidden = false;
}

// ---- starting ----
async function startCamera() {
  $("#start").hidden = true;
  try { if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") await DeviceOrientationEvent.requestPermission(); } catch (e) {}
  keepAwake();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    video.srcObject = stream; video.hidden = false; await video.play(); S.camera = true;
  } catch (e) { toast("No camera: the landscape is drawn instead."); }
  S.mode = "sensors";
  const where = await new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition((p) => ok(p.coords), () => ok(null), { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  });
  if (!where) toast("Couldn't get your location: showing Ciney.");
  await begin(where ? where.latitude : 50.2969, where ? where.longitude : 5.1006, where ? "" : "Ciney");
  setTimeout(() => { if (!S.target) { S.mode = "drag"; toast("No motion sensors here: drag to look around."); } }, 1500);
}
async function startPreset(p) { $("#start").hidden = true; S.view.az = p.az; await begin(p.lat, p.lon, p.name.split(",")[0], p.ground); }
let wake = null;
async function keepAwake() { try { wake = await navigator.wakeLock?.request("screen"); } catch (e) {} }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.mode === "sensors") keepAwake(); });
function toast(t, onTap) {
  document.querySelector(".toast")?.remove();
  const d = Object.assign(document.createElement(onTap ? "button" : "div"), { className: "toast", textContent: t });
  if (onTap) { d.style.cssText = "font:inherit;color:inherit;cursor:pointer;text-align:center"; d.onclick = () => { d.remove(); onTap(); }; }
  document.body.append(d); setTimeout(() => d.remove(), onTap ? 15000 : 5000);
}

$("#go-camera").addEventListener("click", startCamera);
$("#presets").replaceChildren(...PRESETS.map((p) => Object.assign(document.createElement("button"), { className: "btn ghost", textContent: p.name, onclick: () => startPreset(p) })));
$("#menu").addEventListener("click", (e) => { const s = $("#sheet"); s.hidden = !s.hidden; e.currentTarget.setAttribute("aria-pressed", String(!s.hidden)); $("#fov").value = Math.round(S.camFov); $("#eye").value = Math.round(S.eye); eyeNote(); });
$("#align").addEventListener("click", () => {
  if (S.mode !== "sensors") { toast("Aligning is for the camera view: here, drag to look around."); return; }
  S.aligning = !S.aligning; $("#align").setAttribute("aria-pressed", String(S.aligning)); $("#align-banner").hidden = !S.aligning;
  if (!S.aligning) save("yawOffset", S.yawOffset);
});
$("#align-done").addEventListener("click", () => $("#align").click());
document.querySelectorAll("[data-opt]").forEach((box) => { box.checked = S.opts[box.dataset.opt]; box.addEventListener("change", () => { S.opts[box.dataset.opt] = box.checked; save("opts", S.opts); }); });
$("#fov").addEventListener("input", (e) => { S.camFov = +e.target.value; save("camFov", S.camFov); });
function eyeNote() { $("#eye-note").textContent = `Your eye is ${Math.round(S.eye)} m above the ground: raise it on a tower, a roof or a viewing platform to see further.`; }
let eyeTimer;
$("#eye").addEventListener("input", (e) => { S.eye = Math.max(1.7, +e.target.value); save("eye", S.eye); eyeNote(); clearTimeout(eyeTimer); eyeTimer = setTimeout(rethink, 250); });
requestAnimationFrame(draw);

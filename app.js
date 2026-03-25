const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const btnPanel = document.getElementById("btnPanel");
const panelEl = document.getElementById("panel");
const btnClosePanel = document.getElementById("btnClosePanel");
const loadingEl = document.getElementById("loading");

function setLoading(on) {
  if (!loadingEl) return;
  loadingEl.classList.toggle("loading--on", Boolean(on));
}

const chkBuildings = document.getElementById("chkBuildings");
const chkRoads = document.getElementById("chkRoads");
const chkPaths = document.getElementById("chkPaths");
const chkGreen = document.getElementById("chkGreen");
const rngRoadWidth = document.getElementById("rngRoadWidth");
const rngOpacity = document.getElementById("rngOpacity");
const btnResetLayout = document.getElementById("btnResetLayout");
const btnRandomize = document.getElementById("btnRandomize");
const rngRandomize = document.getElementById("rngRandomize");
const btnToolPan = document.getElementById("btnToolPan");
const btnToolMove = document.getElementById("btnToolMove");
const rngPickRadius = document.getElementById("rngPickRadius");
const btnDownloadMenu = document.getElementById("btnDownloadMenu");
const downloadMenu = document.getElementById("downloadMenu");
const btnExportPng = document.getElementById("btnExportPng");
const btnRecord10s = document.getElementById("btnRecord10s");
const captureFrame = document.getElementById("captureFrame");
const captureLabel = document.getElementById("captureLabel");
const brushViz = document.getElementById("brushViz");
const brushInner = brushViz?.querySelector?.(".brushViz__inner") ?? null;
const brushOuter = brushViz?.querySelector?.(".brushViz__outer") ?? null;
const palNoir = document.getElementById("palNoir");
const palMidnight = document.getElementById("palMidnight");
const palCoral = document.getElementById("palCoral");
const palSage = document.getElementById("palSage");
const palHeatwave = document.getElementById("palHeatwave");

function overpassQuery(query) {
  return fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Overpass failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
  });
}

function extractLatLngsFromOverpassElement(el) {
  // Overpass "out geom" returns either:
  // - way: geometry: [{lat,lon}, ...]
  // - relation: members[].geometry: [{lat,lon}, ...] (multiple rings)
  if (Array.isArray(el.geometry)) {
    return [el.geometry.map((p) => [p.lat, p.lon])];
  }
  if (Array.isArray(el.members)) {
    const rings = [];
    for (const m of el.members) {
      if (Array.isArray(m.geometry) && m.geometry.length) {
        rings.push(m.geometry.map((p) => [p.lat, p.lon]));
      }
    }
    return rings;
  }
  return [];
}

function boundsFromLatLngs(rings) {
  const pts = rings.flat();
  const lats = pts.map((p) => p[0]);
  const lngs = pts.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
}

// Fallback center (Krayot area)
const fallbackCenter = [32.835, 35.08];
const fallbackZoom = 13;

// Krayot bounding box (rough but effective constraint)
// south, west, north, east
const REGION_BBOX = {
  south: 32.80,
  west: 35.03,
  north: 32.88,
  east: 35.13,
};

const regionBounds = L.latLngBounds(
  [REGION_BBOX.south, REGION_BBOX.west],
  [REGION_BBOX.north, REGION_BBOX.east],
);

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true,
  attributionControl: false,
  maxBounds: regionBounds,
  maxBoundsViscosity: 1.0,
}).setView(fallbackCenter, fallbackZoom);

// No raster basemap: only our vector layers should be visible (so toggles truly hide things).

// (Glyph canvas renderer removed — back to vector layers only)

// We'll keep a dedicated layer group for the city boundary.
// Data layers (separated like the reference site)
const layerBuildings = L.layerGroup().addTo(map);
const layerRoads = L.layerGroup().addTo(map);
const layerPaths = L.layerGroup().addTo(map);
const layerGreen = L.layerGroup().addTo(map);
const layerProxies = L.layerGroup().addTo(map);

const originalGeometry = new Map();
const movedLayers = new Set();
let randomSeed = 1;
let lastForce = 0;

let pickRadiusPx = Number(rngPickRadius?.value ?? 22);
const INDEX_CELL_LAT = 0.0022;
const INDEX_CELL_LNG = 0.0022;
const featureIndex = new Map(); // key -> array of items
const featureItems = []; // { layer, centroid: L.LatLng, type: string }
const proxyItems = []; // { layer, centroid: L.LatLng, type: string }

const MAX_PICK_PER_BRUSH = 320; // cap how many layers a brush can affect
const MAX_PROXY_PER_TYPE = { buildings: 12000, roads: 9000, paths: 7000, green: 5000 };
let useProxyMode = false;

let hoverLayer = null;
let tossing = {
  active: false,
  lastMouseLatLng: null,
};

let toolMode = "pan"; // "pan" | "move"
let lastMouseContainerPt = null;

function setToolMode(mode) {
  toolMode = mode === "move" ? "move" : "pan";
  btnToolPan?.classList.toggle("actionBtn--active", toolMode === "pan");
  btnToolMove?.classList.toggle("actionBtn--active", toolMode === "move");

  const container = map.getContainer();
  if (toolMode === "move") {
    map.dragging.disable();
    container.style.cursor = "crosshair";
    brushViz?.classList.remove("brushViz--off");
    // Keep real geometry visible while moving (no proxy "dots" mode)
    useProxyMode = false;
  } else {
    map.dragging.enable();
    container.style.cursor = "";
    brushViz?.classList.add("brushViz--off");
    useProxyMode = false;
  }
}

function cloneLatLngs(latlngs) {
  if (Array.isArray(latlngs)) {
    return latlngs.map((x) => cloneLatLngs(x));
  }
  if (latlngs && typeof latlngs.lat === "number" && typeof latlngs.lng === "number") {
    return L.latLng(latlngs.lat, latlngs.lng);
  }
  return latlngs;
}

function storeOriginalIfMissing(layer) {
  if (originalGeometry.has(layer)) return;
  if (typeof layer.getLatLngs === "function") originalGeometry.set(layer, cloneLatLngs(layer.getLatLngs()));
  else if (typeof layer.getLatLng === "function") originalGeometry.set(layer, L.latLng(layer.getLatLng().lat, layer.getLatLng().lng));
}

function getLayerCentroid(layer) {
  try {
    const b = layer.getBounds?.();
    if (b) return b.getCenter();
  } catch {
    // ignore
  }
  // fallback
  return map.getCenter();
}

function indexKey(latlng) {
  const r = Math.floor((latlng.lat - REGION_BBOX.south) / INDEX_CELL_LAT);
  const c = Math.floor((latlng.lng - REGION_BBOX.west) / INDEX_CELL_LNG);
  return `${r}:${c}`;
}

function rebuildIndex() {
  featureIndex.clear();
  for (const item of featureItems) {
    const key = indexKey(item.centroid);
    const arr = featureIndex.get(key) ?? [];
    arr.push(item);
    featureIndex.set(key, arr);
  }
}

function addToIndex(layer, type) {
  const t = type ?? "other";
  const centroid = getLayerCentroid(layer);
  const item = { layer, centroid, type: t };
  featureItems.push(item);
  const key = indexKey(centroid);
  const arr = featureIndex.get(key) ?? [];
  arr.push(item);
  featureIndex.set(key, arr);
}

function addProxyForFeature(type, latlng) {
  const style = {
    buildings: { radius: 3, color: "#111", fillColor: "#fff", fillOpacity: 0.9, weight: 2 },
    roads: { radius: 2.5, color: "#111", fillColor: "#111", fillOpacity: 0.75, weight: 1 },
    paths: { radius: 2.5, color: "#111", fillColor: "#fff", fillOpacity: 0.75, weight: 2, dashArray: "2 3" },
    green: { radius: 3, color: "#111", fillColor: "#fff", fillOpacity: 0.65, weight: 2 },
    other: { radius: 2.5, color: "#111", fillColor: "#fff", fillOpacity: 0.7, weight: 2 },
  }[type] ?? { radius: 2.5, color: "#111", fillColor: "#fff", fillOpacity: 0.7, weight: 2 };

  const m = L.circleMarker(latlng, { ...style, interactive: false });
  storeOriginalIfMissing(m);
  layerProxies.addLayer(m);
  proxyItems.push({ layer: m, centroid: latlng, type });
}

function rebuildProxies() {
  layerProxies.clearLayers();
  proxyItems.length = 0;

  const counts = { buildings: 0, roads: 0, paths: 0, green: 0, other: 0 };

  const addFromGroup = (group, type) => {
    group.eachLayer((l) => {
      if (counts[type] >= (MAX_PROXY_PER_TYPE[type] ?? 5000)) return;
      const c = getLayerCentroid(l);
      addProxyForFeature(type, c);
      counts[type]++;
    });
  };

  addFromGroup(layerRoads, "roads");
  addFromGroup(layerPaths, "paths");
  addFromGroup(layerGreen, "green");
  addFromGroup(layerBuildings, "buildings");
}

function updateIndexItemCentroid(layer, newCentroid) {
  // linear scan is ok for moved-only layers
  const item = featureItems.find((it) => it.layer === layer);
  if (!item) return;
  item.centroid = newCentroid;
  // avoid redrawing on every tiny centroid update; physics already triggers many updates
}

function nearestLayerWithinRadius(mouseLatLng, radiusPx) {
  if (!mouseLatLng) return null;
  const key = indexKey(mouseLatLng);
  const [rStr, cStr] = key.split(":");
  const r0 = Number(rStr);
  const c0 = Number(cStr);

  const mousePt = map.latLngToContainerPoint(mouseLatLng);
  let best = null;
  let bestD = Infinity;

  const cellRange = getCellRangeForRadius(mouseLatLng, radiusPx);
  for (let dr = -cellRange.r; dr <= cellRange.r; dr++) {
    for (let dc = -cellRange.c; dc <= cellRange.c; dc++) {
      const k = `${r0 + dr}:${c0 + dc}`;
      const items = featureIndex.get(k);
      if (!items) continue;
      for (const it of items) {
        if (!map.hasLayer(it.layer)) continue;
        const pt = map.latLngToContainerPoint(it.centroid);
        const d = pt.distanceTo(mousePt);
        if (d <= radiusPx && d < bestD) {
          bestD = d;
          best = it.layer;
        }
      }
    }
  }
  return best;
}

function layersWithinRadius(mouseLatLng, radiusPx) {
  if (!mouseLatLng) return [];
  const key = indexKey(mouseLatLng);
  const [rStr, cStr] = key.split(":");
  const r0 = Number(rStr);
  const c0 = Number(cStr);

  const mousePt = map.latLngToContainerPoint(mouseLatLng);
  const picked = [];

  const cellRange = getCellRangeForRadius(mouseLatLng, radiusPx);
  for (let dr = -cellRange.r; dr <= cellRange.r; dr++) {
    for (let dc = -cellRange.c; dc <= cellRange.c; dc++) {
      const k = `${r0 + dr}:${c0 + dc}`;
      const items = featureIndex.get(k);
      if (!items) continue;
      for (const it of items) {
        if (!map.hasLayer(it.layer)) continue;
        const pt = map.latLngToContainerPoint(it.centroid);
        const d = pt.distanceTo(mousePt);
        if (d <= radiusPx) picked.push({ layer: it.layer, d });
      }
    }
  }
  // Keep only closest N for smoothness
  picked.sort((a, b) => a.d - b.d);
  return picked.slice(0, MAX_PICK_PER_BRUSH).map((x) => x.layer);
}

function getCellRangeForRadius(mouseLatLng, radiusPx) {
  // Convert pixel radius to an approximate lat/lng radius at current zoom,
  // then derive how many index cells we need to scan.
  const centerPt = map.latLngToContainerPoint(mouseLatLng);
  const eastLatLng = map.containerPointToLatLng(centerPt.add([radiusPx, 0]));
  const southLatLng = map.containerPointToLatLng(centerPt.add([0, radiusPx]));
  const dLng = Math.abs(eastLatLng.lng - mouseLatLng.lng);
  const dLat = Math.abs(southLatLng.lat - mouseLatLng.lat);

  const c = Math.max(1, Math.ceil(dLng / INDEX_CELL_LNG) + 1);
  const r = Math.max(1, Math.ceil(dLat / INDEX_CELL_LAT) + 1);
  return { r, c };
}

function offsetLatLngs(latlngs, dLat, dLng) {
  if (Array.isArray(latlngs)) return latlngs.map((x) => offsetLatLngs(x, dLat, dLng));
  if (latlngs && typeof latlngs.lat === "number" && typeof latlngs.lng === "number") {
    return L.latLng(latlngs.lat + dLat, latlngs.lng + dLng);
  }
  return latlngs;
}

const velocities = new Map(); // layer -> { vLat, vLng }
let physicsRunning = false;

function nudgeLayerNow(layer, dLat, dLng) {
  if (typeof layer.getLatLng === "function" && typeof layer.setLatLng === "function") {
    const cur = layer.getLatLng();
    layer.setLatLng(L.latLng(cur.lat + dLat, cur.lng + dLng));
  } else if (typeof layer.getLatLngs === "function" && typeof layer.setLatLngs === "function") {
    const cur = layer.getLatLngs();
    layer.setLatLngs(offsetLatLngs(cur, dLat, dLng));
  }
  updateIndexItemCentroid(layer, getLayerCentroid(layer));
}

function addImpulse(layer, vLat, vLng) {
  const cur = velocities.get(layer) ?? { vLat: 0, vLng: 0 };
  cur.vLat += vLat;
  cur.vLng += vLng;
  velocities.set(layer, cur);
  movedLayers.add(layer);
  // Immediate visual feedback on click (no 1-frame delay)
  nudgeLayerNow(layer, vLat, vLng);
  if (!physicsRunning) runPhysics();
}

function clampLatLngToBounds(latlng) {
  const lat = Math.max(REGION_BBOX.south, Math.min(REGION_BBOX.north, latlng.lat));
  const lng = Math.max(REGION_BBOX.west, Math.min(REGION_BBOX.east, latlng.lng));
  return L.latLng(lat, lng);
}

function runPhysics() {
  physicsRunning = true;
  const damping = 0.86;
  const stopEps = 1e-7;
  const maxPerFrame = 420; // lower cap for smoother UI
  const padLat = (REGION_BBOX.north - REGION_BBOX.south) * 0.01;
  const padLng = (REGION_BBOX.east - REGION_BBOX.west) * 0.01;
  const bounce = 0.55;

  const step = () => {
    let processed = 0;
    for (const [layer, v] of velocities) {
      if (processed >= maxPerFrame) break;
      processed++;
      if (!map.hasLayer(layer)) {
        velocities.delete(layer);
        continue;
      }
      if (typeof layer.getLatLng === "function" && typeof layer.setLatLng === "function") {
        const cur = layer.getLatLng();
        layer.setLatLng(L.latLng(cur.lat + v.vLat, cur.lng + v.vLng));
      } else if (typeof layer.getLatLngs === "function" && typeof layer.setLatLngs === "function") {
        const cur = layer.getLatLngs();
        layer.setLatLngs(offsetLatLngs(cur, v.vLat, v.vLng));
      } else {
        velocities.delete(layer);
        continue;
      }
      // Bounce off region bounds instead of "sticking" to the frame
      const c = getLayerCentroid(layer);
      let corrLat = 0;
      let corrLng = 0;
      if (c.lat < REGION_BBOX.south + padLat) {
        corrLat = (REGION_BBOX.south + padLat - c.lat) * 0.35;
        v.vLat = Math.abs(v.vLat) * bounce;
      } else if (c.lat > REGION_BBOX.north - padLat) {
        corrLat = (REGION_BBOX.north - padLat - c.lat) * 0.35;
        v.vLat = -Math.abs(v.vLat) * bounce;
      }
      if (c.lng < REGION_BBOX.west + padLng) {
        corrLng = (REGION_BBOX.west + padLng - c.lng) * 0.35;
        v.vLng = Math.abs(v.vLng) * bounce;
      } else if (c.lng > REGION_BBOX.east - padLng) {
        corrLng = (REGION_BBOX.east - padLng - c.lng) * 0.35;
        v.vLng = -Math.abs(v.vLng) * bounce;
      }
      if (corrLat !== 0 || corrLng !== 0) {
        if (typeof layer.getLatLng === "function" && typeof layer.setLatLng === "function") {
          const cur = layer.getLatLng();
          layer.setLatLng(L.latLng(cur.lat + corrLat, cur.lng + corrLng));
        } else if (typeof layer.getLatLngs === "function" && typeof layer.setLatLngs === "function") {
          layer.setLatLngs(offsetLatLngs(layer.getLatLngs(), corrLat, corrLng));
        }
      }

      updateIndexItemCentroid(layer, getLayerCentroid(layer));

      v.vLat *= damping;
      v.vLng *= damping;
      if (Math.abs(v.vLat) + Math.abs(v.vLng) < stopEps) velocities.delete(layer);
    }

    if (velocities.size > 0 || tossing.active) {
      requestAnimationFrame(step);
    } else {
      physicsRunning = false;
      rebuildIndex();
    }
  };
  requestAnimationFrame(step);
}

function lerpLatLngs(a, b, t) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.map((x, i) => lerpLatLngs(x, b[i], t));
  }
  if (a && b && typeof a.lat === "number" && typeof a.lng === "number") {
    return L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
  }
  return b;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function animateBackToOriginal(durationMs = 1200, { onDone } = {}) {
  const targets = [];
  for (const layer of movedLayers) {
    const orig = originalGeometry.get(layer);
    if (!orig) continue;

    // Marker-like (proxies)
    if (typeof layer.getLatLng === "function" && typeof layer.setLatLng === "function") {
      targets.push({
        kind: "marker",
        layer,
        from: L.latLng(layer.getLatLng().lat, layer.getLatLng().lng),
        to: L.latLng(orig.lat, orig.lng),
      });
      continue;
    }

    // Vector-like (polyline/polygon)
    if (typeof layer.getLatLngs === "function" && typeof layer.setLatLngs === "function") {
      targets.push({
        kind: "vector",
        layer,
        from: cloneLatLngs(layer.getLatLngs()),
        to: cloneLatLngs(orig),
      });
    }
  }
  if (!targets.length) return;

  const t0 = performance.now();
  const batchSize = 850;
  let start = 0;

  const step = (now) => {
    const p = Math.max(0, Math.min(1, (now - t0) / durationMs));
    const e = easeInOutCubic(p);

    // Round-robin batched updates to keep frames smooth and animation visible
    const n = targets.length;
    const end = Math.min(n, start + batchSize);
    for (let i = start; i < end; i++) {
      const item = targets[i];
      if (item.kind === "marker") item.layer.setLatLng(lerpLatLngs(item.from, item.to, e));
      else item.layer.setLatLngs(lerpLatLngs(item.from, item.to, e));
      updateIndexItemCentroid(item.layer, getLayerCentroid(item.layer));
    }
    // advance window, wrap
    start = end >= n ? 0 : end;

    if (p < 1) {
      requestAnimationFrame(step);
    } else {
      // Ensure final exact positions (also batched)
      let k = 0;
      const finalize = () => {
        const s = k;
        const ee = Math.min(n, s + batchSize);
        for (; k < ee; k++) {
          const item = targets[k];
          if (item.kind === "marker") item.layer.setLatLng(item.to);
          else item.layer.setLatLngs(item.to);
          updateIndexItemCentroid(item.layer, getLayerCentroid(item.layer));
        }
        if (k < n) requestAnimationFrame(finalize);
        else {
          movedLayers.clear();
          rebuildIndex();
          onDone?.();
        }
      };
      requestAnimationFrame(finalize);
    }
  };
  requestAnimationFrame(step);
}

function anyMovedMarkers() {
  for (const layer of movedLayers) {
    if (typeof layer.getLatLng === "function" && typeof layer.setLatLng === "function") return true;
  }
  return false;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function rotateLatLngs(latlngs, center, angleRad) {
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const lat0 = center.lat;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1;

  const rotOne = (p) => {
    const dx = (p.lng - center.lng) * k;
    const dy = p.lat - center.lat;
    const rx = dx * cosA - dy * sinA;
    const ry = dx * sinA + dy * cosA;
    return L.latLng(center.lat + ry, center.lng + rx / k);
  };

  if (Array.isArray(latlngs)) return latlngs.map((x) => rotateLatLngs(x, center, angleRad));
  if (latlngs && typeof latlngs.lat === "number" && typeof latlngs.lng === "number") return rotOne(latlngs);
  return latlngs;
}

function animateRandomize(intensity01) {
  const spanLat = regionBounds.getNorth() - regionBounds.getSouth();
  const spanLng = regionBounds.getEast() - regionBounds.getWest();

  const maxLat = spanLat * (0.06 + 0.22 * intensity01);
  const maxLng = spanLng * (0.06 + 0.22 * intensity01);
  const maxAngle = (Math.PI / 2) * intensity01; // up to 90°

  const rnd = mulberry32(++randomSeed);

  // Randomize ALL visible elements, but in time-sliced batches.
  const candidates = featureItems.filter((it) => map.hasLayer(it.layer));
  if (!candidates.length) return;

  const targets = candidates
    .map((it) => {
      const layer = it.layer;
      storeOriginalIfMissing(layer);
      const orig = originalGeometry.get(layer);
      if (!orig) return null;

      const a = rnd() * Math.PI * 2;
      const m = Math.pow(rnd(), 0.38);
      const dLat = Math.sin(a) * maxLat * m;
      const dLng = Math.cos(a) * maxLng * m;
      const angle = (rnd() * 2 - 1) * maxAngle;

      // Rotate around original centroid, then offset
      const center = getLayerCentroid(layer);
      const rotated = rotateLatLngs(orig, center, angle);
      movedLayers.add(layer);
      return { layer, to: offsetLatLngs(rotated, dLat, dLng) };
    })
    .filter(Boolean);

  if (!targets.length) return;

  let cursor = 0;
  const step = () => {
    const frameStart = performance.now();
    const budgetMs = 9.0;
    while (cursor < targets.length && performance.now() - frameStart < budgetMs) {
      const item = targets[cursor++];
      item.layer.setLatLngs(item.to);
      updateIndexItemCentroid(item.layer, getLayerCentroid(item.layer));
    }
    if (cursor < targets.length) {
      requestAnimationFrame(step);
    } else {
      rebuildIndex();
    }
  };
  requestAnimationFrame(step);
}

function resetLayout() {
  // kept for compatibility if we add more layout controls later
}

// Exact theme colors taken from TerraInk's open-source themes.json
const THEMES = {
  noir: {
    ui: { bg: "#000000", text: "#FFFFFF" },
    map: {
      land: "#000000",
      parks: "#171717",
      buildings: "#6F6F6F",
      roads: { major: "#E8E8E8", path: "#454545", outline: "#575757", minor_high: "#A0A0A0", minor_mid: "#333333", minor_low: "#242424" },
    },
  },
  midnight_blue: {
    ui: { bg: "#0A1628", text: "#D6B352" },
    map: {
      land: "#0A1628",
      parks: "#0F2235",
      buildings: "#6E5A45",
      roads: { major: "#C99C37", path: "#414033", outline: "#4f4b36", minor_high: "#8A6820", minor_mid: "#333530", minor_low: "#272c2e" },
    },
  },
  coral: {
    ui: { bg: "#F3E1DA", text: "#6E2F28" },
    map: {
      land: "#F3E1DA",
      parks: "#EACFC6",
      buildings: "#E39B89",
      roads: { major: "#B9473A", path: "#E8C4B8", outline: "#EDD2C8", minor_high: "#C86050", minor_mid: "#E09888", minor_low: "#DDAA9A" },
    },
  },
  sage: {
    ui: { bg: "#DDE8DD", text: "#2D4739" },
    map: {
      land: "#DDE8DD",
      parks: "#D3DFD7",
      buildings: "#8BAD9B",
      roads: { major: "#3F624F", path: "#BECCBF", outline: "#C8D8CC", minor_high: "#587A68", minor_mid: "#92B4A2", minor_low: "#AABFB4" },
    },
  },
  heatwave: {
    ui: { bg: "#1C0E09", text: "#FFD78A" },
    map: {
      land: "#1C0E09",
      parks: "#381A10",
      buildings: "#D2A55E",
      roads: { major: "#FF5F1F", path: "#59442c", outline: "#695235", minor_high: "#B04010", minor_mid: "#493623", minor_low: "#3c2a1b" },
    },
  },
};

let currentThemeId = "midnight_blue";

function hexToRgba(hex, alpha) {
  const h = String(hex).replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = Number.parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function colorToRgba(color, alpha) {
  const c = String(color).trim();
  if (c.startsWith("rgba(")) {
    // Replace existing alpha
    const inside = c.slice(5, -1);
    const parts = inside.split(",").map((p) => p.trim());
    if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    return c;
  }
  if (c.startsWith("rgb(")) {
    const inside = c.slice(4, -1);
    const parts = inside.split(",").map((p) => p.trim());
    if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    return c;
  }
  // assume hex
  return hexToRgba(c, alpha);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hexToRgb(hex) {
  const h = String(hex).replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = Number.parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function parseColorToRgb(color) {
  const c = String(color).trim();
  if (c.startsWith("#")) return hexToRgb(c);
  if (c.startsWith("rgb(") || c.startsWith("rgba(")) {
    const inside = c.startsWith("rgba(") ? c.slice(5, -1) : c.slice(4, -1);
    const parts = inside.split(",").map((p) => p.trim());
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return { r, g, b };
  }
  // fallback: try to treat as hex without '#'
  return hexToRgb(c);
}

function lightenToWhite(color, amount01) {
  const a = Math.max(0, Math.min(1, amount01));
  const { r, g, b } = parseColorToRgb(color);
  const rr = Math.round(r + (255 - r) * a);
  const gg = Math.round(g + (255 - g) * a);
  const bb = Math.round(b + (255 - b) * a);
  return `rgb(${rr}, ${gg}, ${bb})`;
}

function mixRgb(color, targetRgb, amount01) {
  const a = Math.max(0, Math.min(1, amount01));
  const { r, g, b } = parseColorToRgb(color);
  const rr = Math.round(r + (targetRgb.r - r) * a);
  const gg = Math.round(g + (targetRgb.g - g) * a);
  const bb = Math.round(b + (targetRgb.b - b) * a);
  return `rgb(${rr}, ${gg}, ${bb})`;
}

function relLuminance(color) {
  const { r, g, b } = parseColorToRgb(color);
  const srgb = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(fg, bg) {
  const L1 = relLuminance(fg);
  const L2 = relLuminance(bg);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureContrast(fg, bg, minRatio) {
  // Try nudging fg towards white or black until the contrast requirement is met.
  // Choose direction based on background brightness.
  const bgLum = relLuminance(bg);
  const target = bgLum > 0.6 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };

  let best = fg;
  let bestRatio = contrastRatio(fg, bg);
  if (bestRatio >= minRatio) return fg;

  for (let i = 1; i <= 10; i++) {
    const amt = i / 10; // 0.1 .. 1.0
    const candidate = mixRgb(fg, target, amt);
    const cr = contrastRatio(candidate, bg);
    if (cr > bestRatio) {
      bestRatio = cr;
      best = candidate;
    }
    if (cr >= minRatio) return candidate;
  }
  return best;
}

function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = Math.round(lerp(a.r, b.r, t));
  const g = Math.round(lerp(a.g, b.g, t));
  const bch = Math.round(lerp(a.b, b.b, t));
  return `rgb(${r}, ${g}, ${bch})`;
}

function colorFromScale(stops, t) {
  if (!Array.isArray(stops) || stops.length === 0) return "rgb(255,255,255)";
  if (stops.length === 1) return stops[0];
  const tt = Math.max(0, Math.min(1, t));
  const seg = (stops.length - 1) * tt;
  const i = Math.floor(seg);
  const f = seg - i;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  return lerpColor(a, b, f);
}

function applyTheme(themeId) {
  currentThemeId = themeId;
  const theme = THEMES[currentThemeId] ?? THEMES.midnight_blue;

  // Backgrounds (page + map)
  document.documentElement.style.setProperty("--bg", theme.ui.bg);
  document.documentElement.style.setProperty("--text", theme.ui.text);
  document.documentElement.style.setProperty("--mapLand", theme.map.land);

  applyStyles();
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function featureMetric(layerKey, tags, layer) {
  // Returns a number in [0..1] used to pick a color from the palette scale.
  // Heuristics (no text labels involved):
  // - roads: by highway class
  // - paths: by path type
  // - buildings: by footprint size (bounds area proxy)
  // - green: by type
  if (layerKey === "roads") {
    const h = tags?.highway ?? "";
    if (/motorway|trunk/.test(h)) return 1;
    if (/primary/.test(h)) return 0.85;
    if (/secondary/.test(h)) return 0.7;
    if (/tertiary/.test(h)) return 0.55;
    if (/residential/.test(h)) return 0.4;
    return 0.25;
  }
  if (layerKey === "paths") {
    const h = tags?.highway ?? "";
    if (/steps/.test(h)) return 0.95;
    if (/cycleway/.test(h)) return 0.75;
    if (/track/.test(h)) return 0.55;
    if (/footway/.test(h)) return 0.45;
    return 0.35;
  }
  if (layerKey === "green") {
    if (tags?.leisure === "park") return 0.75;
    if (tags?.natural === "wood") return 0.9;
    if (tags?.landuse === "forest") return 0.85;
    if (tags?.landuse === "grass") return 0.55;
    return 0.6;
  }
  // buildings
  try {
    const b = layer?.getBounds?.();
    if (!b) return 0.5;
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    const dLat = Math.abs(ne.lat - sw.lat);
    const dLng = Math.abs(ne.lng - sw.lng);
    const areaProxy = dLat * dLng; // not meters^2, but good enough for ranking
    // Normalize proxy with a soft cap
    return clamp01(areaProxy / 0.00002);
  } catch {
    return 0.5;
  }
}

function getFeatureColor(layerKey, tags, leafletLayer) {
  const theme = THEMES[currentThemeId] ?? THEMES.midnight_blue;
  const t = featureMetric(layerKey, tags, leafletLayer);

  if (layerKey === "roads") {
    const s = theme.map.roads;
    const stops = [s.minor_low, s.minor_mid, s.minor_high, s.major];
    return colorFromScale(stops, t);
  }
  if (layerKey === "paths") {
    const s = theme.map.roads;
    const stops = [s.outline, s.path, s.minor_low];
    return colorFromScale(stops, t);
  }
  if (layerKey === "green") {
    const stops = [theme.map.land, theme.map.parks, theme.map.roads.path];
    return colorFromScale(stops, t);
  }
  // buildings
  // Use a higher-contrast stop so buildings always read clearly across themes
  // (closer to the theme's strongest road accent).
  const stops = [theme.map.land, theme.map.buildings, theme.map.roads.major];
  // Slight bias towards the stronger end of the scale.
  const base = colorFromScale(stops, Math.min(1, t * 0.9 + 0.1));
  // Adaptive contrast vs. the theme land color:
  // - If land is light, buildings go darker.
  // - If land is dark, buildings go lighter.
  // This keeps buildings readable across all palettes.
  const contrasted = ensureContrast(base, theme.map.land, 2.8);
  return contrasted;
}

function setLayerVisible(layer, visible) {
  if (visible) {
    if (!map.hasLayer(layer)) layer.addTo(map);
  } else {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  }
}

function applyStyles() {
  const roadW = Number(rngRoadWidth?.value ?? 3);
  const opacity = Number(rngOpacity?.value ?? 0.5);

  layerRoads.eachLayer((l) =>
    l.setStyle?.({
      color: getFeatureColor("roads", l.__tags, l),
      weight: roadW,
      opacity: Math.min(1, opacity + 0.25),
    }),
  );
  layerPaths.eachLayer((l) =>
    l.setStyle?.({
      color: getFeatureColor("paths", l.__tags, l),
      opacity: Math.min(1, opacity + 0.15),
    }),
  );
  layerBuildings.eachLayer((l) =>
    l.setStyle?.({
      color: colorToRgba(getFeatureColor("buildings", l.__tags, l), 0.75),
      fillColor: colorToRgba(getFeatureColor("buildings", l.__tags, l), 1),
      fillOpacity: Math.min(0.95, opacity * 1.15),
      opacity: Math.min(1, opacity + 0.2),
    }),
  );
  layerGreen.eachLayer((l) =>
    l.setStyle?.({
      color: colorToRgba(getFeatureColor("green", l.__tags, l), 0.75),
      fillColor: colorToRgba(getFeatureColor("green", l.__tags, l), 1),
      fillOpacity: Math.max(0.05, opacity * 0.8),
      opacity: Math.min(1, opacity + 0.15),
    }),
  );
}

function styleNewLayer(layer, type) {
  const roadW = Number(rngRoadWidth?.value ?? 3);
  const opacity = Number(rngOpacity?.value ?? 0.5);

  if (!layer?.setStyle) return;

  if (type === "roads") {
    layer.setStyle({
      color: getFeatureColor("roads", layer.__tags, layer),
      weight: roadW,
      opacity: Math.min(1, opacity + 0.25),
    });
    return;
  }
  if (type === "paths") {
    layer.setStyle({
      color: getFeatureColor("paths", layer.__tags, layer),
      weight: 2,
      opacity: Math.min(1, opacity + 0.15),
      dashArray: "4 6",
    });
    return;
  }
  if (type === "green") {
    layer.setStyle({
      color: colorToRgba(getFeatureColor("green", layer.__tags, layer), 0.75),
      fillColor: colorToRgba(getFeatureColor("green", layer.__tags, layer), 1),
      fillOpacity: Math.max(0.05, opacity * 0.8),
      opacity: Math.min(1, opacity + 0.15),
      weight: 1,
    });
    return;
  }
  if (type === "buildings") {
    layer.setStyle({
      color: colorToRgba(getFeatureColor("buildings", layer.__tags, layer), 0.75),
      fillColor: colorToRgba(getFeatureColor("buildings", layer.__tags, layer), 1),
      fillOpacity: Math.min(0.95, opacity * 1.15),
      opacity: Math.min(1, opacity + 0.2),
      weight: 1,
    });
    return;
  }
}

function setSwatchEl(el, bg) {
  if (!el) return;
  el.style.background = bg;
}

function setPaletteSwatch(el, colors) {
  if (!el) return;
  const s = colors.map.roads;
  const stops = [colors.ui.bg, colors.map.land, s.minor_high, s.major];
  el.style.background = `linear-gradient(90deg, ${stops[0]} 0%, ${stops[1]} 40%, ${stops[2]} 70%, ${stops[3]} 100%)`;
}

function featherOuterRadius(innerPx) {
  // Soft edge size (like brush feather)
  return Math.round(innerPx * 1.35);
}

function influenceForDistance(dPx, innerPx) {
  const outerPx = featherOuterRadius(innerPx);
  if (dPx <= innerPx) return 1;
  if (dPx >= outerPx) return 0;
  // linear falloff in feather band
  return 1 - (dPx - innerPx) / Math.max(1, outerPx - innerPx);
}

function updateBrushVizAt(containerPt) {
  if (!brushViz || !brushInner || !brushOuter) return;
  if (toolMode !== "move") return;
  if (!containerPt) return;

  const inner = pickRadiusPx;
  const outer = featherOuterRadius(pickRadiusPx);

  brushViz.style.left = `${containerPt.x}px`;
  brushViz.style.top = `${containerPt.y}px`;
  brushInner.style.width = `${inner * 2}px`;
  brushInner.style.height = `${inner * 2}px`;
  brushOuter.style.width = `${outer * 2}px`;
  brushOuter.style.height = `${outer * 2}px`;
}

function latLngPerPxAt(latlng) {
  const pt = map.latLngToContainerPoint(latlng);
  const east = map.containerPointToLatLng(pt.add([1, 0]));
  const south = map.containerPointToLatLng(pt.add([0, 1]));
  return {
    dLatPerPx: Math.abs(south.lat - latlng.lat),
    dLngPerPx: Math.abs(east.lng - latlng.lng),
  };
}

function tossAt(latlng, strengthPx = 18) {
  if (!latlng) return;
  lastForce = strengthPx;
  const outerPx = featherOuterRadius(pickRadiusPx);
  const picked = layersWithinRadius(latlng, outerPx);
  if (!picked.length) return;

  const { dLatPerPx, dLngPerPx } = latLngPerPxAt(latlng);
  const originPt = map.latLngToContainerPoint(latlng);

  for (const layer of picked) {
    const c = getLayerCentroid(layer);
    const cPt = map.latLngToContainerPoint(c);
    const dx = cPt.x - originPt.x;
    const dy = cPt.y - originPt.y;
    const dist = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
    const inf = influenceForDistance(dist, pickRadiusPx);
    if (inf <= 0) continue;

    const dirX = dx / dist;
    const dirY = dy / dist;
    const magPx = strengthPx * inf * (0.35 + 0.65 * Math.min(1, pickRadiusPx / 120));

    addImpulse(layer, dirY * magPx * dLatPerPx, dirX * magPx * dLngPerPx);
  }
}

function currentCaptureLabel() {
  const c = map.getCenter();
  const f = Math.round(lastForce);
  const z = map.getZoom();
  return `lat ${c.lat.toFixed(5)}  lng ${c.lng.toFixed(5)}\nzoom ${z}  force ${f}`;
}

function setCaptureOverlay(on) {
  if (!captureFrame || !captureLabel) return;
  captureFrame.classList.toggle("captureFrame--on", Boolean(on));
  captureLabel.textContent = currentCaptureLabel();
}

function cropToSquareCanvas(srcCanvas) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const size = Math.min(w, h);
  const sx = Math.floor((w - size) / 2);
  const sy = Math.floor((h - size) / 2);
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const o = out.getContext("2d");
  o.drawImage(srcCanvas, sx, sy, size, size, 0, 0, size, size);
  return out;
}

async function exportPngSquare() {
  if (typeof window.html2canvas !== "function") return;
  document.documentElement.classList.add("capturing");
  setCaptureOverlay(true);
  await new Promise((r) => setTimeout(r, 50));
  const canvas = await window.html2canvas(document.querySelector(".mapWrap"), {
    backgroundColor: null,
    useCORS: true,
    scale: 1,
  });
  setCaptureOverlay(false);
  document.documentElement.classList.remove("capturing");
  const square = cropToSquareCanvas(canvas);
  const url = square.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = "map.png";
  a.click();
}

async function recordVideo10sSquare() {
  if (typeof window.html2canvas !== "function") return;
  if (typeof MediaRecorder === "undefined") return;

  const fps = 6;
  const durationMs = 10_000;
  const frameEveryMs = Math.round(1000 / fps);

  // Create a capture canvas that we draw square frames into
  const out = document.createElement("canvas");
  out.width = 900;
  out.height = 900;
  const octx = out.getContext("2d");

  const stream = out.captureStream(fps);
  const preferred = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ];
  const mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  if (!mimeType.startsWith("video/mp4")) {
    // MP4 isn't reliably supported in-browser; fall back cleanly.
    // (We keep behavior correct rather than writing an incorrect .mp4.)
    // eslint-disable-next-line no-alert
    alert("בדפדפן הזה אי אפשר להקליט MP4 ישירות. ירד WebM.");
  }
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  recorder.start();
  const t0 = performance.now();
  document.documentElement.classList.add("capturing");
  setCaptureOverlay(true);

  while (performance.now() - t0 < durationMs) {
    captureLabel.textContent = currentCaptureLabel();
    const canvas = await window.html2canvas(document.querySelector(".mapWrap"), {
      backgroundColor: null,
      useCORS: true,
      scale: 1,
    });
    const sq = cropToSquareCanvas(canvas);
    octx.clearRect(0, 0, out.width, out.height);
    octx.drawImage(sq, 0, 0, out.width, out.height);
    await new Promise((r) => setTimeout(r, frameEveryMs));
  }

  setCaptureOverlay(false);
  document.documentElement.classList.remove("capturing");
  recorder.stop();

  const blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = mimeType.startsWith("video/mp4") ? "map-10s.mp4" : "map-10s.webm";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function wirePanel() {
  function openPanel() {
    panelEl?.classList.remove("panel--closed");
  }
  function closePanel() {
    panelEl?.classList.add("panel--closed");
  }

  btnPanel?.addEventListener("click", () => {
    panelEl?.classList.toggle("panel--closed");
  });
  btnClosePanel?.addEventListener("click", closePanel);

  chkBuildings?.addEventListener("change", () => {
    if (!useProxyMode) setLayerVisible(layerBuildings, chkBuildings.checked);
  });
  chkRoads?.addEventListener("change", () => {
    if (!useProxyMode) setLayerVisible(layerRoads, chkRoads.checked);
  });
  chkPaths?.addEventListener("change", () => {
    if (!useProxyMode) setLayerVisible(layerPaths, chkPaths.checked);
  });
  chkGreen?.addEventListener("change", () => {
    if (!useProxyMode) setLayerVisible(layerGreen, chkGreen.checked);
  });

  rngRoadWidth?.addEventListener("input", applyStyles);
  rngOpacity?.addEventListener("input", applyStyles);
  btnResetLayout?.addEventListener("click", () => {
    resetLayout();
    // If we moved proxies but we're currently in pan mode, temporarily show proxies
    // so the reset animation is visible.
    const needProxyForReset = !useProxyMode && anyMovedMarkers();
    const prevMode = toolMode;
    if (needProxyForReset) setToolMode("move");
    animateBackToOriginal(1200, {
      onDone: () => {
        if (needProxyForReset && prevMode === "pan") setToolMode("pan");
      },
    });
  });

  btnRandomize?.addEventListener("click", () => {
    const intensity = Number(rngRandomize?.value ?? 35) / 100;
    lastForce = Math.round(intensity * 100);
    animateRandomize(intensity);
  });

  btnToolPan?.addEventListener("click", () => setToolMode("pan"));
  btnToolMove?.addEventListener("click", () => setToolMode("move"));

  rngPickRadius?.addEventListener("input", () => {
    pickRadiusPx = Number(rngPickRadius.value);
    updateBrushVizAt(lastMouseContainerPt);
  });

  btnExportPng?.addEventListener("click", exportPngSquare);
  btnRecord10s?.addEventListener("click", recordVideo10sSquare);

  btnDownloadMenu?.addEventListener("click", () => {
    downloadMenu?.classList.toggle("downloadMenu--closed");
  });

  // Close menu after action + click outside
  btnExportPng?.addEventListener("click", () => downloadMenu?.classList.add("downloadMenu--closed"));
  btnRecord10s?.addEventListener("click", () => downloadMenu?.classList.add("downloadMenu--closed"));
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!downloadMenu || !btnDownloadMenu) return;
    if (downloadMenu.contains(t) || btnDownloadMenu.contains(t)) return;
    downloadMenu.classList.add("downloadMenu--closed");
  });

  setPaletteSwatch(palNoir, THEMES.noir);
  setPaletteSwatch(palMidnight, THEMES.midnight_blue);
  setPaletteSwatch(palCoral, THEMES.coral);
  setPaletteSwatch(palSage, THEMES.sage);
  setPaletteSwatch(palHeatwave, THEMES.heatwave);

  palNoir?.addEventListener("click", () => applyTheme("noir"));
  palMidnight?.addEventListener("click", () => applyTheme("midnight_blue"));
  palCoral?.addEventListener("click", () => applyTheme("coral"));
  palSage?.addEventListener("click", () => applyTheme("sage"));
  palHeatwave?.addEventListener("click", () => applyTheme("heatwave"));

  // Start closed (icon-only UI)
  closePanel();
}

function toBBoxString(bounds) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  return `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`;
}

function addOverpassGeometriesToLayer(elements, layer, kind) {
  for (const el of elements) {
    const rings = extractLatLngsFromOverpassElement(el);
    if (!rings.length || !rings.flat().length) continue;

    // Heuristic: closed ring -> polygon; else polyline
    const firstRing = rings[0];
    const isClosed =
      firstRing.length > 3 &&
      firstRing[0][0] === firstRing[firstRing.length - 1][0] &&
      firstRing[0][1] === firstRing[firstRing.length - 1][1];

    if (kind === "polygon" || (kind === "auto" && isClosed)) {
      const poly = L.polygon(rings, { interactive: false });
      poly.__tags = el.tags ?? null;
      storeOriginalIfMissing(poly);
      // default to non-interactive unless caller uses typed batched loader
      addToIndex(poly, "other");
      layer.addLayer(poly);
    } else {
      const line = L.polyline(firstRing, { interactive: false });
      line.__tags = el.tags ?? null;
      storeOriginalIfMissing(line);
      addToIndex(line, "other");
      layer.addLayer(line);
    }
  }
}

function addOverpassGeometriesToLayerBatched(
  elements,
  layer,
  kind,
  { batchSize = 500, onProgress, type = "other" } = {},
) {
  let i = 0;
  const total = elements.length;

  const step = () => {
    const end = Math.min(total, i + batchSize);
    for (; i < end; i++) {
      const el = elements[i];
      const rings = extractLatLngsFromOverpassElement(el);
      if (!rings.length || !rings.flat().length) continue;

      const firstRing = rings[0];
      const isClosed =
        firstRing.length > 3 &&
        firstRing[0][0] === firstRing[firstRing.length - 1][0] &&
        firstRing[0][1] === firstRing[firstRing.length - 1][1];

      if (kind === "polygon" || (kind === "auto" && isClosed)) {
        const poly = L.polygon(rings, { interactive: false });
        poly.__tags = el.tags ?? null;
        storeOriginalIfMissing(poly);
        addToIndex(poly, type);
        styleNewLayer(poly, type);
        layer.addLayer(poly);
      } else {
        const line = L.polyline(firstRing, { interactive: false });
        line.__tags = el.tags ?? null;
        storeOriginalIfMissing(line);
        addToIndex(line, type);
        styleNewLayer(line, type);
        layer.addLayer(line);
      }
    }

    onProgress?.(i, total);
    if (i < total) requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}

async function loadRegionData() {
  setLoading(true);
  // reset indices and stored layers on reload
  featureItems.length = 0;
  proxyItems.length = 0;
  featureIndex.clear();
  movedLayers.clear();
  velocities.clear();
  // Only fetch within the Haifa+Krayot region (bounded)
  const bbox = toBBoxString(regionBounds);

  // Phase 1 (fast): roads/paths/green first so something appears quickly.
  const qFast = `
[out:json][timeout:20];
(
  way["highway"]["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified|service"](${bbox});
  way["highway"]["highway"~"footway|path|cycleway|steps|track"](${bbox});
  way["leisure"="park"](${bbox});
  relation["leisure"="park"](${bbox});
  way["landuse"="grass"](${bbox});
  way["landuse"="forest"](${bbox});
  way["natural"="wood"](${bbox});
);
out geom qt;
`.trim();

  const fast = await overpassQuery(qFast).catch(() => null);
  const elsFast = fast?.elements ?? [];

  const roads = elsFast.filter((e) => e.type === "way" && e.tags?.highway && /motorway|trunk|primary|secondary|tertiary|residential|unclassified|service/.test(e.tags.highway));
  const paths = elsFast.filter((e) => e.type === "way" && e.tags?.highway && /footway|path|cycleway|steps|track/.test(e.tags.highway));
  const green = elsFast.filter((e) => {
    const t = e.tags ?? {};
    return t.leisure === "park" || t.landuse === "grass" || t.landuse === "forest" || t.natural === "wood";
  });

  layerBuildings.clearLayers();
  layerRoads.clearLayers();
  layerPaths.clearLayers();
  layerGreen.clearLayers();

  // Add "interactive-friendly" layers in batches so UI stays responsive
  addOverpassGeometriesToLayerBatched(roads, layerRoads, "polyline", { batchSize: 900, type: "roads" });
  addOverpassGeometriesToLayerBatched(paths, layerPaths, "polyline", { batchSize: 900, type: "paths" });
  addOverpassGeometriesToLayerBatched(green, layerGreen, "auto", { batchSize: 650, type: "green" });

  // Base styles (no labels)
  // Styles are applied as layers are added; this applies to any pre-existing ones.
  applyStyles();
  setLoading(false);

  // Phase 2 (slow): buildings in background, batched to avoid freezing.
  const qBld = `
[out:json][timeout:40];
(
  way["building"](${bbox});
  relation["building"](${bbox});
);
out geom qt;
`.trim();

  const bld = await overpassQuery(qBld).catch(() => null);
  const elsBld = bld?.elements ?? [];
  const buildings = elsBld.filter((e) => (e.type === "way" || e.type === "relation") && e.tags?.building);

  // Add buildings gradually
  addOverpassGeometriesToLayerBatched(buildings, layerBuildings, "auto", {
    batchSize: 450,
    type: "buildings",
    onProgress: (done, total) => {
      if (done === total) {
        layerBuildings.eachLayer((l) => l.setStyle?.({ weight: 1 }));
        applyStyles();
        if (useProxyMode) {
          rebuildProxies();
          rebuildIndex();
        }
      }
    },
  });
}

function wireMouseDrag() {
  const container = map.getContainer();

  map.on("mousemove", (e) => {
    if (toolMode !== "move") {
      container.style.cursor = "";
      return;
    }
    lastMouseContainerPt = map.latLngToContainerPoint(e.latlng);
    updateBrushVizAt(lastMouseContainerPt);
    if (tossing.active) {
      // "Brush toss": while mouse is held, keep repelling elements under the brush.
      tossAt(e.latlng, 14);
      tossing.lastMouseLatLng = e.latlng;
      container.style.cursor = "grabbing";
      return;
    }

    const near = nearestLayerWithinRadius(e.latlng, pickRadiusPx);
    hoverLayer = near;
    container.style.cursor = near ? "grab" : "crosshair";
  });

  map.on("mousedown", (e) => {
    if (toolMode !== "move") return;
    if (e.originalEvent?.button !== 0) return;
    // Avoid grabbing when clicking on the panel itself, but allow moving elements
    // even if the panel is open.
    const target = e.originalEvent?.target;
    if (panelEl && target && panelEl.contains(target)) return;

    tossing.active = true;
    tossing.lastMouseLatLng = e.latlng;
    // Initial "throw" burst
    tossAt(e.latlng, 26);
  });

  const endToss = () => {
    if (!tossing.active) return;
    tossing.active = false;
    tossing.lastMouseLatLng = null;
    container.style.cursor = hoverLayer ? "grab" : "crosshair";
  };

  map.on("mouseup", endToss);
  map.on("mouseout", endToss);
}

// Lock zoom-out so the user can't move farther than the Haifa district framing.
map.fitBounds(regionBounds.pad(0.02));
const lockedMinZoom = map.getZoom();
map.setMinZoom(lockedMinZoom);
map.on("zoomend", () => {
  if (map.getZoom() < lockedMinZoom) map.setZoom(lockedMinZoom);
});

wirePanel();
applyTheme("midnight_blue");
loadRegionData();
wireMouseDrag();
setToolMode("pan");

// no glyph canvas bindings


/**
 * Построение линии маршрута по GPS-координатам без OSRM/Valhalla.
 *
 * Идея: маршрут уже известен как последовательность остановок. Каждый трек
 * проецируется на ломаную «остановка → остановка», после чего для каждого
 * участка между соседними остановками собирается робастная осевая линия:
 * координаты вдоль участка разбиваются на бины, поперёк берётся медиана.
 * Несколько проездов объединяются, линия сглаживается и упрощается.
 */

const EARTH_RADIUS = 6_371_008.8;
const RAD = Math.PI / 180;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function haversineMeters(a, b) {
  const lon1 = a[0] * RAD;
  const lat1 = a[1] * RAD;
  const lon2 = b[0] * RAD;
  const lat2 = b[1] * RAD;
  const dLon = lon2 - lon1;
  const dLat = lat2 - lat1;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLengthMeters(line) {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    total += haversineMeters(line[i - 1], line[i]);
  }
  return total;
}

function stopPoints(stops) {
  return stops
    .map((stop) => ({
      stopId: stop.stopId,
      lat: Number(stop.lat),
      lon: Number(stop.lon),
    }))
    .filter(
      (stop) =>
        Number.isFinite(stop.lat) &&
        Number.isFinite(stop.lon) &&
        Math.abs(stop.lat) <= 90 &&
        Math.abs(stop.lon) <= 180,
    );
}

function buildStopLine(stops) {
  const points = stopPoints(stops);
  if (points.length < 2) return null;

  const segments = [];
  let cursor = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const length = haversineMeters([a.lon, a.lat], [b.lon, b.lat]);
    if (length < 1) continue;

    segments.push({
      index: segments.length,
      a,
      b,
      length,
      start: cursor,
      end: cursor + length,
    });
    cursor += length;
  }

  if (!segments.length) return null;

  return { points, segments, total: cursor };
}

function segmentFrame(seg) {
  const lat0 = ((seg.a.lat + seg.b.lat) / 2) * RAD;
  const bx = (seg.b.lon - seg.a.lon) * RAD * EARTH_RADIUS * Math.cos(lat0);
  const by = (seg.b.lat - seg.a.lat) * RAD * EARTH_RADIUS;
  const length = Math.hypot(bx, by);

  if (length < 1e-6) {
    return { lat0, bx: 0, by: 0, length: 0, ux: 1, uy: 0, vx: 0, vy: 1 };
  }

  const ux = bx / length;
  const uy = by / length;

  return {
    lat0,
    bx,
    by,
    length,
    ux,
    uy,
    vx: -uy,
    vy: ux,
  };
}

function projectToSegment(lon, lat, seg, frame) {
  const px = (lon - seg.a.lon) * RAD * EARTH_RADIUS * Math.cos(frame.lat0);
  const py = (lat - seg.a.lat) * RAD * EARTH_RADIUS;
  const rawT = frame.length > 0 ? (px * frame.bx + py * frame.by) / (frame.length * frame.length) : 0;
  const t = clamp(rawT, 0, 1);
  const dx = px - t * frame.bx;
  const dy = py - t * frame.by;

  return {
    t,
    rawT,
    distance: Math.hypot(dx, dy),
    along: seg.start + t * seg.length,
  };
}

function sideOffset(lon, lat, seg, frame) {
  const px = (lon - seg.a.lon) * RAD * EARTH_RADIUS * Math.cos(frame.lat0);
  const py = (lat - seg.a.lat) * RAD * EARTH_RADIUS;
  return px * frame.vx + py * frame.vy;
}

function pointWithOffset(seg, frame, t, offset) {
  const x = t * frame.bx + offset * frame.vx;
  const y = t * frame.by + offset * frame.vy;
  const lon = seg.a.lon + x / (EARTH_RADIUS * Math.cos(frame.lat0) * RAD);
  const lat = seg.a.lat + y / (EARTH_RADIUS * RAD);
  return [lon, lat];
}

function nearestProjection(lon, lat, stopLine, minAlong = -Infinity) {
  let best = null;

  for (const seg of stopLine.segments) {
    if (seg.end < minAlong - 80) continue;
    const frame = segmentFrame(seg);
    const projected = projectToSegment(lon, lat, seg, frame);
    let score = projected.distance;

    if (projected.along < minAlong - 60) {
      score += 1_500 + (minAlong - projected.along) * 3;
    }

    if (!best || score < best.score) {
      best = {
        ...projected,
        segIndex: seg.index,
        score,
      };
    }
  }

  return best;
}

export function projectTrace(samples, stopLine) {
  const sorted = [...samples]
    .filter(
      (sample) =>
        Number.isFinite(Number(sample.lat)) &&
        Number.isFinite(Number(sample.lon)) &&
        Number.isFinite(Number(sample.ts)),
    )
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const projected = [];
  let lastAlong = 0;

  for (const sample of sorted) {
    const p = nearestProjection(Number(sample.lon), Number(sample.lat), stopLine, lastAlong - 40);
    if (!p) continue;
    if (p.along < lastAlong - 120) continue;

    lastAlong = Math.max(lastAlong, p.along);
    projected.push({
      ts: Number(sample.ts),
      lon: Number(sample.lon),
      lat: Number(sample.lat),
      vector: Number(sample.vector) || 0,
      segIndex: p.segIndex,
      t: p.t,
      distance: p.distance,
      along: lastAlong,
    });
  }

  return projected;
}

export function splitTrips(samples, gapMs) {
  const sorted = [...samples].sort((a, b) => Number(a.ts) - Number(b.ts));
  const trips = [];
  let current = [];

  for (const sample of sorted) {
    if (!current.length) {
      current.push(sample);
      continue;
    }

    const previous = current[current.length - 1];
    if (Number(sample.ts) - Number(previous.ts) > gapMs) {
      trips.push(current);
      current = [sample];
    } else {
      current.push(sample);
    }
  }

  if (current.length) trips.push(current);
  return trips;
}

function analyzeProjected(projected, stopLine) {
  const used = new Set(projected.map((p) => p.segIndex));
  const missingSegments = stopLine.segments
    .filter((seg) => !used.has(seg.index))
    .map((seg) => seg.index);

  const firstStop = stopLine.points[0];
  const lastStop = stopLine.points[stopLine.points.length - 1];
  const first = projected[0];
  const last = projected[projected.length - 1];

  const startDistance = first ? haversineMeters([first.lon, first.lat], [firstStop.lon, firstStop.lat]) : Infinity;
  const endDistance = last ? haversineMeters([last.lon, last.lat], [lastStop.lon, lastStop.lat]) : Infinity;

  return {
    projected,
    usedSegments: used.size,
    missingSegments,
    startDistance,
    endDistance,
    complete:
      missingSegments.length === 0 &&
      startDistance <= 160 &&
      endDistance <= 160 &&
      projected.length >= stopLine.segments.length,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function segmentCenterline(seg, projected, options) {
  const frame = segmentFrame(seg);
  const corridor = Math.min(
    options.maxCorridorMeters,
    Math.max(90, seg.length * 0.85),
  );

  const samples = [];

  for (const point of projected) {
    if (point.segIndex !== seg.index) continue;
    if (point.t < -0.05 || point.t > 1.05) continue;
    const offset = sideOffset(point.lon, point.lat, seg, frame);
    if (Math.abs(offset) > corridor) continue;
    samples.push({ t: point.t, offset });
  }

  if (samples.length < 2) return null;

  const center = median(samples.map((sample) => sample.offset));
  const deviations = samples.map((sample) => Math.abs(sample.offset - center));
  const mad = median(deviations) || 1;
  const allowed = Math.max(25, mad * 5);
  const filtered = samples.filter((sample) => Math.abs(sample.offset - center) <= allowed);

  if (filtered.length < 2) return null;

  const binCount = clamp(Math.round(seg.length / 70), 4, 50);
  const bins = Array.from({ length: binCount }, () => []);

  for (const sample of filtered) {
    const index = clamp(Math.floor(clamp(sample.t, 0, 0.999999) * binCount), 0, binCount - 1);
    bins[index].push(sample.offset);
  }

  const known = [];
  for (let i = 0; i < bins.length; i += 1) {
    if (!bins[i].length) continue;
    known.push({
      t: (i + 0.5) / binCount,
      offset: median(bins[i]),
    });
  }

  const coverage = known.length / binCount;
  if (known.length < 2 || coverage < 0.3) return null;

  const line = [[seg.a.lon, seg.a.lat]];
  for (const point of known) {
    line.push(pointWithOffset(seg, frame, point.t, point.offset));
  }
  line.push([seg.b.lon, seg.b.lat]);

  return {
    line,
    coverage,
    samples: filtered.length,
  };
}

function perpendicularDistance(point, start, end) {
  const lat0 = ((start[1] + end[1]) / 2) * RAD;
  const bx = (end[0] - start[0]) * RAD * EARTH_RADIUS * Math.cos(lat0);
  const by = (end[1] - start[1]) * RAD * EARTH_RADIUS;
  const px = (point[0] - start[0]) * RAD * EARTH_RADIUS * Math.cos(lat0);
  const py = (point[1] - start[1]) * RAD * EARTH_RADIUS;
  const length2 = bx * bx + by * by;

  if (length2 === 0) return Math.hypot(px, py);

  const t = clamp((px * bx + py * by) / length2, 0, 1);
  return Math.hypot(px - t * bx, py - t * by);
}

export function simplifyLine(line, toleranceMeters) {
  if (line.length <= 2) return line;

  let maxDistance = -1;
  let index = -1;

  for (let i = 1; i < line.length - 1; i += 1) {
    const distance = perpendicularDistance(line[i], line[0], line[line.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }

  if (maxDistance <= toleranceMeters || index < 0) {
    return [line[0], line[line.length - 1]];
  }

  const left = simplifyLine(line.slice(0, index + 1), toleranceMeters);
  const right = simplifyLine(line.slice(index), toleranceMeters);
  return [...left.slice(0, -1), ...right];
}

export function smoothLine(line, iterations = 1) {
  if (line.length < 3) return line;

  let result = line;
  for (let pass = 0; pass < iterations; pass += 1) {
    const next = [result[0]];
    for (let i = 1; i < result.length - 1; i += 1) {
      next.push([
        (result[i - 1][0] + result[i][0] * 2 + result[i + 1][0]) / 4,
        (result[i - 1][1] + result[i][1] * 2 + result[i + 1][1]) / 4,
      ]);
    }
    next.push(result[result.length - 1]);
    result = next;
  }

  return result;
}

function straightLength(stops) {
  let total = 0;
  for (let i = 1; i < stops.length; i += 1) {
    total += haversineMeters(
      [Number(stops[i - 1].lon), Number(stops[i - 1].lat)],
      [Number(stops[i].lon), Number(stops[i].lat)],
    );
  }
  return total;
}

export function buildStraightLine(stops) {
  const points = stopPoints(stops);
  const line = [];

  for (const point of points) {
    const coordinate = [point.lon, point.lat];
    const previous = line[line.length - 1];
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
      line.push(coordinate);
    }
  }

  if (line.length < 2) return null;

  return {
    line,
    length: lineLengthMeters(line),
  };
}

function projectStopOnLine(stop, line) {
  let best = null;
  let cursor = 0;

  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    const segLength = haversineMeters(a, b);
    if (segLength < 1e-6) continue;

    const lat0 = ((a[1] + b[1]) / 2) * RAD;
    const bx = (b[0] - a[0]) * RAD * EARTH_RADIUS * Math.cos(lat0);
    const by = (b[1] - a[1]) * RAD * EARTH_RADIUS;
    const px = (Number(stop.lon) - a[0]) * RAD * EARTH_RADIUS * Math.cos(lat0);
    const py = (Number(stop.lat) - a[1]) * RAD * EARTH_RADIUS;
    const length2 = bx * bx + by * by;
    const t = length2 > 0 ? clamp((px * bx + py * by) / length2, 0, 1) : 0;
    const distance = Math.hypot(px - t * bx, py - t * by);
    const along = cursor + t * segLength;

    if (!best || distance < best.distance) {
      best = { distance, along };
    }
    cursor += segLength;
  }

  return best || { distance: Infinity, along: 0 };
}

export function validateLine(line, stops, options = {}) {
  const tolerance = options.stopToleranceMeters ?? 80;
  const maxLengthFactor = options.maxLengthFactor ?? 3.5;
  const expectedLength = straightLength(stops);
  const length = lineLengthMeters(line);

  if (line.length < 2) {
    return { valid: false, reason: 'too-few-points', length, expectedLength };
  }

  if (expectedLength > 0 && (length < expectedLength * 0.9 || length > expectedLength * maxLengthFactor)) {
    return {
      valid: false,
      reason: 'length-out-of-range',
      length,
      expectedLength,
    };
  }

  let maxStopDistance = 0;
  let maxStopJump = 0;
  let lastAlong = -Infinity;
  let orderOk = true;

  for (const stop of stops) {
    const projected = projectStopOnLine(stop, line);
    maxStopDistance = Math.max(maxStopDistance, projected.distance);
    if (projected.distance > tolerance) {
      return {
        valid: false,
        reason: 'stop-too-far',
        stopId: stop.stopId,
        distance: projected.distance,
        maxStopDistance,
        length,
        expectedLength,
      };
    }
    if (Number.isFinite(lastAlong)) {
      maxStopJump = Math.max(maxStopJump, Math.abs(projected.along - lastAlong));
      if (projected.along < lastAlong - 150) orderOk = false;
    }
    lastAlong = projected.along;
  }

  if (!orderOk && !options.allowLoop) {
    return {
      valid: false,
      reason: 'stop-order',
      maxStopDistance,
      length,
      expectedLength,
    };
  }

  let maxSegmentJump = 0;
  for (let i = 1; i < line.length; i += 1) {
    maxSegmentJump = Math.max(maxSegmentJump, haversineMeters(line[i - 1], line[i]));
  }

  if (maxSegmentJump > 2_500) {
    return {
      valid: false,
      reason: 'segment-jump',
      maxSegmentJump,
      length,
      expectedLength,
    };
  }

  return {
    valid: true,
    length,
    expectedLength,
    maxStopDistance,
    maxStopJump,
    maxSegmentJump,
  };
}

function cleanTraceLine(projected, stops, options = {}) {
  const line = [];
  const maxCorridor = options.maxCorridorMeters ?? 1_500;
  let previousPoint = null;

  for (const point of projected) {
    if (point.distance > maxCorridor) continue;
    const coordinate = [point.lon, point.lat];

    if (!previousPoint) {
      line.push(coordinate);
      previousPoint = point;
      continue;
    }

    const previousCoordinate = line[line.length - 1];
    const distance = haversineMeters(previousCoordinate, coordinate);
    if (distance < 3) continue;

    const dt = Math.abs(point.ts - previousPoint.ts) / 1000;
    const speed = dt > 0 ? distance / dt : Infinity;
    if (speed > 55) continue;

    line.push(coordinate);
    previousPoint = point;
  }

  if (line.length >= 2 && stops.length >= 2) {
    line[0] = [Number(stops[0].lon), Number(stops[0].lat)];
    line[line.length - 1] = [Number(stops[stops.length - 1].lon), Number(stops[stops.length - 1].lat)];
  }

  return line;
}

export function buildFirstPassGeometry({ traces, stops, options = {} }) {
  const stopLine = buildStopLine(stops);
  if (!stopLine) return null;

  const analyzed = traces
    .map((trace) => analyzeProjected(projectTrace(trace.samples, stopLine), stopLine))
    .filter((trace) => trace.complete)
    .sort((a, b) => b.projected.length - a.projected.length);

  const best = analyzed[0];
  if (!best) return null;

  let line = cleanTraceLine(best.projected, stops, options);
  if (line.length < 2) return null;

  line = smoothLine(line, 1);
  line = simplifyLine(line, options.simplifyMeters ?? 6);
  line[0] = [Number(stops[0].lon), Number(stops[0].lat)];
  line[line.length - 1] = [Number(stops[stops.length - 1].lon), Number(stops[stops.length - 1].lat)];

  const validation = validateLine(line, stops, options);
  if (!validation.valid) return null;

  return {
    line,
    ...validation,
    stats: {
      traces: traces.length,
      completeTraces: analyzed.length,
      samples: best.projected.length,
      startDistance: best.startDistance,
      endDistance: best.endDistance,
    },
  };
}

export function buildAggregateGeometry({ traces, stops, options = {} }) {
  const stopLine = buildStopLine(stops);
  if (!stopLine) return null;

  const analyzed = traces.map((trace) => analyzeProjected(projectTrace(trace.samples, stopLine), stopLine));
  const complete = analyzed.filter((trace) => trace.complete);
  const allProjected = analyzed.flatMap((trace) => trace.projected);

  if (!allProjected.length) return null;

  const line = [];
  let coveredSegments = 0;
  let usedSamples = 0;

  for (const seg of stopLine.segments) {
    const centerline = segmentCenterline(seg, allProjected, {
      maxCorridorMeters: options.maxCorridorMeters ?? 1_500,
    });

    const segmentLine = centerline?.line ?? [
      [seg.a.lon, seg.a.lat],
      [seg.b.lon, seg.b.lat],
    ];

    if (centerline) {
      coveredSegments += 1;
      usedSamples += centerline.samples;
    }

    for (const point of segmentLine) {
      const previous = line[line.length - 1];
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) {
        line.push(point);
      }
    }
  }

  if (line.length < 2) return null;

  let result = smoothLine(line, 1);
  result = simplifyLine(result, options.simplifyMeters ?? 6);
  result[0] = [Number(stops[0].lon), Number(stops[0].lat)];
  result[result.length - 1] = [Number(stops[stops.length - 1].lon), Number(stops[stops.length - 1].lat)];

  const validation = validateLine(result, stops, options);
  if (!validation.valid) return null;

  const coverage = coveredSegments / stopLine.segments.length;

  return {
    line: result,
    ...validation,
    coverage,
    stats: {
      traces: traces.length,
      completeTraces: complete.length,
      samples: allProjected.length,
      usedSamples,
      segments: stopLine.segments.length,
      coveredSegments,
      coverage: Number(coverage.toFixed(3)),
    },
  };
}

export function stopLineFromStops(stops) {
  return buildStopLine(stops);
}

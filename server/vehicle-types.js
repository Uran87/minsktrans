const VEHICLE_TYPE_NAMES = ['bus', 'trolley', 'tram'];

function normalizeType(value) {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < VEHICLE_TYPE_NAMES.length) {
    return VEHICLE_TYPE_NAMES[numeric];
  }

  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'bus' || text.includes('автобус')) return 'bus';
  if (text === 'trolley' || text === 'trolleybus' || text.includes('троллейбус')) return 'trolley';
  if (text === 'tram' || text === 'tramway' || text.includes('трамвай')) return 'tram';
  return null;
}

/**
 * Типы ТС из справочника /vehicles: 0 — автобус, 1 — троллейбус, 2 — трамвай.
 * Нужны, чтобы не показывать автобус как троллейбус, если API вернул
 * смешанный список по совпадающему номеру маршрута.
 */
export function loadVehicleTypeMap(db) {
  const map = new Map();

  for (const row of db.prepare('SELECT vehicle_id, vehicle_type FROM vehicles').all()) {
    const type = normalizeType(row.vehicle_type);
    if (type) map.set(Number(row.vehicle_id), type);
  }

  return map;
}

export function filterVehiclesByTransport(vehicles, typeMap, transport) {
  if (!typeMap.size) return vehicles;
  const expected = normalizeType(transport);
  if (!expected) return vehicles;

  return vehicles.filter((vehicle) => {
    const actual = typeMap.get(Number(vehicle.vehicleId));
    return !actual || actual === expected;
  });
}

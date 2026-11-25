/**
 * Демо-набор данных для разработки и для запуска контейнера без доступа к API.
 *
 * Данные собраны по реальным ответам API (маршрут №1, остановки Минска).
 * Формат ответов полностью повторяет API, поэтому нормализация в api.js
 * проверяется на тех же структурах, что и в проде.
 */

const LOOP_DURATION = 20 * 60 * 1000; // полный круг демо-машины за 20 минут
const STARTED_AT = Date.now();

/**
 * Остановки маршрута №1 в прямом направлении (порядок из vehicleState.marshrutStops).
 */
const STOP_DEFS = [
  { id: 15846, name: 'Конечная «Минск-Арена»', lat: 53.933204, lon: 27.475213 },
  { id: 54756, name: 'Нарочанская', lat: 53.934715, lon: 27.478786 },
  { id: 54757, name: 'Минск-Арена', lat: 53.937325, lon: 27.482409 },
  { id: 15850, name: 'Университет физкультуры', lat: 53.937187, lon: 27.48889 },
  { id: 15852, name: 'Радужная', lat: 53.93523, lon: 27.498363 },
  { id: 15854, name: 'Крупцы', lat: 53.933514, lon: 27.503428 },
  { id: 15856, name: 'Футбольный манеж', lat: 53.931408, lon: 27.509321 },
  { id: 15084, name: 'Площадь Государственного флага', lat: 53.92644, lon: 27.519592 },
  { id: 15112, name: 'Республиканский центр тенниса', lat: 53.924316, lon: 27.523912 },
  { id: 15113, name: 'Комсомольское озеро', lat: 53.91971, lon: 27.530458 },
  { id: 15890, name: 'Гвардейская', lat: 53.91603, lon: 27.535408 },
  { id: 15114, name: 'Гостиница «Юбилейная»', lat: 53.911385, lon: 27.546974 },
  { id: 15115, name: 'Замчище', lat: 53.907795, lon: 27.550817 },
  { id: 16239, name: 'Площадь Свободы', nameBy: 'Плошча Свабоды', nameEn: 'Freedom Square', lat: 53.90354, lon: 27.555065 },
  { id: 15866, name: 'Ленина', nameBy: 'Леніна', nameEn: 'Lienina', lat: 53.900322, lon: 27.558138 },
  { id: 230003, name: 'Кирова', lat: 53.893215, lon: 27.55198 },
  { id: -230003, name: 'Кирова', lat: 53.891785, lon: 27.551159 },
  { id: 243538, name: 'Вокзал', nameBy: 'Вакзал', nameEn: 'Vakzal', lat: 53.891884, lon: 27.55005 },
  { id: 15870, name: 'Площадь Независимости', nameBy: 'Плошча Незалежнасці', nameEn: 'Independence Square', lat: 53.894928, lon: 27.548058 },
  { id: 15868, name: 'Володарского', lat: 53.89657, lon: 27.551258 },
  { id: 16238, name: 'Площадь Свободы', lat: 53.90319, lon: 27.556017 },
  { id: 15009, name: 'Дворец Спорта', lat: 53.908886, lon: 27.550146 },
  { id: 15010, name: 'Гостиница «Юбилейная»', lat: 53.91263, lon: 27.54564 },
  { id: 15011, name: 'Музей истории ВОВ', lat: 53.91512, lon: 27.537874 },
  { id: 15526, name: 'Гвардейская', lat: 53.916958, lon: 27.53479 },
  { id: 15039, name: 'Комсомольское озеро', lat: 53.920887, lon: 27.529602 },
  { id: 15040, name: 'Республиканский центр тенниса', lat: 53.92517, lon: 27.522953 },
  { id: 15855, name: 'Футбольный манеж', lat: 53.9324, lon: 27.507395 },
  { id: 15853, name: 'Крупцы', lat: 53.93444, lon: 27.50175 },
  { id: 15851, name: 'Радужная', lat: 53.936153, lon: 27.496683 },
  { id: 15849, name: 'Университет физкультуры', lat: 53.937534, lon: 27.488583 },
  { id: 54761, name: 'Минск-Арена', lat: 53.937664, lon: 27.482512 },
  { id: 15847, name: 'Посёлок Пионерский', lat: 53.93709, lon: 27.479269 },
  { id: 68808, name: 'Нарочанская', lat: 53.933613, lon: 27.478247 },
];

/**
 * Остальные остановки Минска (не входят в маршрут №1) — чтобы в демо-режиме
 * было видно, как обычные остановки отличаются от остановок выбранного маршрута.
 */
const CITY_STOPS = [
  { id: 14346, name: 'Ст. м. «Московская»', nameBy: 'Станцыя метро «Маскоўская»', nameEn: 'Maskoŭskaja st.m.', lat: 53.928482, lon: 27.630255 },
  { id: 14347, name: 'Большая Слепня', lat: 53.933643, lon: 27.63124 },
  { id: 14348, name: 'Большая Слепня', lat: 53.933872, lon: 27.63294 },
  { id: 14354, name: 'ДС «Калиновского»', lat: 53.94376, lon: 27.643093 },
  { id: 14369, name: 'Рогачевская', lat: 53.94547, lon: 27.720556 },
  { id: 14380, name: 'Поликлиника №28', lat: 53.95025, lon: 27.675854 },
  { id: 14383, name: 'ТЦ «Уручье»', lat: 53.93591, lon: 27.687498 },
  { id: 14397, name: 'Якуба Коласа', lat: 53.93838, lon: 27.606693 },
  { id: 14401, name: 'Короленко', lat: 53.935066, lon: 27.61831 },
  { id: 14408, name: 'Академгородок', lat: 53.927326, lon: 27.688824 },
  { id: 14430, name: 'Институт современных знаний', lat: 53.932922, lon: 27.638205 },
  { id: 14444, name: 'Сурганова', lat: 53.932285, lon: 27.577974 },
  { id: 14464, name: 'Базисная', lat: 53.94291, lon: 27.58834 },
  { id: 14477, name: 'Олега Кошевого', lat: 53.881668, lon: 27.601477 },
  { id: 14494, name: 'Площадь Калинина', lat: 53.923225, lon: 27.61052 },
  { id: 14511, name: 'Станция аэрации', lat: 53.831627, lon: 27.688065 },
  { id: 14512, name: 'Ст. м. «Восток»', nameBy: 'Станцыя метро «Усход»', nameEn: 'Uschod st.m.', lat: 53.934246, lon: 27.651144 },
  { id: 14520, name: 'Леонида Беды', lat: 53.932495, lon: 27.591045 },
  { id: 14527, name: 'Максима Танка', lat: 53.906757, lon: 27.533741 },
  { id: 14553, name: '2-я городская детская больница', lat: 53.93069, lon: 27.476254 },
  { id: 14561, name: 'Ратомская', lat: 53.935577, lon: 27.451385 },
  { id: 14572, name: 'Романовская Слобода', lat: 53.90253, lon: 27.547318 },
  { id: 14582, name: '5-я больница', lat: 53.87233, lon: 27.632793 },
  { id: 14589, name: 'Притыцкого', lat: 53.910343, lon: 27.505322 },
  { id: 14597, name: 'Ст. м. «Кунцевщина»', lat: 53.906326, lon: 27.451897 },
  { id: 14606, name: 'ДС «Кунцевщина»', lat: 53.915016, lon: 27.436398 },
  { id: 14613, name: 'Ст. м. «Каменная Горка»', lat: 53.906715, lon: 27.438087 },
  { id: 14628, name: 'Франциска Скорины', lat: 53.929108, lon: 27.700178 },
  { id: 14647, name: 'Школа №45', lat: 53.93895, lon: 27.6905 },
  { id: 14679, name: 'Тимошенко', lat: 53.90701, lon: 27.464005 },
  { id: 14680, name: 'Парк «Космос»', lat: 53.90755, lon: 27.469318 },
  { id: 14692, name: 'Площадь Бангалор', lat: 53.931984, lon: 27.574697 },
  { id: 14700, name: 'Проспект Пушкина', lat: 53.919785, lon: 27.49776 },
  { id: 14715, name: 'Харьковская', lat: 53.895866, lon: 27.49767 },
  { id: 14735, name: 'Долгобродская', lat: 53.88588, lon: 27.623714 },
  { id: 14758, name: 'Универсам «Рига»', lat: 53.929096, lon: 27.585 },
  { id: 14762, name: 'Индустриальный', lat: 53.891777, lon: 27.500046 },
  { id: 14777, name: 'Круглая площадь', lat: 53.893757, lon: 27.64213 },
  { id: 14780, name: 'Стадион «Трактор»', lat: 53.88278, lon: 27.614475 },
  { id: 14790, name: 'Переулок Восточный', lat: 53.94402, lon: 27.601122 },
  { id: 14813, name: 'Брилевская', lat: 53.87307, lon: 27.52748 },
  { id: 14829, name: 'Пищекомбинат', lat: 53.856724, lon: 27.679146 },
  { id: 14843, name: 'Выставочный комплекс', lat: 53.92916, lon: 27.52115 },
  { id: 14854, name: 'Евфросинии Полоцкой', lat: 53.901638, lon: 27.472527 },
  { id: 14863, name: 'Якубовского', lat: 53.90452, lon: 27.45153 },
  { id: 14903, name: 'Гурского', lat: 53.89292, lon: 27.484247 },
  { id: 14915, name: 'Слободская', lat: 53.84438, lon: 27.463657 },
  { id: 14937, name: 'Универсам «Брест»', lat: 53.85954, lon: 27.46182 },
  { id: 14947, name: 'Малиновка-6', lat: 53.85042, lon: 27.439034 },
  { id: 14966, name: 'Водонасосная', lat: 53.94454, lon: 27.539682 },
  { id: 14979, name: 'Школа №209', lat: 53.859314, lon: 27.443838 },
  { id: 14981, name: 'Малиновка-5', lat: 53.85941, lon: 27.436642 },
  { id: 14997, name: 'Севастопольский парк', lat: 53.93638, lon: 27.637028 },
  { id: 15015, name: 'Волгоградская', lat: 53.931206, lon: 27.622002 },
  { id: 15024, name: 'Медколледж', lat: 53.85594, lon: 27.514318 },
  { id: 15044, name: 'Покровская', lat: 53.93855, lon: 27.49403 },
  { id: 15054, name: 'Корженевского', lat: 53.84427, lon: 27.52525 },
  { id: 15056, name: 'Завод «Транзистор»', lat: 53.843933, lon: 27.518108 },
  { id: 15065, name: 'Казинца', lat: 53.868454, lon: 27.52639 },
  { id: 15107, name: 'Калинина', lat: 53.92725, lon: 27.605274 },
  { id: 15139, name: 'Поликлиника №10', lat: 53.88641, lon: 27.436617 },
  { id: 15146, name: 'Поликлиника №16', lat: 53.93443, lon: 27.556618 },
  { id: 15167, name: 'Проспект Жукова', lat: 53.89543, lon: 27.499876 },
  { id: 15190, name: 'Переспа', lat: 53.92061, lon: 27.550247 },
  { id: 15207, name: 'Хмелевского', lat: 53.889454, lon: 27.522268 },
  { id: 15344, name: 'Варвашени', lat: 53.864502, lon: 27.66601 },
  { id: 15533, name: 'Ташкентская', lat: 53.839058, lon: 27.63048 },
  { id: 15564, name: 'Технологический университет', lat: 53.89175, lon: 27.557547 },
  { id: 15600, name: 'Ст. м. «Немига»', nameBy: 'Станцыя метро «Няміга»', nameEn: 'Niamiha st.m.', lat: 53.906036, lon: 27.55512 },
  { id: 15675, name: 'Щорса', lat: 53.8803, lon: 27.52047 },
  { id: 15867, name: 'Ленина', lat: 53.89996, lon: 27.5583 },
  { id: 15905, name: 'Аранская', lat: 53.88613, lon: 27.569866 },
  { id: 16077, name: 'Хмаринская', lat: 53.970528, lon: 27.587883 },
];

function bearing(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

const FORWARD = STOP_DEFS.map((stop, index) => ({
  ...stop,
  vector: bearing(stop, STOP_DEFS[Math.min(index + 1, STOP_DEFS.length - 1)]),
}));

const REVERSE = [...FORWARD]
  .reverse()
  .map((stop, index, list) => ({
    ...stop,
    vector: bearing(stop, list[Math.min(index + 1, list.length - 1)]),
  }));

const VEHICLES = [
  {
    vehicleId: 446007,
    direction: 1,
    progress: 0.02,
    gosnum: '061 AAE',
    model: 'МАЗ-203.047',
    tripNum: '102',
    garnum: 34347,
  },
  {
    vehicleId: 444978,
    direction: 1,
    progress: 0.18,
    gosnum: '118 AI',
    model: 'МАЗ-203.015',
    tripNum: '104',
    garnum: 34348,
  },
  {
    vehicleId: 446015,
    direction: 1,
    progress: 0.55,
    gosnum: '903 AAE',
    model: 'АКСМ-32100D',
    tripNum: '106',
    garnum: 34349,
  },
  {
    vehicleId: 446000,
    direction: 0,
    progress: 0.08,
    gosnum: '445 AAE',
    model: 'МАЗ-203.047',
    tripNum: '101',
    garnum: 34350,
  },
  {
    vehicleId: 446021,
    direction: 0,
    progress: 0.32,
    gosnum: '217 AI',
    model: 'АКСМ-32100D',
    tripNum: '103',
    garnum: 34351,
  },
  {
    vehicleId: 446033,
    direction: 0,
    progress: 0.71,
    gosnum: '752 AAE',
    model: 'МАЗ-203.015',
    tripNum: '105',
    garnum: 34352,
  },
];

function orderFor(direction) {
  return Number(direction) === 0 ? REVERSE : FORWARD;
}

function currentProgress(vehicle, now = Date.now()) {
  return (vehicle.progress + (now - STARTED_AT) / LOOP_DURATION) % 1;
}

function positionOn(order, progress) {
  const last = order.length - 1;
  const scaled = Math.min(Math.max(progress, 0), 0.999999) * last;
  const index = Math.min(Math.floor(scaled), last - 1);
  const fraction = scaled - index;
  const from = order[index];
  const to = order[Math.min(index + 1, last)];

  return {
    lat: Number((from.lat + (to.lat - from.lat) * fraction).toFixed(6)),
    lon: Number((from.lon + (to.lon - from.lon) * fraction).toFixed(6)),
    vector: from.vector,
    stopId: from.id,
    index,
  };
}

function round(value, digits = 6) {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

/* ------------------------------------------------------------------ */
/* Ответы, имитирующие API                                             */
/* ------------------------------------------------------------------ */

export function geoInfo() {
  const now = Date.now();

  return VEHICLES.map((vehicle) => {
    const position = positionOn(orderFor(vehicle.direction), currentProgress(vehicle, now));

    return {
      vehicleId: vehicle.vehicleId,
      direction: vehicle.direction,
      lat: round(position.lat),
      lon: round(position.lon),
      vector: Math.round((position.vector + 360) % 360),
    };
  });
}

export function stops() {
  return [...STOP_DEFS, ...CITY_STOPS].map((stop) => ({
    stopId: stop.id,
    nameRu: stop.name,
    nameBy: stop.nameBy || '',
    nameEn: stop.nameEn || '',
    vector: Number.isFinite(stop.vector) ? Math.round((stop.vector + 360) % 360) : 0,
    lat: stop.lat,
    lon: stop.lon,
    mapPolygon: `POINT (${stop.lon} ${stop.lat})`,
    mspsid: '',
  }));
}

export function vehicleState(vehicleId) {
  const vehicle = VEHICLES.find((item) => String(item.vehicleId) === String(vehicleId)) || VEHICLES[0];
  const order = orderFor(vehicle.direction);
  const position = positionOn(order, currentProgress(vehicle));

  return {
    marNuml: '1',
    tsTypeAdd: 'bus',
    categoryTraffic: 'обычный',
    cityCode: 66,
    marshrutStops: order.map((stop) => stop.id),
    tripId: 13_968_794 + (vehicle.vehicleId % 1000),
    tripNum: vehicle.tripNum,
    lastStopId: position.stopId,
    direction: vehicle.direction,
    gosnum: vehicle.gosnum,
    model: vehicle.model,
    garnum: vehicle.garnum,
  };
}

export function scheduleDay() {
  const makeTrip = (tripNum, direction, startMinutes, order) => ({
    tripNum,
    direction,
    stops: order.map((stop, index) => ({
      stopId: stop.id,
      departures: String(startMinutes + index * 2),
    })),
  });

  return {
    directionSchedule: [
      makeTrip('102', 1, 314, FORWARD),
      makeTrip('104', 1, 332, FORWARD),
      makeTrip('106', 1, 350, FORWARD),
      makeTrip('101', 0, 324, REVERSE),
      makeTrip('103', 0, 342, REVERSE),
      makeTrip('105', 0, 400, REVERSE),
    ],
  };
}

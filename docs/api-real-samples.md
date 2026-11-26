# Реальные примеры API СНОиПД

Базовый URL:

```
http://194.158.195.62:41290/api/v1
```

## Значения параметра `transport`

| Значение | Транспорт |
|---|---|
| `bus` | автобус |
| `trolleybus` | троллейбус |
| `tram` | трамвай |
| `routetaxi` | маршрутное такси |

Важно: в параметре запроса используется `trolleybus`, а не `trolley`.

В ответах `/scoreboard` тип маршрута приходит в `mType` **кириллицей**: `А` (автобус), `Т` (троллейбус), `#` (трамвай).

## `/geoinfomar` — автобусы маршрута №1

```http
GET /api/v1/geoinfomar?transport=bus&route=1
```

```json
[
  {
    "vehicleId": 444978,
    "direction": 1,
    "lat": 53.934444,
    "lon": 27.478394,
    "vector": 185
  },
  {
    "vehicleId": 446003,
    "direction": 1,
    "lat": 53.915157,
    "lon": 27.537834,
    "vector": 302
  },
  {
    "vehicleId": 445997,
    "direction": 1,
    "lat": 53.931637,
    "lon": 27.480175,
    "vector": 3
  },
  {
    "vehicleId": 446008,
    "direction": 1,
    "lat": 53.932396,
    "lon": 27.478178,
    "vector": 355
  },
  {
    "vehicleId": 12711,
    "direction": 0,
    "lat": 53.924976,
    "lon": 27.522552,
    "vector": 133
  },
  {
    "vehicleId": 445488,
    "direction": 0,
    "lat": 53.90755,
    "lon": 27.55116,
    "vector": 151
  },
  {
    "vehicleId": 446024,
    "direction": 1,
    "lat": 53.90355,
    "lon": 27.555367,
    "vector": 327
  }
]
```

## `/geoinfomar` — троллейбусы маршрута №1

```http
GET /api/v1/geoinfomar?transport=trolleybus&route=1
```

```json
[
  {
    "vehicleId": 446159,
    "direction": 1,
    "lat": 53.961742,
    "lon": 27.619366,
    "vector": 116
  },
  {
    "vehicleId": 446153,
    "direction": 1,
    "lat": 53.96191,
    "lon": 27.618982,
    "vector": 107
  },
  {
    "vehicleId": 446052,
    "direction": 0,
    "lat": 53.95674,
    "lon": 27.607626,
    "vector": 88
  },
  {
    "vehicleId": 446145,
    "direction": 0,
    "lat": 53.929085,
    "lon": 27.625168,
    "vector": 316
  },
  {
    "vehicleId": 446148,
    "direction": 0,
    "lat": 53.9444,
    "lon": 27.642496,
    "vector": 162
  }
]
```

## Поля ответа

| Поле | Тип | Описание |
|---|---|---|
| `vehicleId` | int | ID транспортного средства |
| `direction` | int | 0 — прямое, 1 — обратное, 2 — другое |
| `lat` | number | широта |
| `lon` | number | долгота |
| `vector` | int | направление движения в градусах |

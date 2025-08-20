// === script.js ===
// Requiere que 'data.js' exponga: const DATA = { ... } y utilitarios opcionales.
// Si usas bundler, importa; si es etiqueta <script>, asegúrate de cargar data.js antes de este archivo.
// import { DATA } from './data.js';

// -----------------------------
// 1) Parámetros de modelo
// -----------------------------

// Ajustes por TIPO de inmueble (multiplicadores base sobre el m² de la subzona)
const TYPE_FACTOR = {
  "Departamento": 1.00,
  "Casa": 0.95,         // Las casas suelen mostrar mayor heterogeneidad y descuento vs deptos en mismas zonas
  "Terreno": 0.90       // Precio de terreno en zonas residenciales suele ser menor por m² construido
};

// Ajuste por ANTIGÜEDAD (descuento acumulativo)
// Ej.: 0–5 años: -0.2%/año; 6–20: -0.6%/año; 21–40: -1.0%/año; 40+: -1.5%/año
function ageDepreciation(ageYears) {
  if (ageYears <= 0) return 0;
  if (ageYears <= 5)  return -0.002 * ageYears;
  if (ageYears <= 20) return -0.002*5 + -0.006 * (ageYears - 5);
  if (ageYears <= 40) return -0.002*5 + -0.006*15 + -0.010 * (ageYears - 20);
  return -0.002*5 + -0.006*15 + -0.010*20 + -0.015 * (ageYears - 40);
}

// Ajuste por PISO y ASCENSOR
// Sin ascensor: descuento adicional a partir del 4to. piso. Con ascensor: pequeño premio 1–3% según altura moderada.
function floorElevatorAdjustment(floorNumber, hasElevator) {
  if (!floorNumber || floorNumber < 1) return 0;
  if (hasElevator) {
    if (floorNumber <= 8) return 0.01 + Math.min((floorNumber - 1) * 0.001, 0.02); // +1% a +3% aprox
    return 0.00; // muy alto: neutralizamos
  } else {
    if (floorNumber <= 3) return 0;   // hasta 3 pisos, sin penalidad
    // desde 4to: -2% y -0.6% por piso adicional
    return -0.02 - Math.max(0, (floorNumber - 4)) * 0.006;
  }
}

// Ajuste por DORMITORIOS (ligero, respecto al m² base de la zona)
// Menos de 2 dorm: -1% a -3% (según 0–1 dorm); 3 dorm base; 4+: +1% por cada dormitorio adicional hasta +3%
function bedroomAdjustment(bedrooms) {
  if (!bedrooms || bedrooms === 3) return 0;
  if (bedrooms <= 1) return -0.03;
  if (bedrooms === 2) return -0.01;
  if (bedrooms === 4) return 0.01;
  if (bedrooms >= 5) return 0.02; // tope prudente
  return 0;
}

// Tolerancia de rango según dispersión del distrito
// Cuanto mayor gap entre zona más cara y más barata del distrito, más ancho el rango.
// Base 6% +/- y se amplía con la varianza relativa del distrito.
function dynamicRangeTolerance(districtStats) {
  const { min, max, avg } = districtStats;
  if (!avg || avg <= 0) return 0.06;
  const spread = (max - min) / avg;     // dispersión relativa
  // 6% base + hasta 8% adicional según spread
  return 0.06 + Math.min(spread * 0.25, 0.08);
}

// -----------------------------
// 2) Actualización de precios según fuentes (Urbania Index 2025)
//     - Mantenemos TODOS tus distritos y subzonas.
//     - Para cada distrito con valor publicado, escalamos sus subzonas de forma proporcional
//       para que el promedio del distrito coincida con Urbania.
// -----------------------------

// Promedios distritales (S/ m²) extraídos del reporte Urbania (Abril 2025).
// Fuentes: ver README/explicación en el chat con citas.
const URBANIA_DIST_AVG_2025_04 = {
  "Barranco": 9486,
  "San Isidro": 9223,
  "Miraflores": 8735,
  "San Borja": 7339,
  "Jesus Maria": 7316,
  "Lince": 7245,
  "Magdalena del Mar": 6890,
  "Santiago de Surco": 6812,
  "Surquillo": 6728,
  "La Victoria": 6642,
  "Pueblo Libre": 6332,
  "San Miguel": 6106,
  "Cercado de Lima": 6081,
  "Chorrillos": 5745,
  "La Molina": 5495,
  "Breña": 5217,
  "Ate": 4631,
  "Bellavista": 4140,
  "La Perla": 4106,
  "Los Olivos": 3641,
  "San Juan de Miraflores": 3583,
  "Callao": 3474,
  "San Martin de Porres": 3015
  // Otros distritos se conservan con tus valores (no hay dato directo en la lámina).
};

// Escala subzonas para que el promedio del distrito = valor Urbania
function applyDistrictLevelRebasing(DATA) {
  const result = JSON.parse(JSON.stringify(DATA));
  for (const [district, payload] of Object.entries(result)) {
    const targetAvg = URBANIA_DIST_AVG_2025_04[district];
    if (!targetAvg || !payload?.zones) continue;

    const prices = Object.values(payload.zones);
    const currentAvg = prices.reduce((a, b) => a + b, 0) / prices.length;
    if (!currentAvg || currentAvg <= 0) continue;

    const factor = targetAvg / currentAvg;
    Object.keys(payload.zones).forEach(zone => {
      const v = payload.zones[zone];
      payload.zones[zone] = Math.round(v * factor);
    });
  }
  return result;
}

// Precalcular estadísticas por distrito
function computeDistrictStats(DATA) {
  const stats = {};
  for (const [district, payload] of Object.entries(DATA)) {
    const prices = Object.values(payload?.zones || {});
    if (!prices.length) continue;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    stats[district] = { min, max, avg };
  }
  return stats;
}

// -----------------------------
// 3) Tipo de cambio USD⇆PEN (en vivo, con fallback)
// -----------------------------
async function fetchUsdPenRate() {
  try {
    // exchangerate.host es público y fiable; sin API key.
    const res = await fetch('https://api.exchangerate.host/latest?base=USD&symbols=PEN');
    const json = await res.json();
    const rate = json?.rates?.PEN;
    if (rate && rate > 0) return rate;
    throw new Error('rate missing');
  } catch (e) {
    // Fallback a un valor prudente; opcional: mostrar advertencia en UI
    console.warn('Fallo al obtener tipo de cambio en vivo. Usando fallback.');
    return 3.55; // referencia pública agosto 2025
  }
}

// -----------------------------
// 4) Núcleo de tasación
// -----------------------------
function getZonePricePerM2(DATA, district, zone) {
  const d = DATA[district];
  if (!d) throw new Error(`Distrito no encontrado: ${district}`);
  const zmap = d.zones || {};
  // Si no se pasa zona exacta, usamos promedio del distrito
  if (!zone || !zmap[zone]) {
    const vals = Object.values(zmap);
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return zmap[zone];
}

function buildValuationRange({
  DATA,
  district,
  zone,
  propertyType,     // "Departamento" | "Casa" | "Terreno"
  coveredAreaM2,    // área construida
  landAreaM2 = 0,   // opcional, para "Terreno"
  ageYears = 0,
  floorNumber = 1,
  hasElevator = false,
  bedrooms = 3,
  includeUSD = true
}) {
  if (!district) throw new Error('Debes indicar el distrito.');
  if (!coveredAreaM2 && propertyType !== 'Terreno') {
    throw new Error('Debes indicar el área construida (m²).');
  }
  const baseM2 = getZonePricePerM2(DATA, district, zone);

  // Multiplicadores
  const typeK = TYPE_FACTOR[propertyType] ?? 1.0;
  const ageK  = 1 + ageDepreciation(ageYears);
  const floorK = 1 + floorElevatorAdjustment(floorNumber, hasElevator);
  const bedK = 1 + bedroomAdjustment(bedrooms);

  // m² aplicable
  const areaM2 = propertyType === 'Terreno' ? (landAreaM2 || coveredAreaM2 || 0) : coveredAreaM2;

  // Precio m² ajustado
  const adjM2 = Math.max(800, Math.round(baseM2 * typeK * ageK * floorK * bedK));
  const subtotal = adjM2 * areaM2;

  // Rango dinámico según dispersión del distrito
  const districtStats = DISTRICT_STATS[district] || { min: baseM2, max: baseM2, avg: baseM2 };
  const tol = dynamicRangeTolerance(districtStats);
  const low = Math.round(subtotal * (1 - tol));
  const high = Math.round(subtotal * (1 + tol));

  return { 
    baseM2, 
    adjustedM2: adjM2, 
    areaM2, 
    rangeSoles: { min: low, max: high }, 
    tolPct: +(tol*100).toFixed(1),
    meta: { districtStats, factors: { typeK, ageK, floorK, bedK } }
  };
}

// -----------------------------
// 5) Inicialización (aplica rebasing por distrito y prepara stats)
// -----------------------------
const DATA_REBASED = applyDistrictLevelRebasing(DATA);
const DISTRICT_STATS = computeDistrictStats(DATA_REBASED);

// -----------------------------
// 6) Función pública para tasar (incluye conversión a USD en vivo)
// -----------------------------
export async function tasarInmueble(options) {
  const result = buildValuationRange({ DATA: DATA_REBASED, ...options });
  if (options?.includeUSD) {
    const usdPen = await fetchUsdPenRate();
    result.rateUsdPen = usdPen;
    result.rangeUSD = {
      min: +(result.rangeSoles.min / usdPen).toFixed(0),
      max: +(result.rangeSoles.max / usdPen).toFixed(0)
    };
  }
  return result;
}

// -----------------------------
// 7) Ejemplo de uso (quítalo o adáptalo a tu UI)
// -----------------------------
// (async () => {
//   const r = await tasarInmueble({
//     district: "Miraflores",
//     zone: "San Antonio",          // o deja undefined para usar promedio del distrito
//     propertyType: "Departamento",
//     coveredAreaM2: 80,
//     ageYears: 12,
//     floorNumber: 6,
//     hasElevator: true,
//     bedrooms: 3,
//     includeUSD: true
//   });
//   console.log("Resultado de tasación:", r);
// })();

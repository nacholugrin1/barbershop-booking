/* ============================================================================
   CÁLCULO DE HUECOS LIBRES — lógica pura, sin base de datos ni fechas.

   Todo acá adentro trabaja con "minutos desde la medianoche" (600 = 10:00).
   Eso es deliberado: las zonas horarias son el error #3 de la fórmula
   02_AUTOMATIZACION_DE_RESERVAS y la forma de no repetirlo es que la lógica
   de negocio no toque objetos Date. La conversión a instantes reales la hace
   PostgreSQL, una sola vez, en un solo lugar (ver reservas.js).

   Al ser funciones puras se pueden probar sin levantar nada: ver
   test/logica.test.js.
   ========================================================================== */

'use strict';

/** ¿Se pisan los intervalos [aIni, aFin) y [bIni, bFin)? */
function seSolapan(aIni, aFin, bIni, bFin) {
  return aIni < bFin && bIni < aFin;
}

/**
 * Une intervalos que se tocan o se pisan, para no recorrer 40 intervalos
 * cuando en realidad son 3 bloques.
 * @param {{desdeMin:number, hastaMin:number}[]} intervalos
 */
function fusionarIntervalos(intervalos) {
  if (!intervalos.length) return [];
  const orden = [...intervalos].sort((a, b) => a.desdeMin - b.desdeMin);
  const salida = [{ ...orden[0] }];
  for (let i = 1; i < orden.length; i++) {
    const ultimo = salida[salida.length - 1];
    const actual = orden[i];
    if (actual.desdeMin <= ultimo.hastaMin) {
      ultimo.hastaMin = Math.max(ultimo.hastaMin, actual.hastaMin);
    } else {
      salida.push({ ...actual });
    }
  }
  return salida;
}

/**
 * Devuelve los minutos de arranque en los que ENTRA un servicio completo.
 *
 * Un hueco solo cuenta si entra el servicio ENTERO antes del cierre. Ofrecer
 * las 19:45 para un color de 90 minutos cuando se cierra a las 20:00 es la
 * forma más rápida de que el dueño deje de confiar en el sistema.
 *
 * @param {object} opciones
 * @param {number} opciones.aperturaMin        apertura del barbero ese día
 * @param {number} opciones.cierreMin          cierre del barbero ese día
 * @param {number} opciones.duracionMin        duración del servicio pedido
 * @param {number} opciones.granularidadMin    cada cuánto se ofrece un arranque
 * @param {{desdeMin:number,hastaMin:number}[]} [opciones.ocupados] turnos y bloqueos
 * @param {number} [opciones.margenMin]        limpieza entre turnos
 * @param {number} [opciones.pisoMin]          no ofrecer nada antes de este minuto
 *                                             (hoy: ahora + anticipación mínima)
 * @returns {number[]} minutos de arranque disponibles, ordenados
 */
function huecosLibres({
  aperturaMin,
  cierreMin,
  duracionMin,
  granularidadMin,
  ocupados = [],
  margenMin = 0,
  pisoMin = -Infinity,
}) {
  if (!Number.isFinite(aperturaMin) || !Number.isFinite(cierreMin)) return [];
  if (!(duracionMin > 0) || !(granularidadMin > 0)) return [];
  if (cierreMin - aperturaMin < duracionMin) return [];

  // El margen de limpieza se aplica engordando cada ocupación hacia ambos
  // lados: es lo mismo que decir "no arranques pegado a otro turno".
  const bloques = fusionarIntervalos(
    ocupados
      .filter((o) => Number.isFinite(o.desdeMin) && Number.isFinite(o.hastaMin) && o.hastaMin > o.desdeMin)
      .map((o) => ({
        desdeMin: o.desdeMin - margenMin,
        hastaMin: o.hastaMin + margenMin,
      }))
  );

  const primerArranque = Math.max(aperturaMin, Math.ceil(pisoMin / granularidadMin) * granularidadMin);
  const salida = [];

  for (let t = alinear(primerArranque, aperturaMin, granularidadMin); t + duracionMin <= cierreMin; t += granularidadMin) {
    if (t < pisoMin) continue;
    const chocan = bloques.some((b) => seSolapan(t, t + duracionMin, b.desdeMin, b.hastaMin));
    if (!chocan) salida.push(t);
  }
  return salida;
}

/** Alinea `valor` a la grilla que arranca en `origen` cada `paso` minutos. */
function alinear(valor, origen, paso) {
  if (valor <= origen) return origen;
  const pasos = Math.ceil((valor - origen) / paso);
  return origen + pasos * paso;
}

/** 600 -> '10:00' */
function aHHMM(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** '10:00' -> 600. Devuelve null si no es una hora válida. */
function aMinutos(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

module.exports = {
  seSolapan,
  fusionarIntervalos,
  huecosLibres,
  alinear,
  aHHMM,
  aMinutos,
};

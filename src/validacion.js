/* ============================================================================
   VALIDACIÓN DEL LADO DEL SERVIDOR.

   Lección textual de la fórmula 02, paso 3: la validación del navegador es
   comodidad para el usuario; la del servidor es la que cuenta. Cualquiera
   abre la consola y manda lo que quiere. Nada de lo que llega de afuera se
   toca sin pasar por acá.

   Lógica pura: se prueba sin base de datos.
   ========================================================================== */

'use strict';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^\d{2}:\d{2}$/;
const RE_ID = /^[a-z0-9-]{2,40}$/;
// Deliberadamente permisivo: rechazar mails válidos raros molesta más de lo
// que ayuda. La confirmación real es que el mail llegue.
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function limpiar(v, maxLargo) {
  if (typeof v !== 'string') return '';
  // Los caracteres de control no aportan nada, y el byte nulo directamente
  // rompe una columna text de Postgres. Se cambian por espacio y se recorta.
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLargo);
}

/**
 * Valida el cuerpo de POST /api/reservas.
 * @returns {{ok:true, datos:object} | {ok:false, errores:string[]}}
 */
function validarReserva(cuerpo) {
  const errores = [];
  const c = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};

  const servicioId = limpiar(c.servicioId, 40);
  if (!RE_ID.test(servicioId)) errores.push('Elegí un servicio.');

  // '' o 'cualquiera' = que el sistema asigne el primero libre.
  const barberoId = limpiar(c.barberoId, 40);
  if (barberoId && barberoId !== 'cualquiera' && !RE_ID.test(barberoId)) {
    errores.push('El profesional elegido no es válido.');
  }

  const fecha = limpiar(c.fecha, 10);
  if (!RE_FECHA.test(fecha) || !esFechaReal(fecha)) errores.push('Elegí una fecha válida.');

  const hora = limpiar(c.hora, 5);
  if (!RE_HORA.test(hora)) errores.push('Elegí un horario válido.');

  const nombre = limpiar(c.nombre, 80);
  if (nombre.length < 2) errores.push('Poné tu nombre.');

  const email = limpiar(c.email, 120).toLowerCase();
  if (!RE_EMAIL.test(email)) errores.push('Poné un mail donde te llegue la confirmación.');

  // El teléfono se guarda como texto siempre. Error #4 de la fórmula 02:
  // guardarlo como número se come el cero de "011 4444-5555".
  const telefono = limpiar(c.telefono, 30);
  if (telefono.replace(/\D/g, '').length < 6) errores.push('Poné un teléfono de contacto.');

  const nota = limpiar(c.nota, 500);

  // Honeypot: campo invisible para personas, irresistible para bots.
  const trampa = typeof c.apellido2 === 'string' ? c.apellido2.trim() : '';

  if (errores.length) return { ok: false, errores };

  return {
    ok: true,
    datos: {
      servicioId,
      barberoId: barberoId && barberoId !== 'cualquiera' ? barberoId : null,
      fecha,
      hora,
      nombre,
      email,
      telefono,
      nota,
      esBot: trampa.length > 0,
    },
  };
}

/** Rechaza cosas como 2026-02-31, que matchean el regex pero no existen. */
function esFechaReal(fecha) {
  const [a, m, d] = fecha.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Date.UTC no depende de la zona del servidor: acá solo verificamos que
  // el día exista en el calendario, no en qué instante cae.
  const t = new Date(Date.UTC(a, m - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Escapa HTML antes de meter texto del cliente en un mail. */
function escaparHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { validarReserva, esFechaReal, limpiar, escaparHtml, RE_EMAIL };

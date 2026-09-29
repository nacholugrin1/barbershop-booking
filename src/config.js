/* ============================================================================
   CONFIGURACIÓN DEL NEGOCIO — TODO EN UN SOLO BLOQUE, ARRIBA DE TODO.

   Regla heredada de la fórmula 02_AUTOMATIZACION_DE_RESERVAS (paso 2):
   cambiar un horario, un precio o sumar un barbero NO tiene que obligar a
   leer código. Todo lo que un dueño querría cambiar vive acá.

   Los secretos (base de datos, SMTP, contraseña del panel) NO están acá:
   están en variables de entorno. Ver .env.example.
   ========================================================================== */

'use strict';

const ZONA = 'America/Argentina/Buenos_Aires';

/* --- Datos del negocio (aparecen en los mails) --- */
// Barbería Ramírez es un negocio FICTICIO: este sistema es un demo de
// portfolio. Para un cliente real, se reemplazan estos cinco datos y se
// saca MODO_DEMO de las variables de entorno.
const NEGOCIO = {
  nombre: 'Barbería Ramírez',
  direccion: 'Negocio ficticio (demo) — Villa Crespo, CABA',
  telefono: 'sin teléfono: es un demo',
  emailContacto: 'demo@example.com',
  sitio: 'https://aura-digitalstudio.github.io/aura-digital-studio/demos/barberia/',
  zona: ZONA,
};

/* --- Reglas de reserva --- */
const REGLAS = {
  // Cada cuántos minutos se ofrece un horario de arranque.
  // 15 = turnos a las 10:00, 10:15, 10:30... Bajarlo llena más el día
  // pero deja huecos raros; subirlo desperdicia sillón.
  granularidadMin: 15,

  // Con cuánta anticipación mínima se puede reservar (nadie reserva para
  // dentro de 5 minutos: el barbero no llega a mirar el celular).
  anticipacionMinimaMin: 90,

  // Cuántos días para adelante se puede reservar.
  anticipacionMaximaDias: 45,

  // Margen de limpieza entre turnos del mismo barbero (0 = pegados).
  margenEntreTurnosMin: 0,

  // Cuántas reservas activas puede tener el mismo mail al mismo tiempo.
  // Freno simple contra el que reserva 8 turnos "por las dudas".
  maxTurnosActivosPorEmail: 3,

  // Ventana en la que dos envíos idénticos se consideran doble clic.
  ventanaDobleClicSeg: 120,
};

/* --- Servicios. La duración es el dato que consume el motor de turnos. --- */
const SERVICIOS = [
  { id: 'corte-clasico', nombre: 'Corte clásico',        duracionMin: 30,  precioArs: 14000, orden: 1 },
  { id: 'fade',          nombre: 'Fade / degradé',       duracionMin: 45,  precioArs: 18000, orden: 2 },
  { id: 'barba',         nombre: 'Perfilado de barba',   duracionMin: 30,  precioArs: 11000, orden: 3 },
  { id: 'corte-barba',   nombre: 'Corte + barba',        duracionMin: 60,  precioArs: 24000, orden: 4 },
  { id: 'corte-nene',    nombre: 'Corte de nene',        duracionMin: 30,  precioArs: 10000, orden: 5 },
  { id: 'corte-brushing',nombre: 'Corte y brushing',     duracionMin: 45,  precioArs: 19000, orden: 6 },
  { id: 'color',         nombre: 'Color raíz',           duracionMin: 90,  precioArs: 38000, orden: 7 },
  { id: 'mechas',        nombre: 'Mechas / balayage',    duracionMin: 120, precioArs: 52000, orden: 8 },
];

/* --- Barberos (los "recursos"). En una peluquería el recurso es la persona,
       no el local: por eso el bloqueo atómico es por barbero. --- */
const BARBEROS = [
  {
    id: 'hugo',
    nombre: 'Hugo Ramírez',
    descripcion: 'Corte clásico, tijera y navaja.',
    orden: 1,
    servicios: ['corte-clasico', 'barba', 'corte-barba', 'corte-nene'],
    // dia: 0=domingo, 1=lunes ... 6=sábado. desde/hasta en formato 'HH:MM'.
    horarios: [
      { dia: 2, desde: '10:00', hasta: '20:00' },
      { dia: 3, desde: '10:00', hasta: '20:00' },
      { dia: 4, desde: '10:00', hasta: '20:00' },
      { dia: 5, desde: '10:00', hasta: '20:00' },
      { dia: 6, desde: '09:00', hasta: '18:00' },
    ],
  },
  {
    id: 'nico',
    nombre: 'Nico Ramírez',
    descripcion: 'Fades, diseños y barba.',
    orden: 2,
    servicios: ['corte-clasico', 'fade', 'barba', 'corte-barba', 'corte-nene'],
    horarios: [
      { dia: 3, desde: '10:00', hasta: '20:00' },
      { dia: 4, desde: '10:00', hasta: '20:00' },
      { dia: 5, desde: '10:00', hasta: '20:00' },
      { dia: 6, desde: '09:00', hasta: '18:00' },
    ],
  },
  {
    id: 'vale',
    nombre: 'Vale Quiroga',
    descripcion: 'Color, mechas y corte de mujer.',
    orden: 3,
    servicios: ['corte-brushing', 'color', 'mechas', 'corte-clasico'],
    horarios: [
      { dia: 2, desde: '10:00', hasta: '20:00' },
      { dia: 4, desde: '10:00', hasta: '20:00' },
      { dia: 5, desde: '10:00', hasta: '20:00' },
    ],
  },
];

/* --- Textos de los mails. Se editan acá, no adentro del código de envío. --- */
const MAILS = {
  asuntoConfirmacion: (n) => `Turno confirmado en ${n.nombre}`,
  asuntoCancelacion: (n) => `Turno cancelado en ${n.nombre}`,
  asuntoAvisoDueno: () => 'Nuevo turno reservado',
  pieDePagina:
    'Si no podés venir, cancelá o reprogramá desde el link de arriba. ' +
    'Avisar con tiempo nos deja el sillón libre para otra persona.',
};

/* --- Helpers derivados: nada que configurar acá abajo. --- */
function minutosDesde(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function servicioPorId(id) {
  return SERVICIOS.find((s) => s.id === id) || null;
}

function barberoPorId(id) {
  return BARBEROS.find((b) => b.id === id) || null;
}

module.exports = {
  ZONA,
  NEGOCIO,
  REGLAS,
  SERVICIOS,
  BARBEROS,
  MAILS,
  minutosDesde,
  servicioPorId,
  barberoPorId,
};

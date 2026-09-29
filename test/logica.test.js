/* ============================================================================
   PRUEBAS DE LÓGICA PURA — no tocan la base de datos ni la red.

   Es la traducción directa del paso 7 de la fórmula 02: "probar la lógica
   sin Google antes de tocar una cuenta real". Acá el equivalente es probar
   el cálculo de huecos y la validación antes de tocar un Postgres real.

   Corren con `npm run test:logica` y no necesitan NADA instalado: usan el
   runner de pruebas que viene con Node.
   ========================================================================== */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { huecosLibres, fusionarIntervalos, seSolapan, aHHMM, aMinutos } = require('../src/disponibilidad');
const { validarReserva, esFechaReal } = require('../src/validacion');

/* ========================================================================== */
test('seSolapan detecta el pisado y NO el borde exacto', () => {
  assert.equal(seSolapan(600, 630, 620, 650), true,  'se pisan');
  assert.equal(seSolapan(600, 630, 630, 660), false, 'pegados no es pisado: 10:30 termina donde arranca el otro');
  assert.equal(seSolapan(630, 660, 600, 630), false, 'lo mismo al revés');
  assert.equal(seSolapan(600, 700, 620, 640), true,  'uno contiene al otro');
});

test('fusionarIntervalos une los que se tocan y respeta los separados', () => {
  const r = fusionarIntervalos([
    { desdeMin: 600, hastaMin: 630 },
    { desdeMin: 630, hastaMin: 690 },
    { desdeMin: 800, hastaMin: 830 },
  ]);
  assert.deepEqual(r, [
    { desdeMin: 600, hastaMin: 690 },
    { desdeMin: 800, hastaMin: 830 },
  ]);
});

/* ========================================================================== */
test('CAMINO FELIZ: día vacío, corte de 30 min cada 15', () => {
  const r = huecosLibres({
    aperturaMin: 600,   // 10:00
    cierreMin: 690,     // 11:30
    duracionMin: 30,
    granularidadMin: 15,
  });
  assert.deepEqual(r.map(aHHMM), ['10:00', '10:15', '10:30', '10:45', '11:00']);
});

test('NO ofrece un horario donde el servicio no termina antes de cerrar', () => {
  // Color de 90 minutos, cierra 20:00. El último arranque posible es 18:30.
  const r = huecosLibres({
    aperturaMin: 1080,  // 18:00
    cierreMin: 1200,    // 20:00
    duracionMin: 90,
    granularidadMin: 15,
  });
  assert.deepEqual(r.map(aHHMM), ['18:00', '18:15', '18:30']);
  assert.equal(r.some((m) => m + 90 > 1200), false, 'ningún hueco se pasa del cierre');
});

test('CUPO TOMADO: un turno existente bloquea todos los arranques que lo pisan', () => {
  const r = huecosLibres({
    aperturaMin: 600,
    cierreMin: 720,     // 12:00
    duracionMin: 30,
    granularidadMin: 15,
    ocupados: [{ desdeMin: 630, hastaMin: 690 }], // 10:30 a 11:30 ocupado
  });
  assert.deepEqual(r.map(aHHMM), ['10:00', '11:30']);
});

test('El turno que termina justo cuando arranca otro SÍ se ofrece', () => {
  const r = huecosLibres({
    aperturaMin: 600, cierreMin: 720, duracionMin: 30, granularidadMin: 30,
    ocupados: [{ desdeMin: 630, hastaMin: 660 }],
  });
  assert.deepEqual(r.map(aHHMM), ['10:00', '11:00', '11:30']);
});

test('DÍA CERRADO: sin franja de trabajo no hay ningún hueco', () => {
  assert.deepEqual(huecosLibres({ aperturaMin: 600, cierreMin: 600, duracionMin: 30, granularidadMin: 15 }), []);
  assert.deepEqual(huecosLibres({ aperturaMin: 600, cierreMin: 620, duracionMin: 30, granularidadMin: 15 }), [],
    'la franja es más corta que el servicio');
});

test('El margen de limpieza corre los arranques a ambos lados del turno', () => {
  const r = huecosLibres({
    aperturaMin: 600, cierreMin: 720, duracionMin: 30, granularidadMin: 15,
    ocupados: [{ desdeMin: 660, hastaMin: 690 }],  // 11:00 a 11:30
    margenMin: 15,
  });
  // El turno ocupa 11:00-11:30. Con 15 min de margen el bloque real pasa a
  // ser 10:45-11:45, así que:
  //  - 10:15 (termina 10:45) sigue entrando, justo pegado al margen.
  //  - 10:30 (termina 11:00) ya pisa el margen y se descarta.
  //  - Después del turno no entra nada: el primer arranque libre sería 11:45,
  //    y ahí ya no llegan los 30 minutos antes de cerrar a las 12:00.
  assert.deepEqual(r.map(aHHMM), ['10:00', '10:15']);
});

test('PISO DE ANTICIPACIÓN: hoy no se ofrece nada antes de ahora + margen', () => {
  const r = huecosLibres({
    aperturaMin: 600, cierreMin: 720, duracionMin: 30, granularidadMin: 15,
    pisoMin: 645, // son las 10:15 y el mínimo son 30 min -> desde 10:45
  });
  assert.deepEqual(r.map(aHHMM), ['10:45', '11:00', '11:15', '11:30']);
});

test('Los huecos respetan la grilla que arranca en la apertura, no en la hora en punto', () => {
  // Abre 9:00 (sábado). Con granularidad 45 la grilla es 9:00, 9:45, 10:30...
  const r = huecosLibres({ aperturaMin: 540, cierreMin: 700, duracionMin: 45, granularidadMin: 45 });
  assert.deepEqual(r.map(aHHMM), ['09:00', '09:45', '10:30']);
});

test('Entradas basura no rompen: devuelven lista vacía', () => {
  assert.deepEqual(huecosLibres({ aperturaMin: NaN, cierreMin: 720, duracionMin: 30, granularidadMin: 15 }), []);
  assert.deepEqual(huecosLibres({ aperturaMin: 600, cierreMin: 720, duracionMin: 0, granularidadMin: 15 }), []);
  assert.deepEqual(huecosLibres({ aperturaMin: 600, cierreMin: 720, duracionMin: 30, granularidadMin: 0 }), []);
});

test('Ocupaciones mal formadas se ignoran en vez de romper el cálculo', () => {
  const r = huecosLibres({
    aperturaMin: 600, cierreMin: 690, duracionMin: 30, granularidadMin: 30,
    ocupados: [{ desdeMin: 660, hastaMin: 600 }, { desdeMin: null, hastaMin: 700 }],
  });
  // Las dos ocupaciones son basura (una termina antes de empezar, la otra no
  // tiene inicio): se descartan y el día queda como si estuviera vacío.
  assert.deepEqual(r.map(aHHMM), ['10:00', '10:30', '11:00']);
});

/* ========================================================================== */
test('aHHMM y aMinutos son inversas y rechazan basura', () => {
  assert.equal(aHHMM(0), '00:00');
  assert.equal(aHHMM(605), '10:05');
  assert.equal(aMinutos('10:05'), 605);
  assert.equal(aMinutos('9:30'), 570);
  assert.equal(aMinutos('25:00'), null);
  assert.equal(aMinutos('10:70'), null);
  assert.equal(aMinutos('mediodía'), null);
});

/* ========================================================================== */
test('esFechaReal rechaza fechas que existen en el regex pero no en el calendario', () => {
  assert.equal(esFechaReal('2026-08-06'), true);
  assert.equal(esFechaReal('2026-02-31'), false);
  assert.equal(esFechaReal('2026-13-01'), false);
  assert.equal(esFechaReal('2024-02-29'), true, 'bisiesto');
  assert.equal(esFechaReal('2026-02-29'), false, 'no bisiesto');
});

test('VALIDACIÓN: una reserva bien formada pasa y queda normalizada', () => {
  const r = validarReserva({
    servicioId: 'corte-barba',
    barberoId: 'nico',
    fecha: '2026-08-06',
    hora: '10:30',
    nombre: '  Diego Pérez  ',
    email: '  Diego@Ejemplo.COM ',
    telefono: '011 4444-5555',
    nota: 'Vengo con mi hijo',
  });
  assert.equal(r.ok, true);
  assert.equal(r.datos.nombre, 'Diego Pérez', 'recorta espacios');
  assert.equal(r.datos.email, 'diego@ejemplo.com', 'normaliza el mail a minúsculas');
  assert.equal(r.datos.telefono, '011 4444-5555', 'el teléfono queda como TEXTO, con su cero adelante');
  assert.equal(r.datos.esBot, false);
});

test('VALIDACIÓN: datos inválidos se rechazan con mensajes, no con una excepción', () => {
  const r = validarReserva({ servicioId: '', fecha: 'mañana', hora: '99:99', nombre: 'A', email: 'no-es-mail', telefono: '1' });
  assert.equal(r.ok, false);
  assert.ok(r.errores.length >= 5, 'junta todos los errores, no corta en el primero');
});

test('VALIDACIÓN: "cualquiera" se traduce a null (que asigne el servidor)', () => {
  const r = validarReserva({
    servicioId: 'fade', barberoId: 'cualquiera', fecha: '2026-08-06', hora: '10:00',
    nombre: 'Ana', email: 'a@b.com', telefono: '1144445555',
  });
  assert.equal(r.ok, true);
  assert.equal(r.datos.barberoId, null);
});

test('VALIDACIÓN: el honeypot marca al bot sin rechazar el pedido', () => {
  const r = validarReserva({
    servicioId: 'fade', fecha: '2026-08-06', hora: '10:00',
    nombre: 'Bot', email: 'bot@spam.com', telefono: '1144445555',
    apellido2: 'me llenaron el campo invisible',
  });
  assert.equal(r.ok, true);
  assert.equal(r.datos.esBot, true);
});

test('VALIDACIÓN: HTML en un campo se guarda como texto, no se ejecuta ni rompe', () => {
  const r = validarReserva({
    servicioId: 'fade', fecha: '2026-08-06', hora: '10:00',
    nombre: '<script>alert(1)</script>', email: 'a@b.com', telefono: '1144445555',
    nota: '<img src=x onerror=alert(1)>',
  });
  assert.equal(r.ok, true);
  assert.equal(r.datos.nombre, '<script>alert(1)</script>', 'se conserva tal cual: el escapado es al mostrarlo');
});

test('VALIDACIÓN: los campos largos se recortan en vez de reventar la columna', () => {
  const r = validarReserva({
    servicioId: 'fade', fecha: '2026-08-06', hora: '10:00',
    nombre: 'x'.repeat(500), email: 'a@b.com', telefono: '1144445555', nota: 'y'.repeat(5000),
  });
  assert.equal(r.ok, true);
  assert.equal(r.datos.nombre.length, 80);
  assert.equal(r.datos.nota.length, 500);
});

test('VALIDACIÓN: caracteres de control se limpian antes de guardar', () => {
  const r = validarReserva({
    servicioId: 'fade', fecha: '2026-08-06', hora: '10:00',
    nombre: 'Ana\u0000Mar\u001fia', email: 'a@b.com', telefono: '1144445555',
  });
  assert.equal(r.ok, true);
  assert.equal(/[\u0000-\u001f\u007f]/.test(r.datos.nombre), false, 'no queda ningun caracter de control');
  assert.equal(r.datos.nombre, 'Ana Mar ia');
});

test('VALIDACIÓN: no explota si le mandan cualquier cosa en vez de un objeto', () => {
  for (const basura of [null, undefined, 'texto', 42, []]) {
    const r = validarReserva(basura);
    assert.equal(r.ok, false, 'devuelve error, no tira excepción');
  }
});

/* ============================================================================
   PRUEBAS DE INTEGRACIÓN — necesitan un PostgreSQL de verdad.

   Estas son las que no se pueden simular: la defensa contra la doble reserva
   vive DENTRO del motor de base de datos, así que probarla con objetos
   falsos no probaría nada.

   Cómo correrlas:
     1. Creá una base APARTE de la de producción (en Neon, "Branch" o un
        proyecto nuevo — es gratis y tarda 10 segundos).
     2. DATABASE_URL=<esa base> npm run migrar
     3. DATABASE_URL=<esa base> npm run sembrar
     4. DATABASE_URL=<esa base> PERMITIR_PRUEBAS=1 npm run test:integracion

   Sin PERMITIR_PRUEBAS=1 no hacen nada. Es a propósito: estas pruebas
   escriben y borran filas, y "correr el test contra la base del cliente" es
   exactamente la clase de accidente que arruina una relación comercial.

   Todo lo que crean usa mails @prueba.local y se limpia al final.
   ========================================================================== */

'use strict';

require('../src/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const habilitado = Boolean(process.env.DATABASE_URL) && process.env.PERMITIR_PRUEBAS === '1';

if (!habilitado) {
  test('pruebas de integración salteadas', { skip: 'Falta DATABASE_URL y/o PERMITIR_PRUEBAS=1' }, () => {});
} else {
  const { consultar, cerrar } = require('../src/db');
  const reservas = require('../src/reservas');
  const { ZONA } = require('../src/config');

  const MAIL = 'prueba@prueba.local';
  let DIA_HABIL; // fecha futura en la que trabajan Hugo y Nico
  let DOMINGO;   // fecha futura en la que está todo cerrado

  async function limpiar() {
    await consultar(`DELETE FROM turnos   WHERE cliente_email LIKE '%@prueba.local'`);
    await consultar(`DELETE FROM bloqueos WHERE motivo = 'PRUEBA'`);
  }

  test.before(async () => {
    // Un miércoles (3) dentro de los próximos 14 días, y un domingo (0).
    // Se calcula en la base, no en JS, por la misma razón de siempre: acá
    // el calendario correcto lo tiene Postgres.
    const r = await consultar(
      `SELECT
         (SELECT to_char(d, 'YYYY-MM-DD')
            FROM generate_series((now() AT TIME ZONE $1)::date + 2,
                                 (now() AT TIME ZONE $1)::date + 16, '1 day') d
           WHERE EXTRACT(DOW FROM d) = 3 LIMIT 1) AS habil,
         (SELECT to_char(d, 'YYYY-MM-DD')
            FROM generate_series((now() AT TIME ZONE $1)::date + 2,
                                 (now() AT TIME ZONE $1)::date + 16, '1 day') d
           WHERE EXTRACT(DOW FROM d) = 0 LIMIT 1) AS domingo`,
      [ZONA]
    );
    DIA_HABIL = r.rows[0].habil;
    DOMINGO = r.rows[0].domingo;
    assert.ok(DIA_HABIL && DOMINGO, 'no se pudo calcular las fechas de prueba');
    await limpiar();
  });

  test.after(async () => {
    await limpiar();
    await cerrar();
  });

  const base = (extra) => Object.assign({
    servicioId: 'corte-clasico',
    barberoId: 'hugo',
    fecha: DIA_HABIL,
    hora: '11:00',
    nombre: 'Cliente Prueba',
    email: MAIL,
    telefono: '011 4444-5555',
    nota: '',
  }, extra);

  /* ---------------------------------------------------------------------- */
  test('la migración dejó la constraint anti-doble-reserva', async () => {
    const r = await consultar(`SELECT contype FROM pg_constraint WHERE conname = 'turnos_sin_solape'`);
    assert.equal(r.rows.length, 1, 'no existe turnos_sin_solape');
    assert.equal(r.rows[0].contype, 'x', 'existe pero no es una EXCLUDE constraint');
  });

  test('el catálogo trae servicios, barberos y quién hace qué', async () => {
    const c = await reservas.listarCatalogo();
    assert.ok(c.servicios.length >= 5);
    assert.ok(c.barberos.length >= 3);
    const corte = c.servicios.find((s) => s.id === 'corte-clasico');
    assert.ok(corte.barberos.includes('hugo'), 'Hugo tiene que hacer corte clásico');
    const color = c.servicios.find((s) => s.id === 'color');
    assert.equal(color.barberos.includes('nico'), false, 'Nico no hace color');
  });

  /* ---------------------------------------------------------------------- */
  test('CAMINO FELIZ: se crea el turno y devuelve token de gestión', async () => {
    await limpiar();
    const r = await reservas.crearTurno(base());
    assert.equal(r.yaExistia, false);
    assert.equal(r.barberoId, 'hugo');
    assert.equal(r.hora, '11:00');
    assert.ok(r.token && r.token.length > 20, 'el token tiene que ser largo e impredecible');

    const t = await reservas.traerPorToken(r.token);
    assert.equal(t.estado, 'confirmado');
    assert.equal(t.fecha, DIA_HABIL);
  });

  test('el hueco reservado desaparece de la disponibilidad', async () => {
    const d = await reservas.disponibilidadDelDia({ fecha: DIA_HABIL, servicioId: 'corte-clasico', barberoId: 'hugo' });
    const horas = d.huecos.map((h) => h.hora);
    assert.equal(horas.includes('11:00'), false, '11:00 sigue ofreciéndose y ya está tomado');
    assert.equal(horas.includes('10:45'), false, 'tampoco 10:45: pisaría el turno de 30 min');
    assert.equal(horas.includes('11:30'), true, '11:30 tiene que seguir libre');
  });

  test('el mismo horario SÍ sigue libre para otro barbero', async () => {
    const d = await reservas.disponibilidadDelDia({ fecha: DIA_HABIL, servicioId: 'corte-clasico', barberoId: 'nico' });
    assert.equal(d.huecos.some((h) => h.hora === '11:00'), true,
      'el recurso es la persona: que Hugo esté ocupado no ocupa a Nico');
  });

  /* ======================================================================= */
  /*  LA PRUEBA QUE JUSTIFICA TODO EL DISEÑO                                 */
  /* ======================================================================= */
  test('DOBLE RESERVA SIMULTÁNEA: dos personas al mismo hueco, gana una sola', async () => {
    await limpiar();

    const uno = reservas.crearTurno(base({ hora: '15:00', email: 'uno@prueba.local' }));
    const dos = reservas.crearTurno(base({ hora: '15:00', email: 'dos@prueba.local' }));

    const [ra, rb] = await Promise.allSettled([uno, dos]);
    const ok = [ra, rb].filter((r) => r.status === 'fulfilled');
    const fallo = [ra, rb].filter((r) => r.status === 'rejected');

    assert.equal(ok.length, 1, 'tiene que ganar exactamente uno');
    assert.equal(fallo.length, 1, 'el otro tiene que ser rechazado');
    assert.equal(fallo[0].reason.codigo, 'sin_lugar',
      'el rechazo tiene que ser un error de negocio con mensaje claro, no un 500');

    const guardados = await consultar(
      `SELECT count(*)::int AS n FROM turnos
        WHERE barbero_id = 'hugo' AND estado <> 'cancelado'
          AND lower(franja) = (($1::date + '15:00'::time) AT TIME ZONE $2)`,
      [DIA_HABIL, ZONA]
    );
    assert.equal(guardados.rows[0].n, 1, 'en la base tiene que haber UN solo turno en ese hueco');
  });

  test('la constraint rechaza el solape aunque se escriba SQL a mano', async () => {
    await limpiar();
    await reservas.crearTurno(base({ hora: '16:00' }));

    // Un turno de 30 min a las 16:15 se pisa con el de las 16:00.
    // Esto saltea todo el código de la aplicación: va directo a la tabla.
    await assert.rejects(
      consultar(
        `INSERT INTO turnos (barbero_id, servicio_id, franja, cliente_nombre, cliente_email, cliente_tel, token_gestion)
         VALUES ('hugo', 'corte-clasico',
                 tstzrange((($1::date + '16:15'::time) AT TIME ZONE $2),
                           (($1::date + '16:45'::time) AT TIME ZONE $2), '[)'),
                 'A Mano', 'mano@prueba.local', '1111111111', 'token-de-prueba-a-mano')`,
        [DIA_HABIL, ZONA]
      ),
      (err) => err.code === '23P01',
      'la base tiene que rechazar el solape con exclusion_violation (23P01)'
    );
  });

  /* ---------------------------------------------------------------------- */
  test('DOBLE CLIC: el mismo envío dos veces devuelve el mismo turno, no dos', async () => {
    await limpiar();
    const a = await reservas.crearTurno(base({ hora: '17:00' }));
    const b = await reservas.crearTurno(base({ hora: '17:00' }));
    assert.equal(b.yaExistia, true, 'el segundo tiene que reconocerse como repetido');
    assert.equal(b.token, a.token, 'y devolver el mismo turno');

    const n = await consultar(
      `SELECT count(*)::int AS n FROM turnos WHERE cliente_email = $1 AND estado <> 'cancelado'`,
      [MAIL]
    );
    assert.equal(n.rows[0].n, 1);
  });

  /* ---------------------------------------------------------------------- */
  test('DÍA CERRADO: un domingo no tiene ningún hueco y la reserva se rechaza', async () => {
    const d = await reservas.disponibilidadDelDia({ fecha: DOMINGO, servicioId: 'corte-clasico' });
    assert.equal(d.huecos.length, 0);

    await assert.rejects(
      reservas.crearTurno(base({ fecha: DOMINGO, hora: '11:00', email: 'dom@prueba.local' })),
      (err) => err.codigo === 'fuera_de_horario' || err.codigo === 'sin_lugar'
    );
  });

  test('FUERA DE HORARIO: las 3 de la mañana se rechaza aunque nadie la ocupe', async () => {
    await assert.rejects(
      reservas.crearTurno(base({ hora: '03:00', email: 'noct@prueba.local' })),
      (err) => err.codigo === 'fuera_de_horario' || err.codigo === 'sin_lugar'
    );
  });

  test('ANTICIPACIÓN MÍNIMA: no se puede reservar para dentro de un rato', async () => {
    const r = await consultar(
      `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS hoy,
              to_char((now() AT TIME ZONE $1) + interval '10 minutes', 'HH24:MI') AS pronto`,
      [ZONA]
    );
    await assert.rejects(
      reservas.crearTurno(base({ fecha: r.rows[0].hoy, hora: r.rows[0].pronto, email: 'ya@prueba.local' })),
      (err) => ['muy_pronto', 'fuera_de_horario', 'sin_lugar', 'fecha_pasada'].includes(err.codigo)
    );
  });

  test('FECHA PASADA: pedir disponibilidad de ayer se rechaza', async () => {
    const r = await consultar(
      `SELECT to_char((now() AT TIME ZONE $1)::date - 1, 'YYYY-MM-DD') AS ayer`, [ZONA]
    );
    await assert.rejects(
      reservas.disponibilidadDelDia({ fecha: r.rows[0].ayer, servicioId: 'corte-clasico' }),
      (err) => err.codigo === 'fecha_pasada'
    );
  });

  test('SERVICIO INEXISTENTE: se rechaza con mensaje, no con un 500', async () => {
    await assert.rejects(
      reservas.crearTurno(base({ servicioId: 'corte-de-pelo-a-un-dragon', email: 'x@prueba.local' })),
      (err) => err.codigo === 'servicio_invalido'
    );
  });

  /* ---------------------------------------------------------------------- */
  test('CANCELAR libera el hueco y no se puede cancelar dos veces', async () => {
    await limpiar();
    const r = await reservas.crearTurno(base({ hora: '18:00' }));

    let d = await reservas.disponibilidadDelDia({ fecha: DIA_HABIL, servicioId: 'corte-clasico', barberoId: 'hugo' });
    assert.equal(d.huecos.some((h) => h.hora === '18:00'), false);

    await reservas.cancelarConToken(r.token);

    d = await reservas.disponibilidadDelDia({ fecha: DIA_HABIL, servicioId: 'corte-clasico', barberoId: 'hugo' });
    assert.equal(d.huecos.some((h) => h.hora === '18:00'), true, 'cancelar tiene que devolver el hueco al público');

    await assert.rejects(reservas.cancelarConToken(r.token), (err) => err.codigo === 'no_cancelable');
  });

  test('un token inventado no encuentra ni cancela nada', async () => {
    assert.equal(await reservas.traerPorToken('esto-no-existe-en-ningun-lado'), null);
    await assert.rejects(reservas.cancelarConToken('esto-no-existe-en-ningun-lado'));
  });

  /* ---------------------------------------------------------------------- */
  test('BLOQUEO: cerrar un rato de la agenda saca esos huecos del público', async () => {
    await limpiar();
    let d = await reservas.disponibilidadDelDia({ fecha: DIA_HABIL, servicioId: 'corte-clasico', barberoId: 'hugo' });
    assert.equal(d.huecos.some((h) => h.hora === '12:00'), true, 'antes del bloqueo, 12:00 estaba libre');

    await consultar(
      `INSERT INTO bloqueos (barbero_id, franja, motivo)
       VALUES ('hugo', tstzrange((($1::date + '12:00'::time) AT TIME ZONE $2),
                                 (($1::date + '13:00'::time) AT TIME ZONE $2), '[)'), 'PRUEBA')`,
      [DIA_HABIL, ZONA]
    );

    d = await reservas.disponibilidadDelDia({ fecha: DIA_HABIL, servicioId: 'corte-clasico', barberoId: 'hugo' });
    assert.equal(d.huecos.some((h) => h.hora === '12:00'), false, 'el bloqueo tiene que ocultar el hueco');
    assert.equal(d.huecos.some((h) => h.hora === '12:30'), false, 'y también los que lo pisan');
  });

  test('BLOQUEO GENERAL (barbero NULL) cierra todo el local', async () => {
    await limpiar();
    await consultar(
      `INSERT INTO bloqueos (barbero_id, franja, motivo)
       VALUES (NULL, tstzrange((($1::date + '00:00'::time) AT TIME ZONE $2),
                               (($1::date + '23:59'::time) AT TIME ZONE $2), '[)'), 'PRUEBA')`,
      [DIA_HABIL, ZONA]
    );
    const d = await reservas.disponibilidadDelDia({ fecha: DIA_HABIL, servicioId: 'corte-clasico' });
    assert.equal(d.huecos.length, 0, 'con el local cerrado no queda ningún hueco para nadie');
  });

  /* ---------------------------------------------------------------------- */
  test('ASIGNACIÓN AUTOMÁTICA: sin barbero elegido, el servidor elige uno libre', async () => {
    await limpiar();
    const r = await reservas.crearTurno(base({ barberoId: null, hora: '14:00', email: 'auto@prueba.local' }));
    assert.ok(['hugo', 'nico'].includes(r.barberoId), 'tiene que asignar a alguien que haga el servicio');
  });

  test('TOPE POR MAIL: no se puede acaparar la agenda con el mismo mail', async () => {
    await limpiar();
    const { REGLAS } = require('../src/config');
    const horas = ['10:00', '10:30', '11:00', '11:30', '12:00'];
    let creados = 0;
    let rechazo = null;
    for (const hora of horas) {
      try {
        await reservas.crearTurno(base({ hora, barberoId: null }));
        creados += 1;
      } catch (err) {
        rechazo = err;
        break;
      }
    }
    assert.equal(creados, REGLAS.maxTurnosActivosPorEmail);
    assert.equal(rechazo && rechazo.codigo, 'demasiados_turnos');
  });

  test('el color de 90 min no se ofrece cuando ya no entra antes de cerrar', async () => {
    await limpiar();
    const d = await reservas.disponibilidadDelDia({ fecha: DIA_HABIL, servicioId: 'color', barberoId: 'vale' });
    // Vale no trabaja los miércoles: no debería haber nada.
    assert.equal(d.huecos.length, 0, 'Vale no atiende ese día');

    const r = await consultar(
      `SELECT to_char(d, 'YYYY-MM-DD') AS f
         FROM generate_series((now() AT TIME ZONE $1)::date + 2,
                              (now() AT TIME ZONE $1)::date + 16, '1 day') d
        WHERE EXTRACT(DOW FROM d) = 2 LIMIT 1`,
      [ZONA]
    );
    const martes = r.rows[0].f;
    const d2 = await reservas.disponibilidadDelDia({ fecha: martes, servicioId: 'color', barberoId: 'vale' });
    assert.ok(d2.huecos.length > 0, 'los martes Vale sí atiende');
    const ultimo = d2.huecos[d2.huecos.length - 1].hora;
    assert.equal(ultimo, '18:30', 'el último color de 90 min tiene que arrancar 18:30 para cerrar a las 20:00');
  });
}

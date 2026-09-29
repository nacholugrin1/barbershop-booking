/* ============================================================================
   PANEL DEL DUEÑO — consultas de administración.
   Todo lo de acá pasa por `exigirSesion`. Nada es público.
   ========================================================================== */

'use strict';

const { consultar } = require('./db');
const { ZONA } = require('./config');
const { ErrorDeNegocio } = require('./reservas');

/** Turnos de un día (por defecto hoy en hora de Buenos Aires). */
async function turnosDelDia(fecha = null) {
  // Primero se resuelve qué día es "hoy" en Buenos Aires. Se hace aparte para
  // que la consulta principal no dependa de un CTE mezclado con los JOIN
  // (mezclar `FROM t, cte JOIN ...` es un error de referencia en Postgres).
  const dia = await consultar(
    `SELECT to_char(COALESCE($1::date, (now() AT TIME ZONE $2)::date), 'YYYY-MM-DD') AS d`,
    [fecha, ZONA]
  );
  const fechaResuelta = dia.rows[0].d;

  const r = await consultar(
    `SELECT t.id, t.estado, t.cliente_nombre, t.cliente_tel, t.cliente_email, t.nota,
            s.nombre AS servicio, s.duracion_min, s.precio_ars,
            b.id AS barbero_id, b.nombre AS barbero,
            to_char(lower(t.franja) AT TIME ZONE $2, 'HH24:MI') AS hora,
            to_char(upper(t.franja) AT TIME ZONE $2, 'HH24:MI') AS hora_fin
       FROM turnos t
       JOIN servicios s ON s.id = t.servicio_id
       JOIN barberos  b ON b.id = t.barbero_id
      WHERE (lower(t.franja) AT TIME ZONE $2)::date = $1::date
      ORDER BY lower(t.franja), b.orden`,
    [fechaResuelta, ZONA]
  );

  const turnos = r.rows.map((t) => Object.assign({ fecha: fechaResuelta }, t));
  const activos = turnos.filter((t) => t.estado !== 'cancelado');
  return {
    fecha: fechaResuelta,
    turnos,
    resumen: {
      total: activos.length,
      cancelados: turnos.length - activos.length,
      noVinieron: turnos.filter((t) => t.estado === 'no_vino').length,
      minutosOcupados: activos.reduce((a, t) => a + t.duracion_min, 0),
      facturacionEstimada: activos
        .filter((t) => t.estado !== 'no_vino')
        .reduce((a, t) => a + t.precio_ars, 0),
    },
  };
}

/** Cambia el estado de un turno. Es la única forma de tocar `estado`. */
async function cambiarEstado(turnoId, nuevoEstado, actor) {
  const permitidos = ['confirmado', 'atendido', 'no_vino', 'cancelado'];
  if (!permitidos.includes(nuevoEstado)) {
    throw new ErrorDeNegocio('Estado no válido.', 'estado_invalido');
  }

  const r = await consultar(
    `UPDATE turnos
        SET estado = $2::estado_turno, actualizado_en = now()
      WHERE id = $1
      RETURNING id, estado, cliente_email, cliente_nombre,
                (SELECT nombre FROM servicios WHERE id = servicio_id) AS servicio,
                to_char(lower(franja) AT TIME ZONE $3, 'YYYY-MM-DD') AS fecha,
                to_char(lower(franja) AT TIME ZONE $3, 'HH24:MI')    AS hora`,
    [turnoId, nuevoEstado, ZONA]
  );
  if (!r.rows.length) throw new ErrorDeNegocio('Ese turno no existe.', 'no_encontrado', 404);

  await consultar(
    `INSERT INTO auditoria (actor, accion, turno_id, detalle) VALUES ($1, $2, $3, $4)`,
    [actor, `estado:${nuevoEstado}`, turnoId, '']
  );
  return r.rows[0];
}

/** Cierra un rato de la agenda: vacaciones, feriado, "me voy al médico". */
async function crearBloqueo({ barberoId, fecha, desde, hasta, motivo }, actor) {
  const r = await consultar(
    `INSERT INTO bloqueos (barbero_id, franja, motivo)
     VALUES (
       $1,
       tstzrange(
         (($2::date + $3::time) AT TIME ZONE $6),
         (($2::date + $4::time) AT TIME ZONE $6),
         '[)'
       ),
       $5
     )
     RETURNING id`,
    [barberoId || null, fecha, desde, hasta, motivo || '', ZONA]
  );
  await consultar(
    `INSERT INTO auditoria (actor, accion, detalle) VALUES ($1, 'crear_bloqueo', $2)`,
    [actor, `${barberoId || 'todo el local'} ${fecha} ${desde}-${hasta} ${motivo || ''}`]
  );
  return r.rows[0].id;
}

/** Números de la última quincena: es lo que le sirve al dueño, no un dashboard. */
async function resumenQuincena() {
  const r = await consultar(
    `SELECT
       count(*) FILTER (WHERE estado <> 'cancelado')                  AS turnos,
       count(*) FILTER (WHERE estado = 'no_vino')                     AS no_vinieron,
       count(*) FILTER (WHERE estado = 'cancelado')                   AS cancelados,
       COALESCE(sum(s.precio_ars) FILTER (WHERE estado = 'atendido'), 0) AS facturado
     FROM turnos t
     JOIN servicios s ON s.id = t.servicio_id
     WHERE lower(t.franja) > now() - interval '15 days'
       AND lower(t.franja) < now()`
  );
  const f = r.rows[0];
  const turnos = Number(f.turnos);
  return {
    turnos,
    noVinieron: Number(f.no_vinieron),
    cancelados: Number(f.cancelados),
    facturado: Number(f.facturado),
    // El número que de verdad le importa al dueño y es el argumento de venta
    // del sistema: cuánto sillón se está desperdiciando.
    tasaAusentismo: turnos ? Math.round((Number(f.no_vinieron) / turnos) * 1000) / 10 : 0,
  };
}

module.exports = { turnosDelDia, cambiarEstado, crearBloqueo, resumenQuincena };

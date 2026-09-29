/* ============================================================================
   RESERVAS — lectura de disponibilidad y creación de turnos.

   Es el único archivo donde se convierte "fecha + hora local" en un instante
   real. Toda la conversión la hace PostgreSQL con
   `(fecha::date + hora::time) AT TIME ZONE 'America/Argentina/Buenos_Aires'`.

   Por qué así, y no con `new Date('2026-08-05T10:00')` en JavaScript:
   error conocido #3 de la fórmula 02. JS interpreta esas cadenas según reglas
   que cambian entre formatos y entre entornos, y en Argentina (UTC-3) una
   fecha suelta se convierte en el día anterior a las 21:00. Postgres, en
   cambio, conoce la base de datos de zonas horarias completa, incluidos los
   cambios históricos de horario de verano. Delegarle eso no es pereza: es
   usar la herramienta que tiene el dato correcto.
   ========================================================================== */

'use strict';

const crypto = require('node:crypto');
const { consultar, enTransaccion } = require('./db');
const { REGLAS, ZONA } = require('./config');
const { huecosLibres, aHHMM, aMinutos } = require('./disponibilidad');

/* --- Errores de negocio: se distinguen de los bugs para poder devolver un
       mensaje claro al cliente en vez de un 500 genérico. --- */
class ErrorDeNegocio extends Error {
  constructor(mensaje, codigo = 'invalido', http = 400) {
    super(mensaje);
    this.codigo = codigo;
    this.http = http;
  }
}

/* ========================================================================== */
/*  Catálogo                                                                  */
/* ========================================================================== */

async function listarCatalogo() {
  const [servicios, barberos, relacion] = await Promise.all([
    consultar('SELECT id, nombre, duracion_min, precio_ars FROM servicios WHERE activo ORDER BY orden, nombre'),
    consultar('SELECT id, nombre, descripcion FROM barberos WHERE activo ORDER BY orden, nombre'),
    consultar(`SELECT bs.barbero_id, bs.servicio_id
                 FROM barbero_servicio bs
                 JOIN barberos b  ON b.id = bs.barbero_id  AND b.activo
                 JOIN servicios s ON s.id = bs.servicio_id AND s.activo`),
  ]);

  const porServicio = new Map();
  for (const fila of relacion.rows) {
    if (!porServicio.has(fila.servicio_id)) porServicio.set(fila.servicio_id, []);
    porServicio.get(fila.servicio_id).push(fila.barbero_id);
  }

  return {
    servicios: servicios.rows.map((s) => ({
      id: s.id,
      nombre: s.nombre,
      duracionMin: s.duracion_min,
      precioArs: s.precio_ars,
      barberos: porServicio.get(s.id) || [],
    })),
    barberos: barberos.rows.map((b) => ({ id: b.id, nombre: b.nombre, descripcion: b.descripcion })),
    reglas: {
      anticipacionMaximaDias: REGLAS.anticipacionMaximaDias,
      anticipacionMinimaMin: REGLAS.anticipacionMinimaMin,
    },
  };
}

/* ========================================================================== */
/*  Disponibilidad                                                            */
/* ========================================================================== */

/**
 * Huecos libres de un día, para un servicio, opcionalmente filtrado por barbero.
 * @returns {Promise<{fecha:string, huecos:{hora:string, barberos:string[]}[]}>}
 */
async function disponibilidadDelDia({ fecha, servicioId, barberoId = null }) {
  const servicio = await traerServicio(servicioId);

  // Todo lo que depende del calendario lo resuelve Postgres de una sola vez:
  // qué día de la semana es esa fecha en Buenos Aires, y cuántos minutos
  // faltan (o pasaron) desde ahora hasta la medianoche de ese día.
  const marco = await consultar(
    `SELECT
       EXTRACT(DOW FROM $1::date)::int                                AS dia_semana,
       ($1::date < (now() AT TIME ZONE $2)::date)                     AS es_pasado,
       ($1::date = (now() AT TIME ZONE $2)::date)                     AS es_hoy,
       ($1::date > ((now() AT TIME ZONE $2)::date + ($3 || ' days')::interval)) AS muy_lejos,
       EXTRACT(EPOCH FROM ((now() AT TIME ZONE $2)::time)) / 60       AS minuto_actual`,
    [fecha, ZONA, String(REGLAS.anticipacionMaximaDias)]
  );
  const m = marco.rows[0];

  if (m.es_pasado) throw new ErrorDeNegocio('Esa fecha ya pasó.', 'fecha_pasada');
  if (m.muy_lejos) {
    throw new ErrorDeNegocio(
      `Todavía no abrimos la agenda tan adelante. Se puede reservar hasta ${REGLAS.anticipacionMaximaDias} días.`,
      'fecha_lejana'
    );
  }

  // Piso: si es hoy, no ofrecer nada antes de "ahora + anticipación mínima".
  const pisoMin = m.es_hoy
    ? Math.floor(Number(m.minuto_actual)) + REGLAS.anticipacionMinimaMin
    : -Infinity;

  // Barberos candidatos: activos, que hacen ese servicio y trabajan ese día.
  const candidatos = await consultar(
    `SELECT b.id, b.nombre, h.desde_min, h.hasta_min
       FROM barberos b
       JOIN barbero_servicio bs ON bs.barbero_id = b.id AND bs.servicio_id = $1
       JOIN horarios h          ON h.barbero_id  = b.id AND h.dia_semana = $2
      WHERE b.activo
        AND ($3::text IS NULL OR b.id = $3)
      ORDER BY b.orden, b.nombre, h.desde_min`,
    [servicioId, m.dia_semana, barberoId]
  );

  if (!candidatos.rows.length) return { fecha, huecos: [] };

  // Ocupaciones del día: turnos vivos + bloqueos. Se piden en minutos locales
  // para poder mezclarlos con los horarios sin volver a tocar zonas horarias.
  const ocupaciones = await consultar(
    `WITH dia AS (
       SELECT tstzrange(
                ($1::date::timestamp)             AT TIME ZONE $2,
                ($1::date::timestamp + interval '1 day') AT TIME ZONE $2,
                '[)'
              ) AS rango
     )
     SELECT t.barbero_id,
            EXTRACT(EPOCH FROM ((lower(t.franja) AT TIME ZONE $2) - $1::date::timestamp)) / 60 AS desde_min,
            EXTRACT(EPOCH FROM ((upper(t.franja) AT TIME ZONE $2) - $1::date::timestamp)) / 60 AS hasta_min
       FROM turnos t, dia
      WHERE t.estado <> 'cancelado' AND t.franja && dia.rango
     UNION ALL
     SELECT bl.barbero_id,
            EXTRACT(EPOCH FROM ((lower(bl.franja) AT TIME ZONE $2) - $1::date::timestamp)) / 60,
            EXTRACT(EPOCH FROM ((upper(bl.franja) AT TIME ZONE $2) - $1::date::timestamp)) / 60
       FROM bloqueos bl, dia
      WHERE bl.franja && dia.rango`,
    [fecha, ZONA]
  );

  const ocupadoPorBarbero = new Map();
  const ocupadoTodoElLocal = [];
  for (const fila of ocupaciones.rows) {
    const item = { desdeMin: Number(fila.desde_min), hastaMin: Number(fila.hasta_min) };
    if (fila.barbero_id === null) {
      ocupadoTodoElLocal.push(item); // bloqueo general: feriado, cierre
    } else {
      if (!ocupadoPorBarbero.has(fila.barbero_id)) ocupadoPorBarbero.set(fila.barbero_id, []);
      ocupadoPorBarbero.get(fila.barbero_id).push(item);
    }
  }

  // Un barbero puede tener más de una franja el mismo día (mañana y tarde).
  const franjasPorBarbero = new Map();
  for (const fila of candidatos.rows) {
    if (!franjasPorBarbero.has(fila.id)) franjasPorBarbero.set(fila.id, []);
    franjasPorBarbero.get(fila.id).push({ desde: fila.desde_min, hasta: fila.hasta_min });
  }

  // Acá recién entra la lógica pura, ya sin fechas ni SQL.
  const porHora = new Map();
  for (const [id, franjas] of franjasPorBarbero) {
    const ocupados = [...(ocupadoPorBarbero.get(id) || []), ...ocupadoTodoElLocal];
    for (const franja of franjas) {
      const minutos = huecosLibres({
        aperturaMin: franja.desde,
        cierreMin: franja.hasta,
        duracionMin: servicio.duracion_min,
        granularidadMin: REGLAS.granularidadMin,
        margenMin: REGLAS.margenEntreTurnosMin,
        ocupados,
        pisoMin,
      });
      for (const min of minutos) {
        const hora = aHHMM(min);
        if (!porHora.has(hora)) porHora.set(hora, new Set());
        porHora.get(hora).add(id);
      }
    }
  }

  const huecos = [...porHora.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([hora, ids]) => ({ hora, barberos: [...ids] }));

  return { fecha, huecos };
}

/* ========================================================================== */
/*  Crear turno                                                               */
/* ========================================================================== */

/**
 * Crea el turno. La defensa contra doble reserva NO está en este código:
 * está en la constraint `turnos_sin_solape` del esquema. Acá solo
 * traducimos el error 23P01 de Postgres a un mensaje que entienda una persona.
 */
async function crearTurno(datos) {
  const servicio = await traerServicio(datos.servicioId);
  const token = crypto.randomBytes(24).toString('base64url');

  return enTransaccion(async (cli) => {
    /* 1. Freno de doble clic: mismo mail, mismo servicio, mismos minutos,
          recién enviado. Se mira solo la ventana chica, no la tabla entera
          (error #5 de la fórmula 02: leer 5.000 filas por reserva). */
    const repetido = await cli.query(
      `SELECT id, token_gestion
         FROM turnos
        WHERE lower(cliente_email) = lower($1)
          AND servicio_id = $2
          AND estado <> 'cancelado'
          AND creado_en > now() - ($3 || ' seconds')::interval
          AND lower(franja) = (($4::date + $5::time) AT TIME ZONE $6)
        LIMIT 1`,
      [datos.email, datos.servicioId, String(REGLAS.ventanaDobleClicSeg), datos.fecha, datos.hora, ZONA]
    );
    if (repetido.rows.length) {
      // No es un error: es la misma reserva mandada dos veces. Se devuelve
      // la que ya existe y el usuario ve su confirmación, no un rechazo.
      return { yaExistia: true, id: repetido.rows[0].id, token: repetido.rows[0].token_gestion };
    }

    /* 2. Tope de turnos activos por mail. */
    const activos = await cli.query(
      `SELECT count(*)::int AS n
         FROM turnos
        WHERE lower(cliente_email) = lower($1)
          AND estado = 'confirmado'
          AND upper(franja) > now()`,
      [datos.email]
    );
    if (activos.rows[0].n >= REGLAS.maxTurnosActivosPorEmail) {
      throw new ErrorDeNegocio(
        `Ya tenés ${REGLAS.maxTurnosActivosPorEmail} turnos reservados con este mail. ` +
          'Cancelá alguno desde el mail de confirmación si querés sacar otro.',
        'demasiados_turnos',
        409
      );
    }

    /* 3. Elegir barbero. Si el cliente no eligió, se toma el primero que
          esté libre en ese horario y haga ese servicio. */
    const barberoId = datos.barberoId || (await elegirBarberoLibre(cli, datos, servicio));
    if (!barberoId) {
      throw new ErrorDeNegocio('Ese horario ya no está disponible. Elegí otro.', 'sin_lugar', 409);
    }

    /* 4. Verificar que el horario cae dentro del horario de trabajo del
          barbero. Sin esto, alguien que arme el pedido a mano podría
          reservar a las 3 de la mañana: la constraint impide el solape,
          no impide un turno cuando el local está cerrado. */
    const dentro = await cli.query(
      `SELECT 1
         FROM horarios h
        WHERE h.barbero_id = $1
          AND h.dia_semana = EXTRACT(DOW FROM $2::date)::int
          AND h.desde_min <= EXTRACT(EPOCH FROM $3::time) / 60
          AND h.hasta_min >= EXTRACT(EPOCH FROM $3::time) / 60 + $4::int
        LIMIT 1`,
      [barberoId, datos.fecha, datos.hora, String(servicio.duracion_min)]
    );
    if (!dentro.rows.length) {
      throw new ErrorDeNegocio('Ese día y horario no atendemos. Elegí otro.', 'fuera_de_horario', 409);
    }

    /* 5. Verificar anticipación mínima y máxima, del lado del servidor. */
    const tiempos = await cli.query(
      `SELECT
         ((($1::date + $2::time) AT TIME ZONE $3) < now() + ($4 || ' minutes')::interval) AS muy_pronto,
         ((($1::date + $2::time) AT TIME ZONE $3) > now() + ($5 || ' days')::interval)    AS muy_lejos`,
      [datos.fecha, datos.hora, ZONA, String(REGLAS.anticipacionMinimaMin), String(REGLAS.anticipacionMaximaDias)]
    );
    if (tiempos.rows[0].muy_pronto) {
      throw new ErrorDeNegocio(
        `Los turnos se reservan con al menos ${REGLAS.anticipacionMinimaMin} minutos de anticipación. ` +
          'Para algo de último momento, llamanos.',
        'muy_pronto',
        409
      );
    }
    if (tiempos.rows[0].muy_lejos) {
      throw new ErrorDeNegocio('Esa fecha está fuera de la agenda abierta.', 'muy_lejos', 409);
    }

    /* 6. Insertar. Si dos pedidos llegan juntos, uno gana y el otro recibe
          23P01. No hay ventana entre "consultar si está libre" e "insertar":
          la base decide las dos cosas en la misma operación. */
    let insertado;
    try {
      insertado = await cli.query(
        `INSERT INTO turnos
           (barbero_id, servicio_id, franja, cliente_nombre, cliente_email, cliente_tel, nota, token_gestion)
         VALUES (
           $1, $2,
           tstzrange(
             (($3::date + $4::time) AT TIME ZONE $9),
             (($3::date + $4::time) AT TIME ZONE $9) + ($10::text || ' minutes')::interval,
             '[)'
           ),
           $5, $6, $7, $8, $11
         )
         RETURNING id, token_gestion,
                   to_char(lower(franja) AT TIME ZONE $9, 'YYYY-MM-DD') AS fecha,
                   to_char(lower(franja) AT TIME ZONE $9, 'HH24:MI')    AS hora`,
        [
          barberoId, datos.servicioId, datos.fecha, datos.hora,
          datos.nombre, datos.email, datos.telefono, datos.nota,
          ZONA, String(servicio.duracion_min), token,
        ]
      );
    } catch (err) {
      if (err.code === '23P01') {
        throw new ErrorDeNegocio(
          'Alguien tomó ese horario mientras completabas el formulario. Elegí otro, por favor.',
          'sin_lugar',
          409
        );
      }
      throw err;
    }

    const fila = insertado.rows[0];
    await cli.query(
      `INSERT INTO auditoria (actor, accion, turno_id, detalle) VALUES ($1, 'crear_turno', $2, $3)`,
      [`cliente:${datos.email}`, fila.id, `${datos.servicioId} con ${barberoId} el ${fila.fecha} ${fila.hora}`]
    );

    return {
      yaExistia: false,
      id: fila.id,
      token: fila.token_gestion,
      barberoId,
      fecha: fila.fecha,
      hora: fila.hora,
    };
  });
}

/** Primer barbero libre para ese servicio, fecha y hora. */
async function elegirBarberoLibre(cli, datos, servicio) {
  const r = await cli.query(
    `SELECT b.id
       FROM barberos b
       JOIN barbero_servicio bs ON bs.barbero_id = b.id AND bs.servicio_id = $1
       JOIN horarios h ON h.barbero_id = b.id
                      AND h.dia_semana = EXTRACT(DOW FROM $2::date)::int
                      AND h.desde_min <= EXTRACT(EPOCH FROM $3::time) / 60
                      AND h.hasta_min >= EXTRACT(EPOCH FROM $3::time) / 60 + $4::int
      WHERE b.activo
        AND NOT EXISTS (
          SELECT 1 FROM turnos t
           WHERE t.barbero_id = b.id
             AND t.estado <> 'cancelado'
             AND t.franja && tstzrange(
                   (($2::date + $3::time) AT TIME ZONE $5),
                   (($2::date + $3::time) AT TIME ZONE $5) + ($4::text || ' minutes')::interval, '[)')
        )
        AND NOT EXISTS (
          SELECT 1 FROM bloqueos bl
           WHERE (bl.barbero_id = b.id OR bl.barbero_id IS NULL)
             AND bl.franja && tstzrange(
                   (($2::date + $3::time) AT TIME ZONE $5),
                   (($2::date + $3::time) AT TIME ZONE $5) + ($4::text || ' minutes')::interval, '[)')
        )
      ORDER BY b.orden, b.id
      LIMIT 1`,
    [datos.servicioId, datos.fecha, datos.hora, String(servicio.duracion_min), ZONA]
  );
  return r.rows.length ? r.rows[0].id : null;
}

/* ========================================================================== */
/*  Consultar / cancelar con el token del mail                                */
/* ========================================================================== */

async function traerPorToken(token) {
  const r = await consultar(
    `SELECT t.id, t.estado, t.cliente_nombre, t.cliente_email, t.nota,
            s.nombre AS servicio, s.duracion_min, s.precio_ars,
            b.nombre AS barbero, b.id AS barbero_id,
            to_char(lower(t.franja) AT TIME ZONE $2, 'YYYY-MM-DD') AS fecha,
            to_char(lower(t.franja) AT TIME ZONE $2, 'HH24:MI')    AS hora,
            (upper(t.franja) < now()) AS ya_paso
       FROM turnos t
       JOIN servicios s ON s.id = t.servicio_id
       JOIN barberos  b ON b.id = t.barbero_id
      WHERE t.token_gestion = $1`,
    [token, ZONA]
  );
  return r.rows[0] || null;
}

async function cancelarConToken(token) {
  const r = await consultar(
    `UPDATE turnos
        SET estado = 'cancelado', actualizado_en = now()
      WHERE token_gestion = $1
        AND estado = 'confirmado'
        AND lower(franja) > now()
      RETURNING id, cliente_email`,
    [token]
  );
  if (!r.rows.length) {
    throw new ErrorDeNegocio(
      'No se pudo cancelar: el turno no existe, ya estaba cancelado o ya pasó. Llamanos y lo vemos.',
      'no_cancelable',
      409
    );
  }
  await consultar(
    `INSERT INTO auditoria (actor, accion, turno_id, detalle) VALUES ($1, 'cancelar', $2, 'desde el link del mail')`,
    [`cliente:${r.rows[0].cliente_email}`, r.rows[0].id]
  );
  return r.rows[0].id;
}

/* ========================================================================== */

async function traerServicio(servicioId) {
  const r = await consultar('SELECT id, nombre, duracion_min, precio_ars FROM servicios WHERE id = $1 AND activo', [servicioId]);
  if (!r.rows.length) throw new ErrorDeNegocio('Ese servicio no existe.', 'servicio_invalido');
  return r.rows[0];
}

module.exports = {
  ErrorDeNegocio,
  listarCatalogo,
  disponibilidadDelDia,
  crearTurno,
  traerPorToken,
  cancelarConToken,
  aMinutos,
};

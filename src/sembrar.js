/* ============================================================================
   Vuelca config.js a la base: servicios, barberos, quién hace qué, horarios,
   y el usuario del panel.

   Es idempotente: se corre cada vez que se cambia config.js y actualiza lo
   que haya cambiado, sin borrar turnos ya reservados.

   `npm run sembrar`
   ========================================================================== */

'use strict';

require('./env');

const { enTransaccion, cerrar } = require('./db');
const { SERVICIOS, BARBEROS, minutosDesde } = require('./config');
const { crearAdmin } = require('./auth');

(async () => {
  try {
    await enTransaccion(async (cli) => {
      /* --- Servicios --- */
      for (const s of SERVICIOS) {
        await cli.query(
          `INSERT INTO servicios (id, nombre, duracion_min, precio_ars, orden, activo)
           VALUES ($1,$2,$3,$4,$5,true)
           ON CONFLICT (id) DO UPDATE
             SET nombre = EXCLUDED.nombre,
                 duracion_min = EXCLUDED.duracion_min,
                 precio_ars = EXCLUDED.precio_ars,
                 orden = EXCLUDED.orden,
                 activo = true`,
          [s.id, s.nombre, s.duracionMin, s.precioArs, s.orden]
        );
      }
      // Lo que ya no está en config se desactiva, no se borra: si se borrara,
      // los turnos históricos que lo referencian se caerían por la foreign key.
      await cli.query(
        `UPDATE servicios SET activo = false WHERE id <> ALL($1::text[])`,
        [SERVICIOS.map((s) => s.id)]
      );

      /* --- Barberos --- */
      for (const b of BARBEROS) {
        await cli.query(
          `INSERT INTO barberos (id, nombre, descripcion, orden, activo)
           VALUES ($1,$2,$3,$4,true)
           ON CONFLICT (id) DO UPDATE
             SET nombre = EXCLUDED.nombre,
                 descripcion = EXCLUDED.descripcion,
                 orden = EXCLUDED.orden,
                 activo = true`,
          [b.id, b.nombre, b.descripcion, b.orden]
        );
      }
      await cli.query(
        `UPDATE barberos SET activo = false WHERE id <> ALL($1::text[])`,
        [BARBEROS.map((b) => b.id)]
      );

      /* --- Quién hace qué --- */
      await cli.query('DELETE FROM barbero_servicio');
      for (const b of BARBEROS) {
        for (const sid of b.servicios) {
          if (!SERVICIOS.some((s) => s.id === sid)) {
            throw new Error(`El barbero "${b.id}" tiene el servicio "${sid}", que no existe en SERVICIOS.`);
          }
          await cli.query(
            'INSERT INTO barbero_servicio (barbero_id, servicio_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [b.id, sid]
          );
        }
      }

      /* --- Horarios --- */
      await cli.query('DELETE FROM horarios');
      for (const b of BARBEROS) {
        for (const h of b.horarios) {
          const desde = minutosDesde(h.desde);
          const hasta = minutosDesde(h.hasta);
          if (!(hasta > desde)) {
            throw new Error(`Horario inválido de ${b.id}: ${h.desde}-${h.hasta}`);
          }
          await cli.query(
            'INSERT INTO horarios (barbero_id, dia_semana, desde_min, hasta_min) VALUES ($1,$2,$3,$4)',
            [b.id, h.dia, desde, hasta]
          );
        }
      }
    });

    console.log('[sembrar] Catálogo, equipo y horarios actualizados.');

    /* --- Usuario del panel --- */
    const usuario = process.env.PANEL_USUARIO;
    const password = process.env.PANEL_PASSWORD;
    if (usuario && password) {
      await crearAdmin(usuario, password);
      console.log(`[sembrar] Usuario del panel "${usuario}" creado/actualizado.`);
      console.log('[sembrar] Sacá PANEL_PASSWORD del .env ahora: ya quedó hasheada en la base.');
    } else {
      console.warn('[sembrar] Sin PANEL_USUARIO/PANEL_PASSWORD: no se creó usuario del panel.');
    }
  } catch (err) {
    console.error('[sembrar] Falló:', err.message);
    process.exitCode = 1;
  } finally {
    await cerrar();
  }
})();

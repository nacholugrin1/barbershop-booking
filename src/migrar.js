/* Crea las tablas. Se puede correr las veces que haga falta: todo es
   IF NOT EXISTS. `npm run migrar` */

'use strict';

require('./env');

const fs = require('node:fs');
const path = require('node:path');
const { consultar, cerrar } = require('./db');

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await consultar(sql);
    console.log('[migrar] Esquema aplicado.');

    // Verificación explícita de lo único que no puede faltar.
    const r = await consultar(
      `SELECT 1 FROM pg_constraint WHERE conname = 'turnos_sin_solape'`
    );
    if (!r.rows.length) throw new Error('La constraint turnos_sin_solape no quedó creada.');
    console.log('[migrar] Constraint anti-doble-reserva verificada.');
  } catch (err) {
    console.error('[migrar] Falló:', err.message);
    process.exitCode = 1;
  } finally {
    await cerrar();
  }
})();

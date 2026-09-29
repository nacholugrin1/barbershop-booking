/* ============================================================================
   Conexión a PostgreSQL.

   La cadena de conexión NUNCA está en el código: viene de DATABASE_URL.
   Este archivo no llega jamás al navegador — el frontend solo conoce
   la URL pública de la API, igual que en el Paquete 2 solo conocía la URL
   del Web App de Apps Script.
   ========================================================================== */

'use strict';

const { Pool } = require('pg');

const cadena = process.env.DATABASE_URL;
if (!cadena) {
  console.error('[db] Falta DATABASE_URL. Copiá .env.example a .env y completalo.');
  process.exit(1);
}

// Neon y la mayoría de los Postgres administrados exigen TLS. En local
// (localhost) no hace falta y romper eso sería una molestia gratuita.
const esLocal = /localhost|127\.0\.0\.1/.test(cadena);

const pool = new Pool({
  connectionString: cadena,
  ssl: esLocal ? false : { rejectUnauthorized: true },
  max: Number(process.env.DB_MAX_CONEXIONES || 5),
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  // Un cliente inactivo que se cae no debe tumbar el proceso entero.
  console.error('[db] Error en cliente inactivo:', err.message);
});

async function consultar(texto, parametros) {
  return pool.query(texto, parametros);
}

/**
 * Corre `fn` dentro de una transacción. Si tira, hace ROLLBACK.
 * Devuelve lo que devuelva `fn`.
 */
async function enTransaccion(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (err) {
    try { await cliente.query('ROLLBACK'); } catch { /* la conexión ya estaba rota */ }
    throw err;
  } finally {
    cliente.release();
  }
}

async function cerrar() {
  await pool.end();
}

module.exports = { pool, consultar, enTransaccion, cerrar };

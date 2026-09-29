/* ============================================================================
   AUTENTICACIÓN DEL PANEL DEL DUEÑO.

   Decidido con Nacho el 04/08/2026: contraseña con hash en la base, sesión
   en cookie httpOnly. Sin dependencias externas ni nada que pagar.

   ---------------------------------------------------------------------------
   Los tres conceptos que hay que poder explicar en una entrevista
   ---------------------------------------------------------------------------

   1) HASH, NO ENCRIPTACIÓN
      Formal: la contraseña se guarda como un digest de bcrypt, una función
      de un solo sentido con factor de trabajo configurable y salt por
      registro. No existe operación inversa: al validar se vuelve a hashear
      lo que el usuario escribió y se comparan digests.
      En criollo: encriptar es guardar algo en una caja fuerte — con la llave
      lo sacás entero. Hashear es hacer un puré: podés hacer puré de la misma
      papa y ver si te da el mismo puré, pero del puré no volvés a la papa.
      Si te roban la base, no se llevan las contraseñas.

   2) COOKIE httpOnly
      Formal: la cookie de sesión se marca `HttpOnly`, `SameSite=Strict` y
      `Secure` en producción, por lo que `document.cookie` de JavaScript no
      puede leerla y el navegador no la manda en pedidos de terceros.
      En criollo: el token está en un sobre cerrado que el navegador entrega
      solo en la puerta correcta. Aunque alguien logre meter JavaScript
      malicioso en la página, no puede abrir el sobre y copiarse la sesión.

   3) SESIÓN EN LA BASE, NO EN UN JWT
      Formal: el token es un identificador opaco con su estado guardado del
      lado del servidor, en vez de un token autocontenido validado por firma.
      Permite revocación inmediata y cierre de sesión real.
      En criollo: un JWT es una entrada de recital impresa — si te la roban,
      entran, y vos no podés hacer nada hasta que expire. Una sesión en la
      base es una lista en la puerta: te tacho del listado y se acabó.
      Esto es exactamente el debate de "token stateless vs. revocación" que
      aparece en cualquier conversación de IAM.
   ========================================================================== */

'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { consultar } = require('./db');

const NOMBRE_COOKIE = 'sesion_panel';
const HORAS_DE_SESION = Number(process.env.HORAS_SESION || 8);
const EN_PRODUCCION = process.env.NODE_ENV === 'production';

/* --- Freno de fuerza bruta, en memoria. Suficiente para un local con un
       usuario; si algún día hay varias sucursales esto va a la base. --- */
const intentos = new Map();
const MAX_INTENTOS = 6;
const BLOQUEO_MS = 10 * 60 * 1000;

function registrarIntentoFallido(clave) {
  const ahora = Date.now();
  const actual = intentos.get(clave) || { n: 0, hasta: 0 };
  actual.n += 1;
  if (actual.n >= MAX_INTENTOS) actual.hasta = ahora + BLOQUEO_MS;
  intentos.set(clave, actual);
}

function estaBloqueado(clave) {
  const actual = intentos.get(clave);
  if (!actual) return false;
  if (actual.hasta && actual.hasta > Date.now()) return true;
  if (actual.hasta && actual.hasta <= Date.now()) intentos.delete(clave);
  return false;
}

async function crearAdmin(usuario, password) {
  if (String(password).length < 10) {
    throw new Error('La contraseña del panel tiene que tener al menos 10 caracteres.');
  }
  const hash = await bcrypt.hash(String(password), 12);
  await consultar(
    `INSERT INTO admin_usuarios (usuario, hash_password) VALUES ($1, $2)
     ON CONFLICT (usuario) DO UPDATE SET hash_password = EXCLUDED.hash_password`,
    [String(usuario).toLowerCase().trim(), hash]
  );
}

/**
 * Valida usuario y contraseña y devuelve un token de sesión nuevo.
 * @returns {Promise<{ok:true, token:string, usuario:string} | {ok:false, motivo:string}>}
 */
async function iniciarSesion(usuario, password, claveFreno) {
  if (estaBloqueado(claveFreno)) {
    return { ok: false, motivo: 'Demasiados intentos. Probá de nuevo en 10 minutos.' };
  }

  const r = await consultar('SELECT id, usuario, hash_password FROM admin_usuarios WHERE usuario = $1', [
    String(usuario || '').toLowerCase().trim(),
  ]);

  // Se compara siempre contra un hash, exista el usuario o no, para que el
  // tiempo de respuesta no delate cuáles usuarios existen (ataque de canal
  // lateral por tiempo). El hash de abajo tiene formato bcrypt válido y no
  // corresponde a ninguna contraseña: solo sirve para gastar los mismos
  // milisegundos que gastaría una comparación real.
  const HASH_FALSO = '$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNO';
  const hashObjetivo = r.rows[0]?.hash_password || HASH_FALSO;
  const coincide = await bcrypt.compare(String(password || ''), hashObjetivo);

  if (!r.rows.length || !coincide) {
    registrarIntentoFallido(claveFreno);
    return { ok: false, motivo: 'Usuario o contraseña incorrectos.' };
  }

  intentos.delete(claveFreno);

  const token = crypto.randomBytes(32).toString('base64url');
  await consultar(
    `INSERT INTO sesiones (token, usuario_id, expira_en) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
    [token, r.rows[0].id, String(HORAS_DE_SESION)]
  );
  // Higiene: cada login limpia lo vencido. Barato y evita una tarea programada.
  await consultar('DELETE FROM sesiones WHERE expira_en < now()');

  return { ok: true, token, usuario: r.rows[0].usuario };
}

async function cerrarSesion(token) {
  if (!token) return;
  await consultar('DELETE FROM sesiones WHERE token = $1', [token]);
}

function leerCookie(req, nombre) {
  const crudo = req.headers.cookie;
  if (!crudo) return null;
  for (const parte of crudo.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

function ponerCookie(res, token) {
  const partes = [
    `${NOMBRE_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${HORAS_DE_SESION * 3600}`,
  ];
  if (EN_PRODUCCION) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

function borrarCookie(res) {
  res.setHeader('Set-Cookie', `${NOMBRE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** Middleware: corta el paso si no hay sesión viva. */
async function exigirSesion(req, res, next) {
  try {
    const token = leerCookie(req, NOMBRE_COOKIE);
    if (!token) return res.status(401).json({ error: 'Sesión no iniciada.' });

    const r = await consultar(
      `SELECT s.token, a.usuario
         FROM sesiones s
         JOIN admin_usuarios a ON a.id = s.usuario_id
        WHERE s.token = $1 AND s.expira_en > now()`,
      [token]
    );
    if (!r.rows.length) {
      borrarCookie(res);
      return res.status(401).json({ error: 'La sesión venció. Entrá de nuevo.' });
    }
    req.sesion = { token: r.rows[0].token, usuario: r.rows[0].usuario };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  NOMBRE_COOKIE,
  crearAdmin,
  iniciarSesion,
  cerrarSesion,
  exigirSesion,
  leerCookie,
  ponerCookie,
  borrarCookie,
};

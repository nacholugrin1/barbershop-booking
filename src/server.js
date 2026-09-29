/* ============================================================================
   SERVIDOR — Express.

   Superficie pública expuesta (a propósito, chica y acotada):
     GET  /api/catalogo                       servicios y barberos
     GET  /api/disponibilidad?...             huecos libres de un día
     POST /api/reservas                       crear turno
     GET  /api/turno/:token                   ver el propio turno
     POST /api/turno/:token/cancelar          cancelarlo

   Superficie privada (exige sesión):
     POST /api/panel/login  ·  POST /api/panel/logout
     GET  /api/panel/dia?fecha=  ·  POST /api/panel/turno/:id/estado
     POST /api/panel/bloqueo    ·  GET  /api/panel/resumen

   Igual que en el Paquete 2: el navegador no conoce ninguna credencial.
   Solo conoce estas rutas. La conexión a la base y el SMTP viven acá.
   ========================================================================== */

'use strict';

require('./env'); // primero de todo: sin variables de entorno no arranca nada

const path = require('node:path');
const express = require('express');

const { NEGOCIO, ZONA } = require('./config');
const reservas = require('./reservas');
const panel = require('./panel');
const auth = require('./auth');
const mailer = require('./mailer');
const { validarReserva } = require('./validacion');
const { consultar } = require('./db');

// MODO_DEMO=1 muestra en las páginas públicas un aviso de "negocio ficticio".
// Es para el demo de portfolio; con un cliente real se deja vacío.
const MODO_DEMO = process.env.MODO_DEMO === '1';

const app = express();
app.set('trust proxy', 1); // detrás del proxy de Render/Fly: req.ip real
app.disable('x-powered-by');

app.use(express.json({ limit: '16kb' }));

/* --- Cabeceras de seguridad. Sin librería: son cuatro líneas.
       Van ANTES del static para que también protejan al HTML servido. --- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'"
  );
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

/* --- Limitador de pedidos, en memoria. Frena el "script que reserva 500
       turnos", no un ataque serio. Para eso está el proxy de adelante. --- */
const cubos = new Map();
function limitar(maxPorMinuto) {
  return (req, res, next) => {
    const clave = `${req.ip}:${req.path}`;
    const ahora = Date.now();
    const cubo = cubos.get(clave) || { n: 0, reinicio: ahora + 60000 };
    if (ahora > cubo.reinicio) { cubo.n = 0; cubo.reinicio = ahora + 60000; }
    cubo.n += 1;
    cubos.set(clave, cubo);
    if (cubo.n > maxPorMinuto) {
      return res.status(429).json({ error: 'Demasiados pedidos seguidos. Esperá un minuto.' });
    }
    next();
  };
}
setInterval(() => {
  const ahora = Date.now();
  for (const [k, v] of cubos) if (ahora > v.reinicio + 120000) cubos.delete(k);
}, 300000).unref();

/* --- Envoltorio para que un `throw` dentro de un async llegue al manejador
       de errores en vez de quedar en una promesa colgada. --- */
const asincrono = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ========================================================================== */
/*  Público                                                                   */
/* ========================================================================== */

app.get('/api/salud', asincrono(async (req, res) => {
  await consultar('SELECT 1');
  res.json({ ok: true, negocio: NEGOCIO.nombre, zona: ZONA });
}));

app.get('/api/catalogo', asincrono(async (req, res) => {
  res.json({ ...(await reservas.listarCatalogo()), demo: MODO_DEMO });
}));

app.get('/api/disponibilidad', limitar(60), asincrono(async (req, res) => {
  const fecha = String(req.query.fecha || '');
  const servicioId = String(req.query.servicio || '');
  const barberoId = req.query.barbero && req.query.barbero !== 'cualquiera' ? String(req.query.barbero) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
  if (!/^[a-z0-9-]{2,40}$/.test(servicioId)) return res.status(400).json({ error: 'Servicio inválido.' });
  if (barberoId && !/^[a-z0-9-]{2,40}$/.test(barberoId)) return res.status(400).json({ error: 'Profesional inválido.' });

  res.json(await reservas.disponibilidadDelDia({ fecha, servicioId, barberoId }));
}));

app.post('/api/reservas', limitar(12), asincrono(async (req, res) => {
  const v = validarReserva(req.body);
  if (!v.ok) return res.status(400).json({ error: v.errores[0], errores: v.errores });

  // Honeypot: al bot se le responde 200 y no se guarda nada. Si le
  // devolviéramos un error, aprendería a esquivar el campo.
  if (v.datos.esBot) {
    console.warn('[spam] Honeypot completado desde', req.ip);
    return res.status(200).json({ ok: true, mensaje: 'Recibido.' });
  }

  const creado = await reservas.crearTurno(v.datos);

  // El turno YA está guardado. De acá para abajo, todo lo que falle se
  // registra pero no se le devuelve como error al cliente: se perdió el
  // aviso, no el turno. (Fórmula 02, paso 5.)
  const detalle = await reservas.traerPorToken(creado.token);
  const urlGestion = `${urlBase(req)}/turno.html?t=${encodeURIComponent(creado.token)}`;
  const paraMail = {
    nombre: v.datos.nombre,
    email: v.datos.email,
    telefono: v.datos.telefono,
    nota: v.datos.nota,
    servicio: detalle.servicio,
    barbero: detalle.barbero,
    duracionMin: detalle.duracion_min,
    hora: detalle.hora,
    fechaLarga: await fechaEnCastellano(detalle.fecha),
  };

  if (!creado.yaExistia) {
    try { await mailer.mandarConfirmacion(paraMail, urlGestion); }
    catch (err) { console.error('[mail] No salió la confirmación:', err.message); }

    try { await mailer.avisarAlDueno(paraMail); }
    catch (err) { console.error('[mail] No salió el aviso al dueño:', err.message); }
  }

  res.status(201).json({
    ok: true,
    yaExistia: creado.yaExistia,
    token: creado.token,
    urlGestion,
    // false = no hay SMTP configurado y el mail solo se escribió en el
    // registro del servidor. El navegador lo usa para no prometer un mail
    // que no va a llegar.
    mailEnviado: mailer.haySmtp,
    turno: {
      servicio: detalle.servicio,
      barbero: detalle.barbero,
      fecha: detalle.fecha,
      fechaLarga: paraMail.fechaLarga,
      hora: detalle.hora,
      duracionMin: detalle.duracion_min,
    },
  });
}));

app.get('/api/turno/:token', limitar(30), asincrono(async (req, res) => {
  const t = await reservas.traerPorToken(String(req.params.token));
  if (!t) return res.status(404).json({ error: 'No encontramos ese turno.' });
  res.json({
    estado: t.estado,
    nombre: t.cliente_nombre,
    servicio: t.servicio,
    barbero: t.barbero,
    fecha: t.fecha,
    fechaLarga: await fechaEnCastellano(t.fecha),
    hora: t.hora,
    duracionMin: t.duracion_min,
    yaPaso: t.ya_paso,
    negocio: { nombre: NEGOCIO.nombre, direccion: NEGOCIO.direccion, telefono: NEGOCIO.telefono },
    demo: MODO_DEMO,
  });
}));

app.post('/api/turno/:token/cancelar', limitar(12), asincrono(async (req, res) => {
  const token = String(req.params.token);
  const antes = await reservas.traerPorToken(token);
  if (!antes) return res.status(404).json({ error: 'No encontramos ese turno.' });
  await reservas.cancelarConToken(token);

  try {
    await mailer.mandarCancelacion({
      email: antes.cliente_email,
      servicio: antes.servicio,
      hora: antes.hora,
      fechaLarga: await fechaEnCastellano(antes.fecha),
    });
  } catch (err) {
    console.error('[mail] No salió el aviso de cancelación:', err.message);
  }

  res.json({ ok: true });
}));

/* ========================================================================== */
/*  Panel del dueño                                                           */
/* ========================================================================== */

app.post('/api/panel/login', limitar(10), asincrono(async (req, res) => {
  const { usuario, password } = req.body || {};
  const r = await auth.iniciarSesion(usuario, password, req.ip);
  if (!r.ok) return res.status(401).json({ error: r.motivo });
  auth.ponerCookie(res, r.token);
  res.json({ ok: true, usuario: r.usuario });
}));

app.post('/api/panel/logout', asincrono(async (req, res) => {
  await auth.cerrarSesion(auth.leerCookie(req, auth.NOMBRE_COOKIE));
  auth.borrarCookie(res);
  res.json({ ok: true });
}));

app.get('/api/panel/yo', auth.exigirSesion, (req, res) => {
  res.json({ usuario: req.sesion.usuario });
});

app.get('/api/panel/dia', auth.exigirSesion, asincrono(async (req, res) => {
  const fecha = req.query.fecha ? String(req.query.fecha) : null;
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
  res.json(await panel.turnosDelDia(fecha));
}));

app.post('/api/panel/turno/:id/estado', auth.exigirSesion, asincrono(async (req, res) => {
  const actualizado = await panel.cambiarEstado(
    String(req.params.id),
    String((req.body || {}).estado || ''),
    `admin:${req.sesion.usuario}`
  );

  // Si el dueño cancela desde el panel, al cliente le avisamos igual.
  if (actualizado.estado === 'cancelado') {
    try {
      await mailer.mandarCancelacion({
        email: actualizado.cliente_email,
        servicio: actualizado.servicio,
        hora: actualizado.hora,
        fechaLarga: await fechaEnCastellano(actualizado.fecha),
      });
    } catch (err) {
      console.error('[mail] No salió el aviso de cancelación:', err.message);
    }
  }

  res.json({ ok: true, estado: actualizado.estado });
}));

app.post('/api/panel/bloqueo', auth.exigirSesion, asincrono(async (req, res) => {
  const { barberoId, fecha, desde, hasta, motivo } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) return res.status(400).json({ error: 'Fecha inválida.' });
  if (!/^\d{2}:\d{2}$/.test(String(desde || '')) || !/^\d{2}:\d{2}$/.test(String(hasta || ''))) {
    return res.status(400).json({ error: 'Horarios inválidos.' });
  }
  if (String(hasta) <= String(desde)) return res.status(400).json({ error: 'El "hasta" tiene que ser posterior al "desde".' });

  const id = await panel.crearBloqueo(
    { barberoId, fecha, desde, hasta, motivo },
    `admin:${req.sesion.usuario}`
  );
  res.status(201).json({ ok: true, id });
}));

app.get('/api/panel/resumen', auth.exigirSesion, asincrono(async (req, res) => {
  res.json(await panel.resumenQuincena());
}));

/* ========================================================================== */
/*  Utilidades y manejo de errores                                            */
/* ========================================================================== */

function urlBase(req) {
  // Orden: la URL que cargó el dueño > la que Render define sola
  // (RENDER_EXTERNAL_URL, ej. https://algo.onrender.com) > la del pedido.
  const fija = process.env.URL_PUBLICA || process.env.RENDER_EXTERNAL_URL;
  if (fija) return fija.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** '2026-08-06' -> 'jueves 6 de agosto'. Lo formatea Postgres, que tiene
    el calendario correcto; JS lo haría con la zona del servidor. */
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
               'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
async function fechaEnCastellano(fechaIso) {
  const r = await consultar(
    `SELECT EXTRACT(DOW  FROM $1::date)::int AS dow,
            EXTRACT(DAY  FROM $1::date)::int AS dia,
            EXTRACT(MONTH FROM $1::date)::int AS mes`,
    [fechaIso]
  );
  const f = r.rows[0];
  return `${DIAS[f.dow]} ${f.dia} de ${MESES[f.mes - 1]}`;
}

app.use((req, res) => res.status(404).json({ error: 'No existe esa ruta.' }));

app.use((err, req, res, _next) => {
  if (err instanceof reservas.ErrorDeNegocio) {
    return res.status(err.http || 400).json({ error: err.message, codigo: err.codigo });
  }
  // Nunca se le devuelve el error interno al navegador: puede filtrar
  // nombres de tablas, rutas del servidor o versiones.
  console.error('[error]', err);
  res.status(500).json({ error: 'Se rompió algo de nuestro lado. Probá de nuevo o llamanos.' });
});

const PUERTO = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PUERTO, () => {
    console.log(`[server] ${NEGOCIO.nombre} — turnos escuchando en http://localhost:${PUERTO}`);
    if (!mailer.haySmtp) console.log('[server] Modo sin SMTP: los mails salen por consola.');
  });
}

module.exports = app;

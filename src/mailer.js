/* ============================================================================
   MAILS.

   Regla heredada del Paquete 2 (fórmula 02, paso 5): el turno se guarda
   PRIMERO y los mails salen DESPUÉS, cada uno en su propio try. Si el
   servidor de correo está caído se pierde el aviso, nunca el turno.

   Si no hay SMTP configurado, no rompe: escribe el mail en la consola. Así
   se puede desarrollar y probar el flujo entero sin conectar una casilla real.
   ========================================================================== */

'use strict';

const nodemailer = require('nodemailer');
const { NEGOCIO, MAILS } = require('./config');
const { escaparHtml } = require('./validacion');

const haySmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transporte = haySmtp
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

if (!haySmtp) {
  console.warn('[mail] Sin SMTP configurado: los mails se van a imprimir en consola, no a enviar.');
}

async function enviar({ para, asunto, html, texto }) {
  if (!transporte) {
    console.log('\n────────── MAIL (simulado) ──────────');
    console.log('Para:   ', para);
    console.log('Asunto: ', asunto);
    console.log(texto);
    console.log('─────────────────────────────────────\n');
    return { simulado: true };
  }
  return transporte.sendMail({
    from: process.env.SMTP_FROM || `"${NEGOCIO.nombre}" <${process.env.SMTP_USER}>`,
    to: para,
    subject: asunto,
    text: texto,
    html,
  });
}

/* --- Plantilla base. HTML simple a propósito: los clientes de correo
       rompen cualquier cosa moderna, y esto tiene que llegar entero
       a un Gmail de Android de 2019. --- */
function envoltorio(titulo, cuerpoHtml) {
  return `<!doctype html><html lang="es"><body style="margin:0;padding:24px;background:#ece7df;font-family:Helvetica,Arial,sans-serif;color:#1c2622">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #cfc7b9">
    <tr><td style="background:#14261f;padding:18px 24px">
      <span style="color:#d4b169;font-size:13px;letter-spacing:2px;text-transform:uppercase">${escaparHtml(NEGOCIO.nombre)}</span>
    </td></tr>
    <tr><td style="padding:26px 24px">
      <h1 style="margin:0 0 16px;font-size:21px;color:#14261f">${escaparHtml(titulo)}</h1>
      ${cuerpoHtml}
    </td></tr>
    <tr><td style="padding:16px 24px;border-top:1px solid #cfc7b9;font-size:12px;color:#5d6b64">
      ${escaparHtml(NEGOCIO.direccion)}<br>${escaparHtml(NEGOCIO.telefono)}
    </td></tr>
  </table></body></html>`;
}

function filaDato(etiqueta, valor) {
  return `<tr>
    <td style="padding:6px 0;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#b08d3f;width:110px;vertical-align:top">${escaparHtml(etiqueta)}</td>
    <td style="padding:6px 0;font-size:15px;color:#1c2622">${escaparHtml(valor)}</td>
  </tr>`;
}

/** Mail de confirmación al cliente. */
async function mandarConfirmacion(turno, urlGestion) {
  const datos = `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      ${filaDato('Servicio', turno.servicio)}
      ${filaDato('Con', turno.barbero)}
      ${filaDato('Día', turno.fechaLarga)}
      ${filaDato('Hora', turno.hora)}
      ${filaDato('Duración', `${turno.duracionMin} minutos`)}
    </table>`;

  const html = envoltorio(
    `Listo, ${turno.nombre}. Tu turno quedó reservado.`,
    `${datos}
     <p style="margin:22px 0 8px;font-size:14px;line-height:1.6;color:#5d6b64">
       Si no podés venir, avisá desde acá:
     </p>
     <p style="margin:0 0 20px">
       <a href="${urlGestion}" style="display:inline-block;background:#14261f;color:#ffffff;text-decoration:none;padding:12px 22px;font-weight:bold;font-size:14px">Ver, cancelar o reprogramar</a>
     </p>
     <p style="margin:0;font-size:13px;line-height:1.6;color:#5d6b64">${escaparHtml(MAILS.pieDePagina)}</p>`
  );

  const texto = [
    `Tu turno en ${NEGOCIO.nombre} quedó reservado.`,
    '',
    `Servicio: ${turno.servicio}`,
    `Con:      ${turno.barbero}`,
    `Día:      ${turno.fechaLarga}`,
    `Hora:     ${turno.hora} (${turno.duracionMin} minutos)`,
    `Dónde:    ${NEGOCIO.direccion}`,
    '',
    `Cancelar o reprogramar: ${urlGestion}`,
    '',
    MAILS.pieDePagina,
  ].join('\n');

  return enviar({ para: turno.email, asunto: MAILS.asuntoConfirmacion(NEGOCIO), html, texto });
}

/** Aviso al dueño. Va aparte y falla aparte: que no llegue no afecta al cliente. */
async function avisarAlDueno(turno) {
  const destino = process.env.EMAIL_DUENO;
  if (!destino) return { omitido: true };

  const html = envoltorio(
    'Nuevo turno',
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      ${filaDato('Cliente', turno.nombre)}
      ${filaDato('Teléfono', turno.telefono)}
      ${filaDato('Mail', turno.email)}
      ${filaDato('Servicio', turno.servicio)}
      ${filaDato('Con', turno.barbero)}
      ${filaDato('Cuándo', `${turno.fechaLarga}, ${turno.hora}`)}
      ${turno.nota ? filaDato('Nota', turno.nota) : ''}
     </table>`
  );

  const texto = [
    'Nuevo turno reservado.',
    `Cliente:  ${turno.nombre} — ${turno.telefono} — ${turno.email}`,
    `Servicio: ${turno.servicio} con ${turno.barbero}`,
    `Cuándo:   ${turno.fechaLarga} ${turno.hora}`,
    turno.nota ? `Nota:     ${turno.nota}` : '',
  ].filter(Boolean).join('\n');

  return enviar({ para: destino, asunto: MAILS.asuntoAvisoDueno(), html, texto });
}

/** Aviso de cancelación al cliente. */
async function mandarCancelacion(turno) {
  const html = envoltorio(
    'Turno cancelado',
    `<p style="font-size:15px;line-height:1.6;color:#5d6b64">
       Cancelamos tu turno de <strong>${escaparHtml(turno.servicio)}</strong> del
       ${escaparHtml(turno.fechaLarga)} a las ${escaparHtml(turno.hora)}.
       Cuando quieras sacar otro, entrá a <a href="${escaparHtml(NEGOCIO.sitio)}">nuestro sitio</a>.
     </p>`
  );
  const texto =
    `Cancelamos tu turno de ${turno.servicio} del ${turno.fechaLarga} a las ${turno.hora}.\n` +
    `Para sacar otro: ${NEGOCIO.sitio}`;
  return enviar({ para: turno.email, asunto: MAILS.asuntoCancelacion(NEGOCIO), html, texto });
}

module.exports = { enviar, mandarConfirmacion, avisarAlDueno, mandarCancelacion, haySmtp };

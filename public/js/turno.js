/* Ver y cancelar el propio turno.

   El token de la URL es una "capability": quien lo tiene puede operar sobre
   ESE turno y sobre ningún otro. No hay listado, no hay búsqueda por mail, no
   se puede pasar de un turno a otro cambiando un número. Es la misma idea de
   privilegio mínimo que se aplica en IAM, en versión chiquita. */

(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var token = new URLSearchParams(location.search).get('t') || '';
  var turno = null;

  function escapar(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function aviso(texto, clase) {
    var el = $('#aviso');
    el.textContent = texto;
    el.className = 'aviso ' + (clase || '');
  }

  async function pedir(ruta, opciones) {
    var r = await fetch(ruta, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opciones));
    var cuerpo = null;
    try { cuerpo = await r.json(); } catch (e) { cuerpo = null; }
    if (!r.ok) throw new Error((cuerpo && cuerpo.error) || 'No pudimos conectarnos.');
    return cuerpo;
  }

  var ETIQUETAS = {
    confirmado: 'Tu turno está confirmado.',
    atendido: 'Este turno ya fue atendido.',
    no_vino: 'Figura como que no viniste a este turno.',
    cancelado: 'Este turno está cancelado.',
  };

  async function cargar() {
    if (!token) return sinTurno();
    try {
      turno = await pedir('/api/turno/' + encodeURIComponent(token));
    } catch (err) {
      return sinTurno();
    }

    $('#cargando').hidden = true;
    $('#contenido').hidden = false;
    if (turno.demo) $('#aviso-demo').hidden = false;

    $('#d-nombre').textContent = turno.nombre;
    $('#d-servicio').textContent = turno.servicio + ' · ' + turno.duracionMin + ' min';
    $('#d-barbero').textContent = turno.barbero;
    $('#d-cuando').textContent = turno.fechaLarga + ', ' + turno.hora + ' hs';
    $('#d-donde').textContent = turno.negocio.direccion;
    $('#bajada').textContent = ETIQUETAS[turno.estado] || '';

    var cancelable = turno.estado === 'confirmado' && !turno.yaPaso;
    $('#acciones').hidden = false;
    $('#btn-cancelar').hidden = !cancelable;

    if (turno.estado === 'cancelado') {
      aviso('Este turno ya estaba cancelado. Si querés otro, sacalo desde el sitio.', '');
    } else if (turno.yaPaso && turno.estado === 'confirmado') {
      aviso('Este turno ya pasó. Si hubo un problema, llamanos: ' + turno.negocio.telefono, '');
    }
  }

  function sinTurno() {
    $('#cargando').hidden = true;
    $('#no-encontrado').hidden = false;
  }

  $('#btn-cancelar').addEventListener('click', async function () {
    if (!confirm('¿Seguro que querés cancelar este turno? No se puede deshacer.')) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Cancelando…';
    try {
      await pedir('/api/turno/' + encodeURIComponent(token) + '/cancelar', { method: 'POST' });
      aviso('Turno cancelado. Gracias por avisar — eso nos deja el sillón libre para otra persona.', 'ok');
      $('#bajada').textContent = ETIQUETAS.cancelado;
      btn.hidden = true;
    } catch (err) {
      aviso(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'No voy a poder ir — cancelar';
    }
  });

  cargar();
})();

/* ============================================================================
   Panel del dueño.

   Todo lo que se ve acá lo autoriza el servidor. Esconder botones en el
   navegador NO es seguridad: si alguien llama a /api/panel/... sin sesión,
   la respuesta es 401 igual. Este archivo solo dibuja.
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var catalogo = null;

  function escapar(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function aISO(d) {
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  /** Suma días a 'AAAA-MM-DD' sin pasar por UTC (error #3 de la fórmula). */
  function sumarDias(iso, n) {
    var p = iso.split('-');
    return aISO(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
  }

  var DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
               'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function fechaLarga(iso) {
    var p = iso.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return DIAS[d.getDay()] + ' ' + d.getDate() + ' de ' + MESES[d.getMonth()];
  }

  function pesos(n) { return '$' + Number(n).toLocaleString('es-AR'); }

  async function pedir(ruta, opciones) {
    var r = await fetch(ruta, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opciones));
    var cuerpo = null;
    try { cuerpo = await r.json(); } catch (e) { cuerpo = null; }
    if (r.status === 401) { mostrarLogin(); throw new Error('Sesión vencida.'); }
    if (!r.ok) throw new Error((cuerpo && cuerpo.error) || 'Se rompió algo. Probá de nuevo.');
    return cuerpo;
  }

  /* --------------------------------------------------------------- login */

  function mostrarLogin() {
    $('#pantalla-login').hidden = false;
    $('#pantalla-panel').hidden = true;
    $('#btn-salir').hidden = true;
  }

  function mostrarPanel() {
    $('#pantalla-login').hidden = true;
    $('#pantalla-panel').hidden = false;
    $('#btn-salir').hidden = false;
  }

  $('#form-login').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#login-error');
    err.classList.add('oculto');
    var btn = $('#btn-entrar');
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    try {
      await pedir('/api/panel/login', {
        method: 'POST',
        body: JSON.stringify({ usuario: $('#usuario').value, password: $('#password').value }),
      });
      $('#password').value = '';
      mostrarPanel();
      await arrancarPanel();
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.remove('oculto');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });

  $('#btn-salir').addEventListener('click', async function () {
    try { await fetch('/api/panel/logout', { method: 'POST' }); } catch (e) { /* da igual */ }
    mostrarLogin();
  });

  /* --------------------------------------------------------------- panel */

  async function arrancarPanel() {
    var hoy = aISO(new Date());
    $('#dia').value = $('#dia').value || hoy;
    $('#b-fecha').value = $('#b-fecha').value || hoy;

    if (!catalogo) {
      catalogo = await pedir('/api/catalogo');
      var sel = $('#b-barbero');
      catalogo.barberos.forEach(function (b) {
        var o = document.createElement('option');
        o.value = b.id;
        o.textContent = b.nombre;
        sel.appendChild(o);
      });
    }

    await Promise.all([cargarDia(), cargarResumen()]);
  }

  async function cargarDia() {
    var fecha = $('#dia').value;
    var cont = $('#lista-turnos');
    cont.innerHTML = '<p class="cargando">Cargando…</p>';
    $('#titulo-dia').textContent = 'Turnos de ' + fechaLarga(fecha);

    var r;
    try { r = await pedir('/api/panel/dia?fecha=' + encodeURIComponent(fecha)); }
    catch (e) { cont.innerHTML = '<p class="aviso error">' + escapar(e.message) + '</p>'; return; }

    pintarTarjetas(r.resumen);

    if (!r.turnos.length) {
      cont.innerHTML = '<p class="vacio">Sin turnos ese día. Puede ser un día cerrado, o simplemente que no reservó nadie todavía.</p>';
      return;
    }

    cont.innerHTML = '';
    r.turnos.forEach(function (t) { cont.appendChild(filaTurno(t)); });
  }

  function pintarTarjetas(res) {
    $('#tarjetas').innerHTML =
      tarjeta(res.total, 'Turnos') +
      tarjeta(Math.round(res.minutosOcupados / 60 * 10) / 10 + ' h', 'Sillón ocupado') +
      tarjeta(pesos(res.facturacionEstimada), 'Estimado del día') +
      tarjeta(res.noVinieron, 'No vinieron');
  }
  function tarjeta(n, k) {
    return '<div class="tarjeta"><div class="n">' + escapar(n) + '</div><div class="k">' + escapar(k) + '</div></div>';
  }

  var ESTADOS = { confirmado: 'Confirmado', atendido: 'Atendido', no_vino: 'No vino', cancelado: 'Cancelado' };

  function filaTurno(t) {
    var fila = document.createElement('article');
    fila.className = 'turno-fila' + (t.estado === 'cancelado' ? ' fila-cancelado' : '');

    fila.innerHTML =
      '<div class="turno-hora">' + escapar(t.hora) + '<small>a ' + escapar(t.hora_fin) + '</small></div>' +
      '<div>' +
        '<div class="turno-quien">' + escapar(t.cliente_nombre) +
          ' <span class="etiqueta e-' + t.estado + '">' + escapar(ESTADOS[t.estado] || t.estado) + '</span></div>' +
        '<div class="turno-meta">' + escapar(t.servicio) + ' · con ' + escapar(t.barbero) + ' · ' + pesos(t.precio_ars) + '</div>' +
        '<div class="turno-meta"><a href="tel:' + escapar(t.cliente_tel) + '">' + escapar(t.cliente_tel) + '</a>' +
          ' · <a href="mailto:' + escapar(t.cliente_email) + '">' + escapar(t.cliente_email) + '</a></div>' +
        (t.nota ? '<div class="turno-nota">' + escapar(t.nota) + '</div>' : '') +
      '</div>';

    var botones = document.createElement('div');
    botones.className = 'turno-botones';

    if (t.estado !== 'cancelado') {
      if (t.estado !== 'atendido') botones.appendChild(boton('Vino', 'atendido', t, 'btn-suave'));
      if (t.estado !== 'no_vino') botones.appendChild(boton('No vino', 'no_vino', t, 'btn-suave'));
      botones.appendChild(boton('Cancelar', 'cancelado', t, 'btn-peligro'));
    }
    fila.appendChild(botones);
    return fila;
  }

  function boton(texto, estado, turno, clase) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-chico ' + clase;
    b.textContent = texto;
    b.addEventListener('click', async function () {
      if (estado === 'cancelado' && !confirm('Cancelar el turno de ' + turno.cliente_nombre + '? Le va a llegar un mail avisándole.')) return;
      b.disabled = true;
      try {
        await pedir('/api/panel/turno/' + encodeURIComponent(turno.id) + '/estado', {
          method: 'POST',
          body: JSON.stringify({ estado: estado }),
        });
        await Promise.all([cargarDia(), cargarResumen()]);
      } catch (e) {
        avisoPanel(e.message, 'error');
        b.disabled = false;
      }
    });
    return b;
  }

  function avisoPanel(texto, clase) {
    var el = $('#aviso-panel');
    el.textContent = texto;
    el.className = 'aviso ' + (clase || '');
    setTimeout(function () { el.className = 'aviso oculto'; }, 6000);
  }

  async function cargarResumen() {
    try {
      var r = await pedir('/api/panel/resumen');
      $('#resumen-quincena').innerHTML =
        'Últimos 15 días: <strong>' + r.turnos + '</strong> turnos · ' +
        '<strong>' + r.noVinieron + '</strong> ausencias (' + r.tasaAusentismo + '%) · ' +
        '<strong>' + r.cancelados + '</strong> cancelados · ' +
        'facturado sobre atendidos: <strong>' + pesos(r.facturado) + '</strong>.';
    } catch (e) { /* el resumen es información extra: si falla, no rompe el panel */ }
  }

  /* ------------------------------------------------------------ bloqueos */

  $('#form-bloqueo').addEventListener('submit', async function (e) {
    e.preventDefault();
    var av = $('#bloqueo-aviso');
    av.className = 'aviso oculto';
    try {
      await pedir('/api/panel/bloqueo', {
        method: 'POST',
        body: JSON.stringify({
          barberoId: $('#b-barbero').value || null,
          fecha: $('#b-fecha').value,
          desde: $('#b-desde').value,
          hasta: $('#b-hasta').value,
          motivo: $('#b-motivo').value,
        }),
      });
      av.textContent = 'Listo. Ese rato ya no se ofrece a los clientes.';
      av.className = 'aviso ok';
      $('#b-motivo').value = '';
      await cargarDia();
    } catch (e2) {
      av.textContent = e2.message;
      av.className = 'aviso error';
    }
  });

  /* ---------------------------------------------------------- navegación */

  $('#dia').addEventListener('change', cargarDia);
  $('#btn-hoy').addEventListener('click', function () { $('#dia').value = aISO(new Date()); cargarDia(); });
  $('#btn-ayer').addEventListener('click', function () { $('#dia').value = sumarDias($('#dia').value, -1); cargarDia(); });
  $('#btn-manana').addEventListener('click', function () { $('#dia').value = sumarDias($('#dia').value, 1); cargarDia(); });

  /* ----------------------------------------------------------- arranque */

  // Si ya hay cookie de sesión válida, entra directo.
  fetch('/api/panel/yo')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function () { mostrarPanel(); return arrancarPanel(); })
    .catch(function () { mostrarLogin(); });
})();

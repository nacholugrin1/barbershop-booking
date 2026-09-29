/* ============================================================================
   Flujo de reserva — 4 pasos.

   Este archivo lo puede leer cualquiera con clic derecho → ver código fuente.
   Por eso no hay acá ninguna clave, token ni cadena de conexión: solo llamadas
   a rutas de la propia API. Todo lo que valida acá es comodidad para el
   usuario; la validación que cuenta está en el servidor.

   FECHAS: no se usa `new Date('2026-08-05')` en ningún lado. Esa cadena la
   interpreta el navegador como medianoche UTC, que en Argentina (UTC-3) es
   el día anterior a las 21:00 — error conocido #3 de la fórmula de reservas.
   Las fechas se arman y se leen siempre como texto 'AAAA-MM-DD', o con
   `new Date(anio, mes - 1, dia)`, que sí es hora local.
   ========================================================================== */

(function () {
  'use strict';

  var API = ''; // mismo origen que esta página

  var estado = {
    catalogo: null,
    servicio: null,
    barberoId: 'cualquiera',
    fecha: '',
    hora: '',
    enviando: false,
  };

  var $ = function (sel) { return document.querySelector(sel); };
  var avisoGlobal = $('#aviso-global');
  var avisoForm = $('#aviso-form');

  /* ---------------------------------------------------------------- utils */

  function mostrarAviso(el, texto) {
    el.textContent = texto;
    el.classList.remove('oculto');
  }
  function ocultarAviso(el) {
    el.textContent = '';
    el.classList.add('oculto');
  }

  function pesos(n) {
    return '$' + Number(n).toLocaleString('es-AR');
  }

  /** '2026-08-06' -> 'jueves 6 de agosto'. Se arma con partes locales. */
  var DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
               'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function fechaLarga(iso) {
    var p = iso.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); // hora local
    return DIAS[d.getDay()] + ' ' + d.getDate() + ' de ' + MESES[d.getMonth()];
  }

  /** Date local -> 'AAAA-MM-DD'. Nunca toISOString(), que convierte a UTC. */
  function aISO(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dia = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + dia;
  }

  async function pedir(ruta, opciones) {
    var r = await fetch(API + ruta, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opciones));
    var cuerpo = null;
    try { cuerpo = await r.json(); } catch (e) { cuerpo = null; }
    if (!r.ok) {
      var err = new Error((cuerpo && cuerpo.error) || 'No pudimos conectarnos. Probá de nuevo.');
      err.codigo = cuerpo && cuerpo.codigo;
      throw err;
    }
    return cuerpo;
  }

  /* --------------------------------------------------------------- pasos */

  function irA(n) {
    ['1', '2', '3', '4', 'listo'].forEach(function (k) {
      var p = document.getElementById('panel-' + k);
      if (p) p.classList.toggle('visible', String(k) === String(n));
    });
    document.querySelectorAll('.paso-chip').forEach(function (chip) {
      var i = Number(chip.dataset.ir);
      chip.classList.toggle('activo', String(i) === String(n));
      chip.classList.toggle('hecho', i < Number(n));
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.querySelectorAll('[data-atras]').forEach(function (b) {
    b.addEventListener('click', function () { irA(b.dataset.atras); });
  });
  document.querySelectorAll('.paso-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var destino = Number(chip.dataset.ir);
      // Solo se puede volver a un paso ya completado.
      if (destino === 1) return irA(1);
      if (destino === 2 && estado.servicio) return irA(2);
      if (destino === 3 && estado.servicio) return irA(3);
      if (destino === 4 && estado.servicio && estado.fecha && estado.hora) return irA(4);
    });
  });

  /* ------------------------------------------------------------ paso 1-2 */

  async function cargarCatalogo() {
    try {
      estado.catalogo = await pedir('/api/catalogo');
      if (estado.catalogo.demo) $('#aviso-demo').hidden = false;
      pintarServicios();
      prepararFecha();
    } catch (err) {
      $('#lista-servicios').innerHTML = '';
      mostrarAviso(
        avisoGlobal,
        'No pudimos cargar los servicios. Escribinos por WhatsApp y te damos el turno a mano.'
      );
    }
  }

  function pintarServicios() {
    var cont = $('#lista-servicios');
    cont.innerHTML = '';
    estado.catalogo.servicios.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'opcion';
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML =
        '<span class="op-nombre">' + escapar(s.nombre) +
        '<span class="op-detalle">' + s.duracionMin + ' minutos</span></span>' +
        '<span class="op-precio">' + pesos(s.precioArs) + '</span>';
      b.addEventListener('click', function () {
        estado.servicio = s;
        // Si venía preseleccionado un barbero desde el sitio (?barbero=nico)
        // se respeta, salvo que ese barbero no haga este servicio.
        if (s.barberos.indexOf(estado.barberoId) < 0) estado.barberoId = 'cualquiera';
        estado.hora = '';
        cont.querySelectorAll('.opcion').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        pintarBarberos();
        irA(2);
      });
      cont.appendChild(b);
    });
  }

  function pintarBarberos() {
    var cont = $('#lista-barberos');
    cont.innerHTML = '';
    var disponibles = estado.catalogo.barberos.filter(function (b) {
      return estado.servicio.barberos.indexOf(b.id) >= 0;
    });

    var opciones = [{ id: 'cualquiera', nombre: 'Cualquiera', descripcion: 'El primero que tenga lugar. Suele haber más horarios.' }]
      .concat(disponibles);

    opciones.forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opcion';
      btn.setAttribute('aria-pressed', String(b.id === estado.barberoId));
      btn.innerHTML =
        '<span class="op-nombre">' + escapar(b.nombre) +
        '<span class="op-detalle">' + escapar(b.descripcion || '') + '</span></span>';
      btn.addEventListener('click', function () {
        estado.barberoId = b.id;
        estado.hora = '';
        cont.querySelectorAll('.opcion').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
        btn.setAttribute('aria-pressed', 'true');
        irA(3);
        cargarHorarios();
      });
      cont.appendChild(btn);
    });
  }

  /* -------------------------------------------------------------- paso 3 */

  function prepararFecha() {
    var input = $('#fecha');
    var hoy = new Date();
    var max = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + (estado.catalogo.reglas.anticipacionMaximaDias || 45));
    input.min = aISO(hoy);
    input.max = aISO(max);
    if (!input.value) input.value = aISO(hoy);
    estado.fecha = input.value;

    input.addEventListener('change', function () {
      estado.fecha = input.value;
      estado.hora = '';
      cargarHorarios();
    });
  }

  async function cargarHorarios() {
    var zona = $('#zona-horarios');
    if (!estado.servicio || !estado.fecha) return;

    zona.innerHTML = '<p class="cargando">Buscando horarios libres…</p>';
    try {
      var q = '/api/disponibilidad?fecha=' + encodeURIComponent(estado.fecha) +
              '&servicio=' + encodeURIComponent(estado.servicio.id) +
              '&barbero=' + encodeURIComponent(estado.barberoId);
      var r = await pedir(q);

      if (!r.huecos.length) {
        zona.innerHTML =
          '<p class="aviso">Ese día no queda nada libre para <strong>' + escapar(estado.servicio.nombre) +
          '</strong>. Probá otro día, o elegí “Cualquiera” en el paso anterior para ver más opciones.</p>';
        return;
      }

      var grilla = document.createElement('div');
      grilla.className = 'horarios';
      r.huecos.forEach(function (h) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'hora';
        b.textContent = h.hora;
        b.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-label', h.hora + ' — ' + h.barberos.length + ' disponible(s)');
        b.addEventListener('click', function () {
          estado.hora = h.hora;
          // Si el cliente eligió "cualquiera", el servidor asigna. Guardamos
          // el primero solo para mostrarlo en el resumen.
          estado.barberoSugerido = h.barberos[0];
          grilla.querySelectorAll('.hora').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
          b.setAttribute('aria-pressed', 'true');
          pintarResumen();
          irA(4);
        });
        grilla.appendChild(b);
      });

      zona.innerHTML = '';
      var titulo = document.createElement('p');
      titulo.className = 'bajada';
      titulo.textContent = 'Horarios libres para ' + fechaLarga(estado.fecha) + ':';
      zona.appendChild(titulo);
      zona.appendChild(grilla);
    } catch (err) {
      zona.innerHTML = '<p class="aviso error">' + escapar(err.message) + '</p>';
    }
  }

  /* -------------------------------------------------------------- paso 4 */

  function nombreBarbero(id) {
    var b = estado.catalogo.barberos.find(function (x) { return x.id === id; });
    return b ? b.nombre : id;
  }

  function pintarResumen() {
    $('#r-servicio').textContent = estado.servicio.nombre + ' · ' + estado.servicio.duracionMin + ' min';
    $('#r-barbero').textContent = estado.barberoId === 'cualquiera'
      ? nombreBarbero(estado.barberoSugerido) + ' (asignado)'
      : nombreBarbero(estado.barberoId);
    $('#r-cuando').textContent = fechaLarga(estado.fecha) + ', ' + estado.hora + ' hs';
    $('#r-precio').textContent = pesos(estado.servicio.precioArs);
  }

  $('#form-reserva').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (estado.enviando) return;
    ocultarAviso(avisoForm);

    var cuerpo = {
      servicioId: estado.servicio && estado.servicio.id,
      barberoId: estado.barberoId,
      fecha: estado.fecha,
      hora: estado.hora,
      nombre: $('#nombre').value,
      email: $('#email').value,
      telefono: $('#telefono').value,
      nota: $('#nota').value,
      apellido2: $('#apellido2').value,
    };

    // Validación de cortesía. La real está en el servidor.
    if (!cuerpo.nombre.trim() || !cuerpo.email.trim() || !cuerpo.telefono.trim()) {
      mostrarAviso(avisoForm, 'Faltan el nombre, el mail o el teléfono.');
      return;
    }

    estado.enviando = true;
    var btn = $('#btn-confirmar');
    btn.disabled = true;
    btn.textContent = 'Reservando…';

    try {
      var r = await pedir('/api/reservas', { method: 'POST', body: JSON.stringify(cuerpo) });
      mostrarConfirmacion(r);
    } catch (err) {
      mostrarAviso(avisoForm, err.message);
      // Si el horario se ocupó mientras completaba, lo devolvemos al paso 3
      // con los horarios ya actualizados, en vez de dejarlo trabado.
      if (err.codigo === 'sin_lugar' || err.codigo === 'fuera_de_horario') {
        estado.hora = '';
        irA(3);
        cargarHorarios();
      }
    } finally {
      estado.enviando = false;
      btn.disabled = false;
      btn.textContent = 'Confirmar turno';
    }
  });

  function mostrarConfirmacion(r) {
    var t = r.turno;
    $('#l-servicio').textContent = t.servicio + ' · ' + t.duracionMin + ' min';
    $('#l-barbero').textContent = t.barbero;
    $('#l-cuando').textContent = t.fechaLarga + ', ' + t.hora + ' hs';
    $('#listo-detalle').textContent = r.yaExistia
      ? 'Este turno ya lo tenías reservado — no te lo duplicamos.'
      : 'Te guardamos el sillón.';
    $('#l-mail').textContent = r.mailEnviado === false
      ? 'Este demo no envía mails reales. El botón de abajo abre el mismo link que llegaría por mail, para ver o cancelar el turno.'
      : 'Te mandamos un mail con la confirmación y el link para cancelar. Si no llega en unos minutos, mirá en spam.';
    $('#l-gestion').href = 'turno.html?t=' + encodeURIComponent(r.token);
    ocultarAviso(avisoGlobal); // el "Vas a reservar con…" ya no aplica
    irA('listo');
  }

  function escapar(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  /* ----------------------------------------------------------- arranque */

  // El sitio manda ?barbero=nico desde la sección "El equipo".
  var params = new URLSearchParams(location.search);
  var barberoPedido = params.get('barbero');

  cargarCatalogo().then(function () {
    if (barberoPedido && estado.catalogo) {
      var existe = estado.catalogo.barberos.some(function (b) { return b.id === barberoPedido; });
      if (existe) {
        estado.barberoId = barberoPedido;
        // No saltamos pasos: primero hay que elegir servicio igual, pero
        // dejamos preseleccionado a quién quiere.
        mostrarAviso(avisoGlobal, 'Vas a reservar con ' + nombreBarbero(barberoPedido) + '. Elegí primero el servicio.');
        avisoGlobal.classList.remove('error');
      }
    }
  });
})();

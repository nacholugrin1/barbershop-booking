# Cómo poner esto a andar

Escrito para alguien que nunca levantó un backend con base de datos — o para vos dentro de seis meses, cuando no te acuerdes de nada.

Tiempo real: **unos 40 minutos la primera vez**, 10 las siguientes.

---

## Antes de empezar: qué es cada pieza

**Formal:** el sistema tiene tres partes independientes — un proceso Node.js que sirve HTTP, una base de datos PostgreSQL administrada, y un servidor SMTP para el correo saliente. Se conectan por variables de entorno.

**En criollo:** son tres cosas separadas que hay que presentar entre sí.

1. **La base de datos** es el archivador donde viven los turnos. Vive en Neon (una empresa que te alquila un Postgres). Nunca se apaga sola mientras tenga tráfico, y no te cobra hasta cierto volumen.
2. **El servidor** es el empleado que atiende los pedidos: lee y escribe en el archivador y manda los mails. Vive en Render (o donde vos quieras).
3. **El sitio** son las tres páginas HTML. Las sirve el mismo servidor, así que no hay que configurar CORS ni nada raro.

Lo único que el navegador conoce es la dirección del empleado. Nunca la llave del archivador.

---

## Paso 1 — Node.js en tu máquina

Descargar de [nodejs.org](https://nodejs.org) la versión **LTS** (20 o superior). Después, en una terminal parada en esta carpeta:

```bash
node -v          # tiene que decir v20.x o mayor
npm install      # descarga express, pg, bcryptjs y nodemailer
```

## Paso 2 — La base de datos (Neon, gratis)

> **Si ya existe el proyecto "Turnos" en Neon** (el de Barbería Ramírez se creó el 06/08/2026), no crees otro: salteá este paso y usá la cadena que ya tenés en el `.env`. Si Neon muestra la rama como *archived* (se archiva sola por inactividad), no hay que hacer nada: la primera consulta la desarchiva, y esa primera conexión puede tardar unos segundos más.

1. Crear cuenta en [neon.com](https://neon.com) (se puede con la cuenta de GitHub).
2. **Create project.** Elegir la región más cercana — `aws-sa-east-1` (São Paulo) es la que menos latencia da desde Argentina.
3. Al terminar te muestra una **Connection string**. Elegir la variante **"Pooled connection"**, que es la que aguanta varias conexiones a la vez. Se ve así:
   ```
   postgresql://neondb_owner:XXXXXXXX@ep-algo-123-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require
   ```
4. Copiarla. **Esa cadena es la llave del archivador: no va a ningún repo, ni a un chat, ni a una captura de pantalla.**

> **Ojo con el plan gratis de Neon:** 0,5 GB de datos y 100 CU-horas de cómputo por mes, y el cómputo se apaga solo a los 5 minutos sin uso (el primer pedido después tarda un segundo más). Para una barbería es de sobra: 0,5 GB son cientos de miles de turnos.

## Paso 3 — El archivo `.env`

```bash
cp .env.example .env
```

Abrir `.env` y completar como mínimo:

```
DATABASE_URL=<la cadena que copiaste de Neon>
PANEL_USUARIO=hugo
PANEL_PASSWORD=<una contraseña larga, mínimo 10 caracteres>
```

Los mails se pueden dejar vacíos por ahora: el sistema anda igual y te imprime los mails en la consola.

**`.env` está en `.gitignore`.** Si alguna vez se te escapa a un repo público, cambiá la contraseña del panel *y* rotá la contraseña de Neon. Asumí que ya se filtró: los bots escanean GitHub buscando exactamente eso.

## Paso 4 — Crear las tablas y cargar el negocio

```bash
npm run migrar     # crea las tablas
npm run sembrar    # vuelca config.js: servicios, equipo, horarios, y el usuario del panel
```

Los dos se pueden volver a correr sin miedo: `migrar` es todo `IF NOT EXISTS` (no toca lo que ya existe) y `sembrar` actualiza catálogo, equipo y horarios sin borrar turnos. Lo único a tener en cuenta: si en el `.env` sigue estando `PANEL_PASSWORD`, `sembrar` vuelve a guardar esa contraseña como la del panel.

`migrar` tiene que terminar diciendo **"Constraint anti-doble-reserva verificada"**. Si no lo dice, algo falló y no sigas: esa constraint es lo que impide vender el mismo turno dos veces.

Después de `sembrar`, **borrá la línea `PANEL_PASSWORD` del `.env`**: la contraseña ya quedó hasheada en la base y no hace falta tenerla más en texto plano.

## Paso 5 — Probarlo en tu máquina

```bash
npm test     # 22 pruebas de lógica pura, sin tocar la base
npm start
```

Abrir:
- **http://localhost:3000/** → reservar un turno
- **http://localhost:3000/admin.html** → panel (entrar con `PANEL_USUARIO` y la contraseña)

Reservá un turno de prueba. El mail de confirmación va a aparecer escrito en la terminal, con el link de cancelación adentro.

## Paso 6 — Los mails de verdad (opcional)

Con Gmail:

1. Activar la verificación en dos pasos en la cuenta del negocio.
2. Google → Seguridad → **Contraseñas de aplicaciones** → generar una. Son 16 letras.
3. En `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=barberia@gmail.com
   SMTP_PASS=<las 16 letras, sin espacios>
   SMTP_FROM="Barbería Ramírez <barberia@gmail.com>"
   EMAIL_DUENO=barberia@gmail.com
   ```

**No es la contraseña de la cuenta.** Una contraseña de aplicación se puede revocar sola, sin cambiar la de la cuenta. Es el mismo criterio de privilegio mínimo que aplicás en IAM.

> **Ojo: esto anda en tu máquina, no en Render gratis.** El plan gratis de Render bloquea el tráfico saliente por los puertos 25, 465 y 587, que son justamente los de SMTP ([docs de Render](https://render.com/docs/free), verificado el 29/09/2026). Opciones: plan pago de Render, o un servicio de envío por API (tipo Resend) que manda por HTTPS. Para el demo de portfolio se decidió **no mandar mails**: la pantalla de confirmación muestra el link de gestión (ver `MODO_DEMO` en el README).

> Gmail gratis manda ~500 mails por día. Una barbería con 20 turnos diarios usa 40. De sobra. Si algún día se queda corto, la conversación es Google Workspace o un servicio de envío tipo Resend — y **se tiene antes de vender el paquete, no después**.

## Paso 7 — Subirlo a internet (Render)

1. Esta carpeta (`turnos/`) es **su propio repo de git**, separado del resto. Subila a un repo de GitHub propio. **Verificá que `.env` NO esté** (`git status` no lo tiene que listar; `git ls-files` tampoco).
2. En [render.com](https://render.com) → **New → Web Service** → conectar ese repo.
3. Configuración:
   - **Language:** Node · **Branch:** `main`
   - **Root Directory:** vacío (el repo ya es la carpeta del turnero)
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (para el demo)
   - **Health Check Path:** vacío. No pongas `/api/salud`: esa ruta consulta la base, y si Render la llamara seguido Neon no se apagaría nunca y gastaría horas de cómputo.
4. En **Environment Variables**, cargar:
   - `DATABASE_URL` — la misma del `.env` (variante *pooled*).
   - `NODE_ENV=production` — activa el flag `Secure` en la cookie de sesión.
   - `MODO_DEMO=1` — solo para el demo de portfolio.
   - `HORAS_SESION=8` (opcional).
   - **No** cargar `PANEL_PASSWORD` (ya está hasheada en la base) ni las `SMTP_*` (en el plan gratis no salen, ver paso 6).
   - `URL_PUBLICA` ya no hace falta: Render define sola `RENDER_EXTERNAL_URL` y el servidor la usa.
5. **Deploy.** Cuando termine, probá `https://<tu-servicio>.onrender.com/api/salud`: tiene que responder `{"ok":true,...}`.

> **El plan gratis de Render duerme el servicio a los 15 minutos sin tráfico**, y el primer pedido después tarda cerca de un minuto en responder (Render muestra una pantalla de carga). Incluye 750 horas por mes, que alcanzan para un servicio prendido todo el mes. Para un demo está bien (abrilo un par de minutos antes de mostrarlo); para un cliente real, no: alguien entra a sacar turno, espera un minuto y se va. El plan que no duerme cuesta **USD 7/mes** (verificado el 25/09/2026) y ese costo va **dentro del precio que le cobrás al cliente**, no lo comés vos.

## Paso 8 — Enganchar el sitio con el sistema

En `../index.html` (el sitio de la barbería) los botones "Reservar turno" apuntan a `turnos/public/index.html`. Esa ruta relativa sirve para **abrir el demo desde el disco**, sin servidor.

En la versión publicada del sitio de Aura, el que los reemplaza es el script de publicación. Con la URL de Render:

```bash
cd 06_Proyectos/Aura_Digital_Studio
node publicar.js https://<tu-servicio>.onrender.com
```

Sin URL, el script manda esos botones a la sección `#donde` del sitio (para no dejar links rotos).

> Ojo con abrir el demo desde el disco: las páginas del turnero cargan, pero **las llamadas a `/api/...` van a fallar** porque no hay servidor detrás. Para verlo funcionando de verdad hay que hacer `npm start` y entrar por `http://localhost:3000`.

---

## Antes de mostrárselo a un cliente

- [ ] `npm test` pasa entero.
- [ ] Las pruebas de integración pasan **contra una base aparte**, no contra la de producción:
      `DATABASE_URL=<base de prueba> PERMITIR_PRUEBAS=1 npm run test:integracion`
- [ ] Reservaste un turno de punta a punta desde el sitio real y llegó el mail.
- [ ] Cancelaste desde el link del mail y el hueco volvió a aparecer.
- [ ] Entraste al panel, marcaste "no vino" y "vino", y cancelaste un turno.
- [ ] Probaste con el celular, no solo con la computadora.
- [ ] **Borraste todos los turnos de prueba** antes de entregar.
- [ ] El dueño vio el panel llenarse solo, con sus propios ojos. Ese es el momento en que se vende el paquete siguiente.

## Si algo falla

| Síntoma | Qué mirar |
|---|---|
| `Falta DATABASE_URL` | No existe el `.env`, o está en otra carpeta |
| `self signed certificate` / error de TLS | La cadena de Neon tiene que terminar en `?sslmode=require` |
| `La constraint turnos_sin_solape no quedó creada` | La extensión `btree_gist` no se pudo crear. En Neon viene habilitada; en un Postgres propio hace falta ser superusuario |
| Los horarios aparecen corridos una hora | Alguien metió una conversión de fecha en JavaScript. Buscá `new Date(` en `src/` — no tiene que haber ninguna que parsee cadenas |
| Los mails no llegan | Mirá la consola del servidor: si dice "MAIL (simulado)" es que falta el SMTP. Si dice error, casi siempre es la contraseña de aplicación mal copiada |
| El panel te echa todo el tiempo | `HORAS_SESION` muy bajo, o el navegador bloquea cookies. En producción hace falta HTTPS: la cookie va con `Secure` |
| Primer pedido lentísimo | Es el plan gratis de Render despertándose. Ver paso 7 |
| `Cannot find module 'pg'` (o cualquier otro módulo) al correr `npm run migrar`/`sembrar`/`start` | `npm install` se corrió parado en otra carpeta (típicamente `C:\Users\<usuario>`, no `turnos/`). Cada proyecto tiene su propio `node_modules` — hay que pararse en `turnos/` (el prompt de la terminal tiene que terminar en `\turnos>`) y correr `npm install` de nuevo ahí |
| El `.env` "existe" pero `migrar` igual dice que falta `DATABASE_URL` | En Windows, el Explorador de archivos oculta las extensiones por defecto — un archivo guardado como `.env` desde el Bloc de notas suele terminar llamándose en realidad `.env.txt`. Confirmar el nombre real con `Get-ChildItem -Force -Name ".env*"` en PowerShell (eso no se deja engañar por la vista del Explorador), y renombrar si hace falta |
| Un horario reservado no reaparece como libre después de cancelarlo | Casi siempre no es un bug: revisar `anticipacionMinimaMin` en `src/config.js` (90 minutos por defecto). Si el horario cancelado cae a menos de ese margen desde el momento actual, el sistema lo sigue ocultando a propósito — no ofrece turnos de último momento. Confirmar la cancelación en el panel (`admin.html`), que sí muestra el estado real |

*(Las primeras tres filas de esta tabla se agregaron el 06/08/2026, a partir del primer deploy real hecho por Nacho — no eran teóricas, pasaron las tres.)*

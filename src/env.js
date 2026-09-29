/* ============================================================================
   Carga el archivo .env si existe, sin dependencias.

   En producción (Render, Fly, Railway, Azure) las variables ya vienen del
   entorno de la plataforma y este archivo no hace nada. En tu máquina lee
   el .env local. Nunca sobreescribe lo que ya está definido: el entorno real
   siempre gana sobre el archivo.

   IMPORTANTE: .env está en .gitignore. Si alguna vez lo subís a un repo,
   rotá TODAS las credenciales que tenía adentro — asumí que ya se filtraron.
   ========================================================================== */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ruta = path.join(__dirname, '..', '.env');

if (fs.existsSync(ruta)) {
  const contenido = fs.readFileSync(ruta, 'utf8');
  for (const linea of contenido.split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const i = limpia.indexOf('=');
    if (i < 1) continue;
    const clave = limpia.slice(0, i).trim();
    let valor = limpia.slice(i + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    if (process.env[clave] === undefined) process.env[clave] = valor;
  }
}

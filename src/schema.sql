-- ============================================================================
-- ESQUEMA — Sistema de turnos Barbería Ramírez
--
-- Lo importante de este archivo está al final, en la constraint
-- `turnos_sin_solape`. Todo lo demás es andamiaje.
-- ============================================================================

-- btree_gist permite mezclar comparación de igualdad (barbero_id = X, que es
-- un índice btree normal) con comparación de solapamiento de rangos (&&, que
-- necesita GiST) dentro de una misma constraint EXCLUDE.
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- Para gen_random_uuid() en PostgreSQL < 13. En 13+ ya viene de fábrica.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS barberos (
  id          text PRIMARY KEY,
  nombre      text NOT NULL,
  descripcion text NOT NULL DEFAULT '',
  activo      boolean NOT NULL DEFAULT true,
  orden       int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS servicios (
  id           text PRIMARY KEY,
  nombre       text NOT NULL,
  duracion_min int NOT NULL CHECK (duracion_min > 0 AND duracion_min <= 480),
  precio_ars   int NOT NULL CHECK (precio_ars >= 0),
  activo       boolean NOT NULL DEFAULT true,
  orden        int NOT NULL DEFAULT 0
);

-- Qué barbero hace qué servicio. Vale no hace fades; Nico no hace color.
CREATE TABLE IF NOT EXISTS barbero_servicio (
  barbero_id  text NOT NULL REFERENCES barberos(id)  ON DELETE CASCADE,
  servicio_id text NOT NULL REFERENCES servicios(id) ON DELETE CASCADE,
  PRIMARY KEY (barbero_id, servicio_id)
);

-- ---------------------------------------------------------------------------
-- Disponibilidad
-- ---------------------------------------------------------------------------
-- Horario semanal habitual de cada barbero. Minutos desde medianoche
-- (600 = 10:00) para no arrastrar zonas horarias donde no hacen falta:
-- esto es "a qué hora abre", no "un instante en el tiempo".
CREATE TABLE IF NOT EXISTS horarios (
  id         serial PRIMARY KEY,
  barbero_id text NOT NULL REFERENCES barberos(id) ON DELETE CASCADE,
  dia_semana int  NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),  -- 0 = domingo
  desde_min  int  NOT NULL CHECK (desde_min >= 0 AND desde_min < 1440),
  hasta_min  int  NOT NULL CHECK (hasta_min > 0 AND hasta_min <= 1440),
  CHECK (hasta_min > desde_min)
);
CREATE INDEX IF NOT EXISTS horarios_barbero_dia ON horarios (barbero_id, dia_semana);

-- Excepciones puntuales: vacaciones, feriado, "me voy al médico el jueves".
-- barbero_id NULL = cierra todo el local.
CREATE TABLE IF NOT EXISTS bloqueos (
  id         serial PRIMARY KEY,
  barbero_id text REFERENCES barberos(id) ON DELETE CASCADE,
  franja     tstzrange NOT NULL,
  motivo     text NOT NULL DEFAULT '',
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bloqueos_franja ON bloqueos USING gist (franja);

-- ---------------------------------------------------------------------------
-- Turnos
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'estado_turno') THEN
    CREATE TYPE estado_turno AS ENUM ('confirmado', 'atendido', 'no_vino', 'cancelado');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS turnos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  barbero_id     text NOT NULL REFERENCES barberos(id),
  servicio_id    text NOT NULL REFERENCES servicios(id),

  -- El turno es un RANGO de tiempo, no un instante. Guardar "inicio" y
  -- calcular el fin en el código es el error que permite la doble reserva:
  -- la base no puede defender lo que no sabe.
  franja         tstzrange NOT NULL,

  estado         estado_turno NOT NULL DEFAULT 'confirmado',

  cliente_nombre text NOT NULL CHECK (length(btrim(cliente_nombre)) BETWEEN 2 AND 80),
  cliente_email  text NOT NULL CHECK (position('@' in cliente_email) > 1),
  cliente_tel    text NOT NULL CHECK (length(btrim(cliente_tel)) BETWEEN 6 AND 30),
  nota           text NOT NULL DEFAULT '' CHECK (length(nota) <= 500),

  -- Token largo y aleatorio para que el cliente cancele o reprograme desde
  -- el mail sin tener que crearse una cuenta. Es una capability: quien tiene
  -- el token puede operar sobre ESE turno y sobre ningún otro.
  token_gestion  text NOT NULL UNIQUE,

  origen         text NOT NULL DEFAULT 'web',
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),

  CHECK (NOT isempty(franja)),

  -- ==========================================================================
  -- EL CORAZÓN DEL SISTEMA
  --
  -- "Para un mismo barbero (=), no pueden existir dos franjas que se solapen
  --  (&&), considerando solamente los turnos que ocupan el sillón."
  --
  -- Esto NO es una validación del código: es una regla del motor de base de
  -- datos. Dos pedidos que llegan en el mismo milisegundo se serializan solos
  -- y el segundo recibe el error 23P01 (exclusion_violation). Aunque el
  -- código de arriba tuviera un bug, la doble reserva no se puede guardar.
  --
  -- Es el equivalente del LockService de Apps Script, un escalón más abajo:
  -- allá el candado lo ponía yo alrededor de la escritura; acá la regla vive
  -- en el dato mismo y no hay forma de saltearla.
  -- ==========================================================================
  CONSTRAINT turnos_sin_solape EXCLUDE USING gist (
    barbero_id WITH =,
    franja     WITH &&
  ) WHERE (estado <> 'cancelado')
);

CREATE INDEX IF NOT EXISTS turnos_franja      ON turnos USING gist (franja);
CREATE INDEX IF NOT EXISTS turnos_email       ON turnos (lower(cliente_email));
CREATE INDEX IF NOT EXISTS turnos_barbero_est ON turnos (barbero_id, estado);

-- ---------------------------------------------------------------------------
-- Panel del dueño
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_usuarios (
  id            serial PRIMARY KEY,
  usuario       text NOT NULL UNIQUE,
  hash_password text NOT NULL,          -- bcrypt. Nunca la contraseña en claro.
  creado_en     timestamptz NOT NULL DEFAULT now()
);

-- Sesiones en la base y no en un JWT firmado, a propósito: así el dueño puede
-- cerrar sesión de verdad y se puede revocar el acceso desde el servidor.
-- Un token que solo se valida por firma no se puede matar antes de que expire.
CREATE TABLE IF NOT EXISTS sesiones (
  token      text PRIMARY KEY,
  usuario_id int NOT NULL REFERENCES admin_usuarios(id) ON DELETE CASCADE,
  creada_en  timestamptz NOT NULL DEFAULT now(),
  expira_en  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sesiones_expira ON sesiones (expira_en);

-- Rastro de lo que pasa en el panel. Chico, pero es la diferencia entre
-- "se canceló solo" y "lo canceló el usuario X el martes a las 14:03".
CREATE TABLE IF NOT EXISTS auditoria (
  id        bigserial PRIMARY KEY,
  cuando    timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,      -- 'admin:hugo' | 'cliente:<token>' | 'sistema'
  accion    text NOT NULL,      -- 'crear_turno' | 'cancelar' | 'marcar_no_vino' ...
  turno_id  uuid,
  detalle   text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS auditoria_cuando ON auditoria (cuando DESC);

-- ============================================================
-- OBSTETRICARE — ESQUEMA DE BASE DE DATOS
-- PostgreSQL
-- ============================================================

-- ── EXTENSIONES ──
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLA: usuarios
-- Todos los tipos de usuario: obstetra, paciente, guardia, operador_ambulancia
-- ============================================================
CREATE TABLE usuarios (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  rol             VARCHAR(50) NOT NULL CHECK (rol IN ('obstetra', 'paciente', 'guardia', 'operador_ambulancia', 'admin')),
  nombre          VARCHAR(100) NOT NULL,
  apellido        VARCHAR(100) NOT NULL,
  telefono        VARCHAR(30),
  activo          BOOLEAN DEFAULT TRUE,
  creado_en       TIMESTAMP DEFAULT NOW(),
  actualizado_en  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: obstetras
-- Datos profesionales del obstetra (cliente que paga)
-- ============================================================
CREATE TABLE obstetras (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id      UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  matricula       VARCHAR(50) NOT NULL,
  especialidad    VARCHAR(100) DEFAULT 'Tocoginecología',
  provincia       VARCHAR(100) DEFAULT 'Santa Fe',
  consultorio     VARCHAR(255),
  creado_en       TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: suscripciones
-- Membresía mensual del obstetra
-- ============================================================
CREATE TABLE suscripciones (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  obstetra_id             UUID NOT NULL REFERENCES obstetras(id) ON DELETE CASCADE,
  estado                  VARCHAR(50) NOT NULL DEFAULT 'activa'
                          CHECK (estado IN ('activa', 'vencida', 'bloqueada', 'cancelada', 'periodo_gracia')),
  plan                    VARCHAR(50) NOT NULL DEFAULT 'estandar',
  precio_mensual          DECIMAL(10,2) NOT NULL DEFAULT 35000.00,
  mp_suscripcion_id       VARCHAR(255),          -- ID de suscripción en MercadoPago
  mp_preapproval_id       VARCHAR(255),          -- ID de preapproval en MercadoPago
  fecha_inicio            TIMESTAMP NOT NULL DEFAULT NOW(),
  fecha_proximo_cobro     TIMESTAMP,
  fecha_vencimiento       TIMESTAMP,
  fecha_bloqueo           TIMESTAMP,             -- cuándo se bloqueará si no paga
  intentos_cobro_fallido  INTEGER DEFAULT 0,
  primer_mes_descuento    BOOLEAN DEFAULT TRUE,
  creado_en               TIMESTAMP DEFAULT NOW(),
  actualizado_en          TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: pagos
-- Registro de cada cobro (exitoso o fallido)
-- ============================================================
CREATE TABLE pagos (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  suscripcion_id  UUID NOT NULL REFERENCES suscripciones(id),
  obstetra_id     UUID NOT NULL REFERENCES obstetras(id),
  mp_payment_id   VARCHAR(255),                  -- ID del pago en MercadoPago
  tipo            VARCHAR(50) CHECK (tipo IN ('suscripcion', 'consulta_extra')),
  monto           DECIMAL(10,2) NOT NULL,
  estado          VARCHAR(50) CHECK (estado IN ('aprobado', 'rechazado', 'pendiente', 'reembolsado')),
  detalle         TEXT,
  creado_en       TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: pacientes
-- Paciente registrada por un obstetra
-- ============================================================
CREATE TABLE pacientes (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id          UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  obstetra_id         UUID NOT NULL REFERENCES obstetras(id),
  semanas_gestacion   INTEGER CHECK (semanas_gestacion BETWEEN 4 AND 42),
  tipo_embarazo       VARCHAR(50) CHECK (tipo_embarazo IN ('único', 'gemelar', 'múltiple')),
  fecha_ultima_menst  DATE,
  antecedentes        TEXT[],                    -- array: ['hta', 'preeclampsia', 'dppni', ...]
  obstetra_nombre     VARCHAR(255),              -- nombre del obstetra personal (puede ser diferente)
  mp_customer_id      VARCHAR(255),              -- ID de cliente en MercadoPago (para cobro extra)
  mp_card_token       VARCHAR(255),              -- token de tarjeta guardada
  activa              BOOLEAN DEFAULT TRUE,
  creado_en           TIMESTAMP DEFAULT NOW(),
  actualizado_en      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: consultas_guardia
-- Cada evento de triage / teleconsulta
-- ============================================================
CREATE TABLE consultas_guardia (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  paciente_id         UUID NOT NULL REFERENCES pacientes(id),
  obstetra_id         UUID NOT NULL REFERENCES obstetras(id),   -- obstetra personal
  medico_guardia_id   UUID REFERENCES usuarios(id),             -- quien atendió (puede ser NULL si no hubo teleconsulta)
  sintoma_principal   VARCHAR(100) NOT NULL,
  respuestas_triage   JSONB NOT NULL,                           -- todas las respuestas del triage
  nivel_riesgo        VARCHAR(20) CHECK (nivel_riesgo IN ('bajo', 'medio', 'alto')),
  decision_guardia    VARCHAR(50) CHECK (decision_guardia IN ('sin_urgencia', 'derivar_guardia', 'ambulancia', 'pendiente')),
  justificacion       TEXT,
  es_nocturna         BOOLEAN DEFAULT FALSE,                    -- entre 00:00 y 06:00
  es_extra            BOOLEAN DEFAULT FALSE,                    -- si superó el tope de 3 incluidas
  monto_cobrado       DECIMAL(10,2) DEFAULT 0,                  -- 0 si estaba incluida
  pago_id             UUID REFERENCES pagos(id),
  estado              VARCHAR(50) DEFAULT 'triage_completado'
                      CHECK (estado IN ('triage_completado', 'teleconsulta_iniciada', 'teleconsulta_finalizada', 'cerrada')),
  inicio_teleconsulta TIMESTAMP,
  fin_teleconsulta    TIMESTAMP,
  ambulancia_activada BOOLEAN DEFAULT FALSE,
  creado_en           TIMESTAMP DEFAULT NOW(),
  actualizado_en      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: conteo_consultas_mensuales
-- Controla cuántas consultas usó cada paciente este mes
-- ============================================================
CREATE TABLE conteo_consultas_mensuales (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  paciente_id     UUID NOT NULL REFERENCES pacientes(id),
  anio            INTEGER NOT NULL,
  mes             INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  total_consultas INTEGER DEFAULT 0,
  UNIQUE (paciente_id, anio, mes)
);

-- ============================================================
-- TABLA: medicos_guardia
-- Datos adicionales de los médicos que hacen guardia
-- ============================================================
CREATE TABLE medicos_guardia (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id      UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  matricula       VARCHAR(50) NOT NULL,
  disponible      BOOLEAN DEFAULT FALSE,
  mp_alias        VARCHAR(255),                  -- alias de MercadoPago para recibir pagos
  total_consultas INTEGER DEFAULT 0,
  total_cobrado   DECIMAL(10,2) DEFAULT 0,
  creado_en       TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: pagos_medico_guardia
-- Lo que se le paga a cada médico por consulta
-- ============================================================
CREATE TABLE pagos_medico_guardia (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  medico_guardia_id UUID NOT NULL REFERENCES medicos_guardia(id),
  consulta_id       UUID NOT NULL REFERENCES consultas_guardia(id),
  monto             DECIMAL(10,2) NOT NULL,       -- $7.500 diurna / $8.500 nocturna
  es_nocturna       BOOLEAN DEFAULT FALSE,
  estado            VARCHAR(50) DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagado', 'error')),
  mp_transfer_id    VARCHAR(255),
  creado_en         TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: ambulancias
-- Solicitudes de ambulancia
-- ============================================================
CREATE TABLE ambulancias (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  consulta_id         UUID NOT NULL REFERENCES consultas_guardia(id),
  paciente_id         UUID NOT NULL REFERENCES pacientes(id),
  medico_guardia_id   UUID NOT NULL REFERENCES usuarios(id),
  direccion           VARCHAR(255) NOT NULL,
  destino             VARCHAR(255),
  empresa_nombre      VARCHAR(255),
  unidad              VARCHAR(100),
  paramedico_nombre   VARCHAR(255),
  estado              VARCHAR(50) DEFAULT 'solicitada'
                      CHECK (estado IN ('solicitada', 'confirmada', 'en_camino', 'llegada', 'traslado', 'finalizada')),
  eta_minutos         INTEGER,
  justificacion       TEXT NOT NULL,
  creado_en           TIMESTAMP DEFAULT NOW(),
  actualizado_en      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: notificaciones
-- Push notifications y avisos internos
-- ============================================================
CREATE TABLE notificaciones (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id      UUID NOT NULL REFERENCES usuarios(id),
  tipo            VARCHAR(100) NOT NULL,          -- 'nueva_consulta', 'pago_fallido', 'ambulancia', etc.
  titulo          VARCHAR(255) NOT NULL,
  cuerpo          TEXT,
  leida           BOOLEAN DEFAULT FALSE,
  push_enviada    BOOLEAN DEFAULT FALSE,
  referencia_id   UUID,                           -- ID de consulta, pago, etc.
  creado_en       TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: push_tokens
-- Tokens de dispositivo para notificaciones push
-- ============================================================
CREATE TABLE push_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token       VARCHAR(500) NOT NULL,
  plataforma  VARCHAR(20) CHECK (plataforma IN ('ios', 'android', 'web')),
  activo      BOOLEAN DEFAULT TRUE,
  creado_en   TIMESTAMP DEFAULT NOW(),
  UNIQUE (usuario_id, token)
);

-- ============================================================
-- ÍNDICES para performance
-- ============================================================
CREATE INDEX idx_pacientes_obstetra     ON pacientes(obstetra_id);
CREATE INDEX idx_consultas_paciente     ON consultas_guardia(paciente_id);
CREATE INDEX idx_consultas_obstetra     ON consultas_guardia(obstetra_id);
CREATE INDEX idx_consultas_guardia      ON consultas_guardia(medico_guardia_id);
CREATE INDEX idx_consultas_estado       ON consultas_guardia(estado);
CREATE INDEX idx_consultas_creado       ON consultas_guardia(creado_en DESC);
CREATE INDEX idx_suscripciones_estado   ON suscripciones(estado);
CREATE INDEX idx_notificaciones_usuario ON notificaciones(usuario_id, leida);
CREATE INDEX idx_conteo_paciente_mes    ON conteo_consultas_mensuales(paciente_id, anio, mes);

-- ============================================================
-- FUNCIÓN: detectar si una consulta es nocturna (00:00–06:00)
-- ============================================================
CREATE OR REPLACE FUNCTION es_consulta_nocturna(ts TIMESTAMP)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXTRACT(HOUR FROM ts) < 6;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- FUNCIÓN: verificar si una consulta es extra (supera el tope de 3)
-- ============================================================
CREATE OR REPLACE FUNCTION es_consulta_extra(p_paciente_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  total INTEGER;
BEGIN
  SELECT COALESCE(total_consultas, 0) INTO total
  FROM conteo_consultas_mensuales
  WHERE paciente_id = p_paciente_id
    AND anio = EXTRACT(YEAR FROM NOW())
    AND mes  = EXTRACT(MONTH FROM NOW());
  RETURN total >= 3;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNCIÓN: calcular monto de consulta extra
-- ============================================================
CREATE OR REPLACE FUNCTION calcular_monto_consulta(es_nocturna BOOLEAN)
RETURNS DECIMAL AS $$
BEGIN
  IF es_nocturna THEN
    RETURN 12000.00;  -- nocturna extra
  ELSE
    RETURN 10000.00;  -- diurna extra
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- FUNCIÓN: calcular honorario del médico de guardia
-- ============================================================
CREATE OR REPLACE FUNCTION calcular_honorario_medico(es_nocturna BOOLEAN)
RETURNS DECIMAL AS $$
BEGIN
  IF es_nocturna THEN
    RETURN 8500.00;   -- nocturna
  ELSE
    RETURN 7500.00;   -- diurna
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- TRIGGER: actualizar timestamp automáticamente
-- ============================================================
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.actualizado_en = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_usuarios_ts       BEFORE UPDATE ON usuarios       FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_suscripciones_ts  BEFORE UPDATE ON suscripciones  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_pacientes_ts      BEFORE UPDATE ON pacientes       FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_consultas_ts      BEFORE UPDATE ON consultas_guardia FOR EACH ROW EXECUTE FUNCTION update_timestamp();
CREATE TRIGGER trg_ambulancias_ts    BEFORE UPDATE ON ambulancias     FOR EACH ROW EXECUTE FUNCTION update_timestamp();

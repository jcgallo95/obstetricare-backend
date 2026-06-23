const db = require('../../config/db');
const { enviarNotificacion } = require('../services/notificaciones');
const { cobrarConsultaExtra } = require('../services/pagos');

const HORA_INICIO_NOCTURNA = parseInt(process.env.HORA_INICIO_NOCTURNA) || 0;
const HORA_FIN_NOCTURNA    = parseInt(process.env.HORA_FIN_NOCTURNA)    || 6;
const CONSULTAS_INCLUIDAS   = parseInt(process.env.CONSULTAS_INCLUIDAS_MES) || 3;

function esNocturna() {
  const hora = new Date().getHours();
  return hora >= HORA_INICIO_NOCTURNA && hora < HORA_FIN_NOCTURNA;
}

// ── POST /consultas/iniciar ──
// La paciente completa el triage y quiere iniciar consulta
async function iniciarConsulta(req, res) {
  const { sintoma_principal, respuestas_triage, nivel_riesgo } = req.body;
  if (!sintoma_principal || !respuestas_triage || !nivel_riesgo) {
    return res.status(400).json({ error: 'Faltan datos del triage' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Obtener datos de la paciente
    const { rows: [paciente] } = await client.query(
      'SELECT id, obstetra_id FROM pacientes WHERE usuario_id = $1 AND activa = TRUE',
      [req.usuario.id]
    );
    if (!paciente) return res.status(404).json({ error: 'Paciente no encontrada' });

    const anio = new Date().getFullYear();
    const mes  = new Date().getMonth() + 1;
    const nocturna = esNocturna();

    // Obtener o crear conteo mensual
    await client.query(
      `INSERT INTO conteo_consultas_mensuales (paciente_id, anio, mes, total_consultas)
       VALUES ($1, $2, $3, 0) ON CONFLICT (paciente_id, anio, mes) DO NOTHING`,
      [paciente.id, anio, mes]
    );
    const { rows: [conteo] } = await client.query(
      'SELECT total_consultas FROM conteo_consultas_mensuales WHERE paciente_id=$1 AND anio=$2 AND mes=$3',
      [paciente.id, anio, mes]
    );
    const esExtra = conteo.total_consultas >= CONSULTAS_INCLUIDAS;
    let montoConsulta = 0;
    let pagoId = null;

    // Si es extra, cobrar antes de continuar
    if (esExtra) {
      const monto = nocturna
        ? parseFloat(process.env.PRECIO_CONSULTA_EXTRA_NOCTURNA) || 12000
        : parseFloat(process.env.PRECIO_CONSULTA_EXTRA_DIURNA)   || 10000;
      const resultadoPago = await cobrarConsultaExtra(paciente.id, monto, nocturna);
      if (!resultadoPago.exitoso) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: 'No se pudo procesar el pago',
          detalle: resultadoPago.error,
          codigo: 'PAGO_FALLIDO'
        });
      }
      montoConsulta = monto;
      // Registrar pago
      const { rows: [pago] } = await client.query(
        `INSERT INTO pagos (suscripcion_id, obstetra_id, mp_payment_id, tipo, monto, estado)
         SELECT s.id, $1, $2, 'consulta_extra', $3, 'aprobado'
         FROM suscripciones s JOIN obstetras o ON o.id = s.obstetra_id
         WHERE o.id = $1 ORDER BY s.creado_en DESC LIMIT 1
         RETURNING id`,
        [paciente.obstetra_id, resultadoPago.payment_id, monto]
      );
      pagoId = pago?.id || null;
    }

    // Crear la consulta
    const { rows: [consulta] } = await client.query(
      `INSERT INTO consultas_guardia
         (paciente_id, obstetra_id, sintoma_principal, respuestas_triage, nivel_riesgo,
          es_nocturna, es_extra, monto_cobrado, pago_id, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'triage_completado')
       RETURNING id, creado_en`,
      [paciente.id, paciente.obstetra_id, sintoma_principal,
       JSON.stringify(respuestas_triage), nivel_riesgo,
       nocturna, esExtra, montoConsulta, pagoId]
    );

    // Actualizar conteo mensual
    await client.query(
      `UPDATE conteo_consultas_mensuales
       SET total_consultas = total_consultas + 1
       WHERE paciente_id = $1 AND anio = $2 AND mes = $3`,
      [paciente.id, anio, mes]
    );

    // Notificar al médico de guardia disponible si el riesgo es medio o alto
    if (['medio', 'alto'].includes(nivel_riesgo)) {
      await notificarMedicosGuardia(consulta.id, nivel_riesgo, req.usuario, nocturna, client);
    }

    // Notificar al obstetra personal
    await enviarNotificacion(paciente.obstetra_id, 'nueva_consulta', {
      titulo: `Consulta de ${req.usuario.nombre} ${req.usuario.apellido}`,
      cuerpo: `Nivel: ${nivel_riesgo} · Síntoma: ${sintoma_principal}`,
      referencia_id: consulta.id
    }, client);

    await client.query('COMMIT');
    res.status(201).json({
      consulta_id: consulta.id,
      es_extra: esExtra,
      monto_cobrado: montoConsulta,
      es_nocturna: nocturna,
      mensaje: esExtra
        ? `Consulta procesada. Se cobró $${montoConsulta.toLocaleString('es-AR')}.`
        : 'Consulta iniciada. Incluida en tu plan mensual.'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en iniciarConsulta:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
}

// ── Notificar médicos de guardia disponibles ──
async function notificarMedicosGuardia(consultaId, nivelRiesgo, paciente, nocturna, client) {
  const { rows: medicos } = await client.query(
    `SELECT u.id FROM medicos_guardia mg
     JOIN usuarios u ON u.id = mg.usuario_id
     WHERE mg.disponible = TRUE AND u.activo = TRUE
     LIMIT 5`
  );
  const urgente = nivelRiesgo === 'alto';
  for (const medico of medicos) {
    await client.query(
      `INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, referencia_id)
       VALUES ($1, 'nueva_consulta', $2, $3, $4)`,
      [medico.id,
       urgente ? '🚨 URGENCIA — Nueva consulta' : '⚠️ Nueva consulta requiere evaluación',
       `${paciente.nombre} ${paciente.apellido} · ${nocturna ? 'Nocturna' : 'Diurna'}`,
       consultaId]
    );
  }
}

// ── GET /consultas/mis-consultas ──
// Historial de consultas de la paciente
async function misConsultas(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.sintoma_principal, c.nivel_riesgo, c.decision_guardia,
              c.es_nocturna, c.es_extra, c.monto_cobrado, c.estado, c.creado_en,
              u.nombre AS medico_nombre, u.apellido AS medico_apellido
       FROM consultas_guardia c
       JOIN pacientes p ON p.id = c.paciente_id
       LEFT JOIN usuarios u ON u.id = c.medico_guardia_id
       WHERE p.usuario_id = $1
       ORDER BY c.creado_en DESC
       LIMIT 50`,
      [req.usuario.id]
    );
    res.json({ consultas: rows });
  } catch (err) {
    console.error('Error en misConsultas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── GET /consultas/activas — para el médico de guardia ──
async function consultasActivas(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.sintoma_principal, c.nivel_riesgo, c.es_nocturna, c.creado_en,
              u.nombre AS paciente_nombre, u.apellido AS paciente_apellido,
              p.semanas_gestacion, p.tipo_embarazo, p.antecedentes,
              ob.nombre AS obstetra_nombre, ob.apellido AS obstetra_apellido
       FROM consultas_guardia c
       JOIN pacientes p ON p.id = c.paciente_id
       JOIN usuarios u ON u.id = p.usuario_id
       JOIN obstetras o ON o.id = c.obstetra_id
       JOIN usuarios ob ON ob.id = o.usuario_id
       WHERE c.estado IN ('triage_completado', 'teleconsulta_iniciada')
         AND c.nivel_riesgo IN ('medio', 'alto')
       ORDER BY
         CASE c.nivel_riesgo WHEN 'alto' THEN 0 ELSE 1 END,
         c.creado_en ASC`,
      []
    );
    res.json({ consultas: rows });
  } catch (err) {
    console.error('Error en consultasActivas:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── POST /consultas/:id/decision ──
// El médico de guardia registra su decisión
async function registrarDecision(req, res) {
  const { id } = req.params;
  const { decision, justificacion } = req.body;
  const decisiones = ['sin_urgencia', 'derivar_guardia', 'ambulancia'];
  if (!decisiones.includes(decision)) {
    return res.status(400).json({ error: 'Decisión inválida' });
  }
  if (decision === 'ambulancia' && (!justificacion || justificacion.length < 10)) {
    return res.status(400).json({ error: 'La justificación es obligatoria para activar una ambulancia' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows: [consulta] } = await client.query(
      'SELECT * FROM consultas_guardia WHERE id = $1',
      [id]
    );
    if (!consulta) return res.status(404).json({ error: 'Consulta no encontrada' });

    // Actualizar consulta
    await client.query(
      `UPDATE consultas_guardia
       SET decision_guardia = $1, justificacion = $2,
           medico_guardia_id = $3, estado = 'teleconsulta_finalizada',
           fin_teleconsulta = NOW()
       WHERE id = $4`,
      [decision, justificacion || null, req.usuario.id, id]
    );

    // Registrar honorario del médico
    const honorario = consulta.es_nocturna
      ? parseFloat(process.env.HONORARIO_MEDICO_NOCTURNO) || 8500
      : parseFloat(process.env.HONORARIO_MEDICO_DIURNO)   || 7500;

    const { rows: [medico] } = await client.query(
      'SELECT id FROM medicos_guardia WHERE usuario_id = $1', [req.usuario.id]
    );
    if (medico) {
      await client.query(
        `INSERT INTO pagos_medico_guardia (medico_guardia_id, consulta_id, monto, es_nocturna, estado)
         VALUES ($1, $2, $3, $4, 'pendiente')`,
        [medico.id, id, honorario, consulta.es_nocturna]
      );
      await client.query(
        'UPDATE medicos_guardia SET total_consultas = total_consultas + 1 WHERE id = $1',
        [medico.id]
      );
    }

    // Si activó ambulancia, crear registro
    if (decision === 'ambulancia') {
      const { body } = req;
      await client.query(
        `INSERT INTO ambulancias (consulta_id, paciente_id, medico_guardia_id, direccion, destino, justificacion)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, consulta.paciente_id, req.usuario.id,
         body.direccion || 'No especificada', body.destino || 'Hospital más cercano', justificacion]
      );
    }

    // Notificar a la paciente y al obstetra personal
    const decLabels = { sin_urgencia: 'Sin urgencia', derivar_guardia: 'Derivada a guardia', ambulancia: 'Ambulancia activada' };
    await enviarNotificacion(consulta.paciente_id, 'decision_guardia', {
      titulo: decLabels[decision],
      cuerpo: justificacion || 'El médico de guardia revisó tu caso.',
      referencia_id: id
    }, client, true); // true = es paciente (buscar por paciente_id, no usuario_id)

    await enviarNotificacion(consulta.obstetra_id, 'decision_guardia_obstetra', {
      titulo: `Decisión: ${decLabels[decision]}`,
      cuerpo: justificacion || '',
      referencia_id: id
    }, client);

    await client.query('COMMIT');
    res.json({ mensaje: 'Decisión registrada correctamente', decision, honorario });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en registrarDecision:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
}

// ── GET /consultas/pacientes-obstetra — panel del obstetra ──
async function consultasPorObstetra(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.sintoma_principal, c.nivel_riesgo, c.decision_guardia,
              c.es_nocturna, c.estado, c.creado_en,
              u.nombre, u.apellido, p.semanas_gestacion
       FROM consultas_guardia c
       JOIN pacientes p ON p.id = c.paciente_id
       JOIN usuarios u ON u.id = p.usuario_id
       JOIN obstetras o ON o.id = c.obstetra_id
       WHERE o.usuario_id = $1
       ORDER BY c.creado_en DESC
       LIMIT 100`,
      [req.usuario.id]
    );
    res.json({ consultas: rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { iniciarConsulta, misConsultas, consultasActivas, registrarDecision, consultasPorObstetra };

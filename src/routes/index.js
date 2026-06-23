const express = require('express');
const router  = express.Router();
const { verificarToken, soloRol, suscripcionActiva } = require('../middleware/auth');
const authCtrl      = require('../controllers/authController');
const consultasCtrl = require('../controllers/consultasController');
const webhookCtrl   = require('../controllers/webhookController');
const db            = require('../../config/db');
const { obtenerNotificaciones, marcarLeidas } = require('../services/notificaciones');

// ══════════════════════════════════════
// AUTH
// ══════════════════════════════════════
router.post('/auth/registro-obstetra',  authCtrl.registroObstetra);
router.post('/auth/registro-paciente',  authCtrl.registroPaciente);
router.post('/auth/login',              authCtrl.login);

// ══════════════════════════════════════
// PERFIL (cualquier usuario autenticado)
// ══════════════════════════════════════
router.get('/perfil', verificarToken, async (req, res) => {
  try {
    const { rows: [usuario] } = await db.query(
      'SELECT id, email, rol, nombre, apellido, telefono, creado_en FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );
    let extra = {};
    if (usuario.rol === 'obstetra') {
      const { rows: [obs] } = await db.query(
        `SELECT o.id, o.matricula, o.consultorio, s.estado, s.precio_mensual,
                s.fecha_proximo_cobro, s.fecha_bloqueo, s.primer_mes_descuento
         FROM obstetras o
         LEFT JOIN suscripciones s ON s.obstetra_id = o.id
         WHERE o.usuario_id = $1 ORDER BY s.creado_en DESC LIMIT 1`,
        [usuario.id]
      );
      extra = { obstetra: obs };
    } else if (usuario.rol === 'paciente') {
      const { rows: [pac] } = await db.query(
        `SELECT p.id, p.semanas_gestacion, p.tipo_embarazo, p.antecedentes,
                p.obstetra_nombre,
                COALESCE(c.total_consultas, 0) AS consultas_este_mes
         FROM pacientes p
         LEFT JOIN conteo_consultas_mensuales c
           ON c.paciente_id = p.id
           AND c.anio = EXTRACT(YEAR FROM NOW())
           AND c.mes  = EXTRACT(MONTH FROM NOW())
         WHERE p.usuario_id = $1`,
        [usuario.id]
      );
      extra = { paciente: pac };
    }
    res.json({ ...usuario, ...extra });
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ══════════════════════════════════════
// PACIENTES — gestión por el obstetra
// ══════════════════════════════════════

// Listar mis pacientes
router.get('/pacientes',
  verificarToken, soloRol('obstetra'), suscripcionActiva,
  async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT p.id, u.nombre, u.apellido, u.email,
                p.semanas_gestacion, p.tipo_embarazo, p.antecedentes,
                p.activa, p.creado_en,
                COALESCE(c.total_consultas, 0) AS consultas_este_mes
         FROM pacientes p
         JOIN usuarios u ON u.id = p.usuario_id
         JOIN obstetras o ON o.id = p.obstetra_id
         LEFT JOIN conteo_consultas_mensuales c
           ON c.paciente_id = p.id
           AND c.anio = EXTRACT(YEAR FROM NOW())
           AND c.mes  = EXTRACT(MONTH FROM NOW())
         WHERE o.usuario_id = $1
         ORDER BY u.apellido, u.nombre`,
        [req.usuario.id]
      );
      res.json({ pacientes: rows });
    } catch (err) {
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Actualizar datos obstétricos de una paciente
router.patch('/pacientes/:id',
  verificarToken, soloRol('obstetra'), suscripcionActiva,
  async (req, res) => {
    const { semanas_gestacion, tipo_embarazo, antecedentes } = req.body;
    try {
      await db.query(
        `UPDATE pacientes
         SET semanas_gestacion = COALESCE($1, semanas_gestacion),
             tipo_embarazo     = COALESCE($2, tipo_embarazo),
             antecedentes      = COALESCE($3, antecedentes)
         WHERE id = $4`,
        [semanas_gestacion, tipo_embarazo, antecedentes, req.params.id]
      );
      res.json({ mensaje: 'Paciente actualizada' });
    } catch (err) {
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ══════════════════════════════════════
// CONSULTAS
// ══════════════════════════════════════

// Iniciar consulta (paciente)
router.post('/consultas/iniciar',
  verificarToken, soloRol('paciente'),
  consultasCtrl.iniciarConsulta
);

// Historial de consultas (paciente)
router.get('/consultas/mis-consultas',
  verificarToken, soloRol('paciente'),
  consultasCtrl.misConsultas
);

// Consultas activas (médico de guardia)
router.get('/consultas/activas',
  verificarToken, soloRol('guardia'),
  consultasCtrl.consultasActivas
);

// Consultas de mis pacientes (obstetra personal)
router.get('/consultas/mis-pacientes',
  verificarToken, soloRol('obstetra'), suscripcionActiva,
  consultasCtrl.consultasPorObstetra
);

// Registrar decisión (médico de guardia)
router.post('/consultas/:id/decision',
  verificarToken, soloRol('guardia'),
  consultasCtrl.registrarDecision
);

// Detalle de una consulta
router.get('/consultas/:id',
  verificarToken,
  async (req, res) => {
    try {
      const { rows: [c] } = await db.query(
        `SELECT c.*,
                u.nombre AS paciente_nombre, u.apellido AS paciente_apellido,
                p.semanas_gestacion, p.tipo_embarazo, p.antecedentes,
                ug.nombre AS medico_nombre, ug.apellido AS medico_apellido
         FROM consultas_guardia c
         JOIN pacientes p ON p.id = c.paciente_id
         JOIN usuarios u ON u.id = p.usuario_id
         LEFT JOIN usuarios ug ON ug.id = c.medico_guardia_id
         WHERE c.id = $1`,
        [req.params.id]
      );
      if (!c) return res.status(404).json({ error: 'Consulta no encontrada' });
      res.json(c);
    } catch (err) {
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ══════════════════════════════════════
// AMBULANCIAS
// ══════════════════════════════════════

// Actualizar estado de ambulancia (operador)
router.patch('/ambulancias/:id/estado',
  verificarToken, soloRol('operador_ambulancia'),
  async (req, res) => {
    const estados = ['confirmada', 'en_camino', 'llegada', 'traslado', 'finalizada'];
    const { estado, unidad, paramedico_nombre, eta_minutos } = req.body;
    if (!estados.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    try {
      await db.query(
        `UPDATE ambulancias
         SET estado = $1,
             unidad = COALESCE($2, unidad),
             paramedico_nombre = COALESCE($3, paramedico_nombre),
             eta_minutos = COALESCE($4, eta_minutos),
             actualizado_en = NOW()
         WHERE id = $5`,
        [estado, unidad, paramedico_nombre, eta_minutos, req.params.id]
      );
      res.json({ mensaje: 'Estado actualizado', estado });
    } catch (err) {
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ══════════════════════════════════════
// SUSCRIPCIONES
// ══════════════════════════════════════

// Estado de suscripción del obstetra
router.get('/suscripcion',
  verificarToken, soloRol('obstetra'),
  async (req, res) => {
    try {
      const { rows: [sub] } = await db.query(
        `SELECT s.* FROM suscripciones s
         JOIN obstetras o ON o.id = s.obstetra_id
         WHERE o.usuario_id = $1
         ORDER BY s.creado_en DESC LIMIT 1`,
        [req.usuario.id]
      );
      res.json(sub || { estado: 'sin_suscripcion' });
    } catch (err) {
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ══════════════════════════════════════
// NOTIFICACIONES
// ══════════════════════════════════════

router.get('/notificaciones',
  verificarToken,
  async (req, res) => {
    const notifs = await obtenerNotificaciones(req.usuario.id, db);
    res.json({ notificaciones: notifs });
  }
);

router.post('/notificaciones/leer',
  verificarToken,
  async (req, res) => {
    await marcarLeidas(req.usuario.id, db);
    res.json({ mensaje: 'Notificaciones marcadas como leídas' });
  }
);

// Registrar token de push
router.post('/notificaciones/token',
  verificarToken,
  async (req, res) => {
    const { token, plataforma } = req.body;
    if (!token) return res.status(400).json({ error: 'Token requerido' });
    try {
      await db.query(
        `INSERT INTO push_tokens (usuario_id, token, plataforma)
         VALUES ($1, $2, $3)
         ON CONFLICT (usuario_id, token) DO UPDATE SET activo = TRUE`,
        [req.usuario.id, JSON.stringify(token), plataforma || 'web']
      );
      res.json({ mensaje: 'Token registrado' });
    } catch (err) {
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ══════════════════════════════════════
// WEBHOOK MERCADOPAGO
// ══════════════════════════════════════
router.post('/webhooks/mercadopago', webhookCtrl.webhookMP);

module.exports = router;

const jwt = require('jsonwebtoken');
const db  = require('../../config/db');

// ── Verificar token JWT ──
async function verificarToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Verificar que el usuario siga activo
    const { rows } = await db.query(
      'SELECT id, rol, nombre, apellido, activo FROM usuarios WHERE id = $1',
      [decoded.id]
    );
    if (!rows.length || !rows[0].activo) {
      return res.status(401).json({ error: 'Usuario inactivo o no encontrado' });
    }
    req.usuario = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ── Verificar rol ──
function soloRol(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'Acceso denegado para este rol' });
    }
    next();
  };
}

// ── Verificar suscripción activa del obstetra ──
async function suscripcionActiva(req, res, next) {
  if (req.usuario.rol !== 'obstetra') return next();
  const { rows } = await db.query(
    `SELECT s.estado FROM suscripciones s
     JOIN obstetras o ON o.id = s.obstetra_id
     WHERE o.usuario_id = $1
     ORDER BY s.creado_en DESC LIMIT 1`,
    [req.usuario.id]
  );
  if (!rows.length || !['activa', 'periodo_gracia'].includes(rows[0].estado)) {
    return res.status(402).json({
      error: 'Suscripción inactiva',
      codigo: 'SUSCRIPCION_BLOQUEADA',
      mensaje: 'Tu suscripción está bloqueada. Por favor regularizá tu pago para continuar.'
    });
  }
  next();
}

module.exports = { verificarToken, soloRol, suscripcionActiva };

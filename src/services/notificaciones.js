const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Enviar notificación a un usuario ──
async function enviarNotificacion(usuarioOId, tipo, { titulo, cuerpo, referencia_id }, dbClient, esPaciente = false) {
  const db = dbClient || require('../../config/db');
  try {
    let usuarioId = usuarioOId;

    // Si es paciente, necesitamos el usuario_id desde el paciente_id
    if (esPaciente) {
      const { rows } = await db.query('SELECT usuario_id FROM pacientes WHERE id = $1', [usuarioOId]);
      if (rows.length) usuarioId = rows[0].usuario_id;
    }

    // Guardar notificación en la base de datos
    await db.query(
      `INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, referencia_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [usuarioId, tipo, titulo, cuerpo || '', referencia_id || null]
    );

    // Enviar push notification si hay token registrado
    const { rows: tokens } = await db.query(
      'SELECT token FROM push_tokens WHERE usuario_id = $1 AND activo = TRUE',
      [usuarioId]
    );

    for (const { token } of tokens) {
      try {
        await webpush.sendNotification(
          JSON.parse(token),
          JSON.stringify({ titulo, cuerpo, referencia_id, tipo })
        );
      } catch (pushErr) {
        if (pushErr.statusCode === 410) {
          // Token expirado, desactivar
          await db.query(
            'UPDATE push_tokens SET activo = FALSE WHERE token = $1',
            [token]
          );
        }
      }
    }
  } catch (err) {
    console.error('Error enviando notificación:', err);
  }
}

// ── GET notificaciones de un usuario ──
async function obtenerNotificaciones(usuarioId, db) {
  const { rows } = await db.query(
    `SELECT id, tipo, titulo, cuerpo, leida, referencia_id, creado_en
     FROM notificaciones
     WHERE usuario_id = $1
     ORDER BY creado_en DESC
     LIMIT 50`,
    [usuarioId]
  );
  return rows;
}

// ── Marcar notificaciones como leídas ──
async function marcarLeidas(usuarioId, db) {
  await db.query(
    'UPDATE notificaciones SET leida = TRUE WHERE usuario_id = $1 AND leida = FALSE',
    [usuarioId]
  );
}

module.exports = { enviarNotificacion, obtenerNotificaciones, marcarLeidas };

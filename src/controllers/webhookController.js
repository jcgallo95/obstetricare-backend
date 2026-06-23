const db = require('../../config/db');
const { enviarNotificacion } = require('../services/notificaciones');

const DIAS_GRACIA = parseInt(process.env.DIAS_GRACIA_PAGO) || 3;

// ── POST /webhooks/mercadopago ──
// MercadoPago llama a este endpoint automáticamente con cada evento de pago
async function webhookMP(req, res) {
  const { type, data } = req.body;
  // Responder rápido para que MP no reintente
  res.status(200).json({ recibido: true });

  try {
    if (type === 'payment') {
      await procesarPago(data.id);
    } else if (type === 'subscription_preapproval') {
      await procesarSuscripcion(data.id);
    }
  } catch (err) {
    console.error('Error procesando webhook MP:', err);
  }
}

// ── Procesar evento de pago ──
async function procesarPago(mpPaymentId) {
  // En producción: consultar la API de MP para verificar el pago
  // const mp = require('../services/mercadopago');
  // const pago = await mp.payment.findById(mpPaymentId);
  console.log(`Procesando pago MP: ${mpPaymentId}`);
}

// ── Procesar evento de suscripción ──
async function procesarSuscripcion(mpPreapprovalId) {
  const { rows } = await db.query(
    'SELECT * FROM suscripciones WHERE mp_preapproval_id = $1',
    [mpPreapprovalId]
  );
  if (!rows.length) return;
  const suscripcion = rows[0];

  // En producción: consultar MP para obtener el estado real
  // Por ahora simulamos los casos posibles
  const estadoMP = 'authorized'; // o 'pending', 'cancelled', 'paused'

  if (estadoMP === 'authorized') {
    await pagoExitoso(suscripcion);
  } else if (estadoMP === 'pending') {
    await pagoFallido(suscripcion);
  }
}

// ── Pago de suscripción exitoso ──
async function pagoExitoso(suscripcion) {
  const proximoCobro = new Date();
  proximoCobro.setMonth(proximoCobro.getMonth() + 1);

  await db.query(
    `UPDATE suscripciones
     SET estado = 'activa',
         intentos_cobro_fallido = 0,
         fecha_bloqueo = NULL,
         fecha_proximo_cobro = $1,
         actualizado_en = NOW()
     WHERE id = $2`,
    [proximoCobro, suscripcion.id]
  );

  // Registrar pago
  await db.query(
    `INSERT INTO pagos (suscripcion_id, obstetra_id, tipo, monto, estado)
     VALUES ($1, $2, 'suscripcion', $3, 'aprobado')`,
    [suscripcion.id, suscripcion.obstetra_id, suscripcion.precio_mensual]
  );

  // Si estaba bloqueada, notificar reactivación
  if (suscripcion.estado === 'bloqueada') {
    await enviarNotificacion(suscripcion.obstetra_id, 'suscripcion_reactivada', {
      titulo: '✅ Suscripción reactivada',
      cuerpo: 'Tu pago fue procesado correctamente. Tu cuenta está activa nuevamente.',
    });
  }

  console.log(`Pago exitoso para suscripción ${suscripcion.id}`);
}

// ── Pago de suscripción fallido ──
async function pagoFallido(suscripcion) {
  const intentos = (suscripcion.intentos_cobro_fallido || 0) + 1;
  const fechaBloqueo = new Date();
  fechaBloqueo.setDate(fechaBloqueo.getDate() + DIAS_GRACIA);

  let nuevoEstado = 'periodo_gracia';
  if (intentos >= 2) nuevoEstado = 'bloqueada'; // Bloqueada si ya pasaron los días de gracia

  await db.query(
    `UPDATE suscripciones
     SET estado = $1,
         intentos_cobro_fallido = $2,
         fecha_bloqueo = $3,
         actualizado_en = NOW()
     WHERE id = $4`,
    [nuevoEstado, intentos, intentos === 1 ? fechaBloqueo : suscripcion.fecha_bloqueo, suscripcion.id]
  );

  // Registrar pago fallido
  await db.query(
    `INSERT INTO pagos (suscripcion_id, obstetra_id, tipo, monto, estado, detalle)
     VALUES ($1, $2, 'suscripcion', $3, 'rechazado', 'Cobro automático fallido')`,
    [suscripcion.id, suscripcion.obstetra_id, suscripcion.precio_mensual]
  );

  if (nuevoEstado === 'periodo_gracia') {
    // Primera notificación: tenés 3 días
    await enviarNotificacion(suscripcion.obstetra_id, 'pago_fallido', {
      titulo: '⚠️ No pudimos procesar tu pago',
      cuerpo: `Tu pago mensual falló. Tenés ${DIAS_GRACIA} días para regularizarlo antes de que tu cuenta sea bloqueada.`,
    });
  } else {
    // Cuenta bloqueada
    await enviarNotificacion(suscripcion.obstetra_id, 'cuenta_bloqueada', {
      titulo: '🔒 Cuenta bloqueada',
      cuerpo: 'Tu cuenta fue bloqueada por falta de pago. Actualizá tu método de pago para reactivarla.',
    });
  }

  console.log(`Pago fallido para suscripción ${suscripcion.id}. Estado: ${nuevoEstado}`);
}

// ── Job diario: verificar suscripciones en período de gracia vencido ──
async function verificarBloqueosAutomaticos() {
  const { rows } = await db.query(
    `SELECT * FROM suscripciones
     WHERE estado = 'periodo_gracia'
       AND fecha_bloqueo <= NOW()`,
    []
  );
  for (const sub of rows) {
    await db.query(
      `UPDATE suscripciones SET estado = 'bloqueada', actualizado_en = NOW() WHERE id = $1`,
      [sub.id]
    );
    await enviarNotificacion(sub.obstetra_id, 'cuenta_bloqueada', {
      titulo: '🔒 Cuenta bloqueada por falta de pago',
      cuerpo: 'Actualizá tu método de pago en la app para reactivar tu cuenta.',
    });
    console.log(`Cuenta bloqueada automáticamente: suscripción ${sub.id}`);
  }
}

module.exports = { webhookMP, verificarBloqueosAutomaticos };

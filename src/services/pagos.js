// ── Servicio de pagos — MercadoPago ──
// En producción se conecta a la API real de MP

// ── Cobrar consulta extra a la paciente (tarjeta guardada) ──
async function cobrarConsultaExtra(pacienteId, monto, esNocturna) {
  const db = require('../../config/db');
  try {
    // Obtener token de tarjeta guardada
    const { rows } = await db.query(
      'SELECT mp_customer_id, mp_card_token FROM pacientes WHERE id = $1',
      [pacienteId]
    );
    if (!rows.length || !rows[0].mp_card_token) {
      return { exitoso: false, error: 'No hay tarjeta guardada para esta paciente' };
    }
    const { mp_customer_id, mp_card_token } = rows[0];

    // En producción: llamar a la API de MercadoPago
    // const mp = require('mercadopago');
    // const resultado = await mp.payment.create({
    //   transaction_amount: monto,
    //   token: mp_card_token,
    //   description: `ObstetriCare — Consulta ${esNocturna ? 'nocturna' : 'diurna'} extra`,
    //   payer: { type: 'customer', id: mp_customer_id },
    //   capture: true
    // });
    // if (resultado.body.status === 'approved') { ... }

    // SIMULACIÓN para desarrollo:
    console.log(`[PAGO SIMULADO] Cobrando $${monto} a paciente ${pacienteId} (${esNocturna ? 'nocturna' : 'diurna'})`);
    return {
      exitoso: true,
      payment_id: `SIM-${Date.now()}`,
      monto
    };
  } catch (err) {
    console.error('Error cobrando consulta extra:', err);
    return { exitoso: false, error: err.message };
  }
}

// ── Crear suscripción mensual para obstetra ──
async function crearSuscripcionMP(obstetrid, email, monto) {
  // En producción: llamar a MP Preapproval
  // const mp = require('mercadopago');
  // const suscripcion = await mp.preapproval.create({
  //   reason: 'ObstetriCare — Suscripción mensual',
  //   payer_email: email,
  //   auto_recurring: {
  //     frequency: 1,
  //     frequency_type: 'months',
  //     transaction_amount: monto,
  //     currency_id: 'ARS'
  //   },
  //   back_url: `${process.env.APP_URL}/suscripcion/confirmada`,
  //   status: 'pending'
  // });
  // return { id: suscripcion.body.id, init_point: suscripcion.body.init_point };

  // SIMULACIÓN para desarrollo:
  console.log(`[MP SIMULADO] Creando suscripción para obstetra ${obstetrid} — $${monto}/mes`);
  return {
    id: `PRESIM-${Date.now()}`,
    init_point: `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=SIM`
  };
}

// ── Guardar tarjeta de paciente ──
async function guardarTarjetaPaciente(pacienteId, cardToken, email) {
  const db = require('../../config/db');
  try {
    // En producción: crear customer en MP y guardar la tarjeta
    // const mp = require('mercadopago');
    // const customer = await mp.customers.create({ email });
    // const card = await mp.cards.create({ customer_id: customer.body.id, token: cardToken });

    const mpCustomerId = `CUSTSIM-${Date.now()}`;
    await db.query(
      'UPDATE pacientes SET mp_customer_id = $1, mp_card_token = $2 WHERE id = $3',
      [mpCustomerId, cardToken, pacienteId]
    );
    return { exitoso: true, customer_id: mpCustomerId };
  } catch (err) {
    return { exitoso: false, error: err.message };
  }
}

module.exports = { cobrarConsultaExtra, crearSuscripcionMP, guardarTarjetaPaciente };

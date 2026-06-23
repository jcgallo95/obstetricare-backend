const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../../config/db');

function generarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, rol: usuario.rol },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ── POST /auth/registro-obstetra ──
async function registroObstetra(req, res) {
  const { nombre, apellido, email, password, matricula, consultorio } = req.body;
  if (!nombre || !apellido || !email || !password || !matricula) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Verificar email único
    const existe = await client.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existe.rows.length) {
      return res.status(409).json({ error: 'El email ya está registrado' });
    }
    const hash = await bcrypt.hash(password, 12);
    // Crear usuario
    const { rows: [usuario] } = await client.query(
      `INSERT INTO usuarios (email, password_hash, rol, nombre, apellido)
       VALUES ($1, $2, 'obstetra', $3, $4) RETURNING id, email, rol, nombre, apellido`,
      [email, hash, nombre, apellido]
    );
    // Crear perfil obstetra
    const { rows: [obstetra] } = await client.query(
      `INSERT INTO obstetras (usuario_id, matricula, consultorio)
       VALUES ($1, $2, $3) RETURNING id`,
      [usuario.id, matricula, consultorio || null]
    );
    // Crear suscripción con primer mes de descuento
    const proximoCobro = new Date();
    proximoCobro.setMonth(proximoCobro.getMonth() + 1);
    await client.query(
      `INSERT INTO suscripciones (obstetra_id, estado, precio_mensual, fecha_proximo_cobro, primer_mes_descuento)
       VALUES ($1, 'activa', $2, $3, TRUE)`,
      [obstetra.id, parseFloat(process.env.PRECIO_PRIMER_MES) || 17500, proximoCobro]
    );
    await client.query('COMMIT');
    const token = generarToken(usuario);
    res.status(201).json({
      mensaje: 'Registro exitoso',
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre, apellido: usuario.apellido, email: usuario.email, rol: usuario.rol },
      obstetra_id: obstetra.id
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en registro obstetra:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
}

// ── POST /auth/registro-paciente ──
async function registroPaciente(req, res) {
  const { nombre, apellido, email, password, codigo_obstetra, semanas_gestacion, tipo_embarazo, antecedentes } = req.body;
  if (!nombre || !apellido || !email || !password || !codigo_obstetra) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Verificar código del obstetra (usamos el obstetra_id)
    const { rows: obstetras } = await client.query(
      'SELECT o.id, u.nombre, u.apellido FROM obstetras o JOIN usuarios u ON u.id = o.usuario_id WHERE o.id = $1',
      [codigo_obstetra]
    );
    if (!obstetras.length) {
      return res.status(404).json({ error: 'Código de obstetra inválido' });
    }
    const obstetra = obstetras[0];
    // Verificar email único
    const existe = await client.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existe.rows.length) {
      return res.status(409).json({ error: 'El email ya está registrado' });
    }
    const hash = await bcrypt.hash(password, 12);
    const { rows: [usuario] } = await client.query(
      `INSERT INTO usuarios (email, password_hash, rol, nombre, apellido)
       VALUES ($1, $2, 'paciente', $3, $4) RETURNING id, email, rol, nombre, apellido`,
      [email, hash, nombre, apellido]
    );
    await client.query(
      `INSERT INTO pacientes (usuario_id, obstetra_id, semanas_gestacion, tipo_embarazo, antecedentes, obstetra_nombre)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [usuario.id, obstetra.id, semanas_gestacion || null, tipo_embarazo || null,
       antecedentes || [], `${obstetra.nombre} ${obstetra.apellido}`]
    );
    await client.query('COMMIT');
    const token = generarToken(usuario);
    res.status(201).json({
      mensaje: 'Registro exitoso',
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre, apellido: usuario.apellido, email: usuario.email, rol: usuario.rol }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en registro paciente:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
}

// ── POST /auth/login ──
async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }
  try {
    const { rows } = await db.query(
      'SELECT id, email, password_hash, rol, nombre, apellido, activo FROM usuarios WHERE email = $1',
      [email.toLowerCase()]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const usuario = rows[0];
    if (!usuario.activo) {
      return res.status(403).json({ error: 'Cuenta inactiva. Contactá a soporte.' });
    }
    const valido = await bcrypt.compare(password, usuario.password_hash);
    if (!valido) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    // Si es obstetra, verificar suscripción
    let suscripcion = null;
    if (usuario.rol === 'obstetra') {
      const { rows: subs } = await db.query(
        `SELECT s.estado, s.fecha_proximo_cobro, s.fecha_bloqueo
         FROM suscripciones s JOIN obstetras o ON o.id = s.obstetra_id
         WHERE o.usuario_id = $1 ORDER BY s.creado_en DESC LIMIT 1`,
        [usuario.id]
      );
      suscripcion = subs[0] || null;
    }
    const token = generarToken(usuario);
    res.json({
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre, apellido: usuario.apellido, email: usuario.email, rol: usuario.rol },
      suscripcion
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { registroObstetra, registroPaciente, login };

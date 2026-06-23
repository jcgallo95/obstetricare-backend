require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const routes     = require('./routes');
const { verificarBloqueosAutomaticos } = require('./controllers/webhookController');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Seguridad ──
app.use(helmet());
app.use(cors({
  origin: [
    'https://jcgallo95.github.io',  // PWA en GitHub Pages
    'http://localhost:3000',         // desarrollo local
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting — evitar abuso ──
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: { error: 'Demasiadas solicitudes. Intentá de nuevo en 15 minutos.' }
});

// Rate limit más estricto para auth
app.use('/api/auth/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de login. Intentá de nuevo en 15 minutos.' }
}));

// ── Body parser ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rutas ──
app.use('/api', routes);

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'ObstetriCare Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ── Manejo de errores global ──
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ── Iniciar servidor ──
app.listen(PORT, () => {
  console.log(`✅ ObstetriCare Backend corriendo en puerto ${PORT}`);
  console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

// ── Job diario: verificar bloqueos automáticos (cada 6 horas) ──
setInterval(async () => {
  console.log('🔄 Verificando suscripciones vencidas...');
  await verificarBloqueosAutomaticos();
}, 6 * 60 * 60 * 1000);

module.exports = app;

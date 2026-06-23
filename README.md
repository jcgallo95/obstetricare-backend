# ObstetriCare — Backend

API REST del sistema de guardia obstétrica virtual.

## Stack

- **Node.js + Express** — servidor
- **PostgreSQL** — base de datos
- **MercadoPago** — pagos y suscripciones
- **JWT** — autenticación
- **Web Push** — notificaciones push
- **Railway** — deploy en la nube

---

## Estructura

```
obstetricare-backend/
├── src/
│   ├── index.js                  ← servidor principal
│   ├── routes/
│   │   └── index.js              ← todos los endpoints
│   ├── controllers/
│   │   ├── authController.js     ← registro y login
│   │   ├── consultasController.js ← triage y teleconsultas
│   │   └── webhookController.js  ← eventos de MercadoPago
│   ├── middleware/
│   │   └── auth.js               ← JWT y roles
│   ├── models/
│   │   └── schema.sql            ← esquema de base de datos
│   └── services/
│       ├── pagos.js              ← MercadoPago
│       └── notificaciones.js    ← push notifications
├── config/
│   └── db.js                    ← conexión PostgreSQL
├── .env.example                 ← variables de entorno
└── package.json
```

---

## Setup local

### 1. Clonar e instalar dependencias

```bash
git clone https://github.com/jcgallo95/obstetricare-backend
cd obstetricare-backend
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
# Editar .env con tus credenciales reales
```

### 3. Crear la base de datos

```bash
# Crear base de datos en PostgreSQL
createdb obstetricare

# Ejecutar el esquema
psql obstetricare -f src/models/schema.sql
```

### 4. Iniciar el servidor

```bash
npm run dev   # desarrollo (con nodemon)
npm start     # producción
```

---

## Deploy en Railway

1. Crear cuenta en **railway.app**
2. Nuevo proyecto → Deploy from GitHub
3. Seleccionar el repositorio del backend
4. Agregar una base de datos PostgreSQL (Add Plugin → PostgreSQL)
5. Configurar las variables de entorno en Settings → Variables
6. Railway despliega automáticamente con cada push a `main`

---

## Endpoints principales

| Método | Ruta | Descripción | Rol |
|--------|------|-------------|-----|
| POST | `/api/auth/registro-obstetra` | Registrar obstetra | Público |
| POST | `/api/auth/registro-paciente` | Registrar paciente | Público |
| POST | `/api/auth/login` | Login | Público |
| GET | `/api/perfil` | Datos del usuario | Todos |
| GET | `/api/pacientes` | Listar mis pacientes | Obstetra |
| POST | `/api/consultas/iniciar` | Iniciar consulta de triage | Paciente |
| GET | `/api/consultas/mis-consultas` | Historial de consultas | Paciente |
| GET | `/api/consultas/activas` | Consultas activas en guardia | Guardia |
| POST | `/api/consultas/:id/decision` | Registrar decisión médica | Guardia |
| GET | `/api/consultas/mis-pacientes` | Consultas de mis pacientes | Obstetra |
| PATCH | `/api/ambulancias/:id/estado` | Actualizar estado ambulancia | Operador |
| GET | `/api/suscripcion` | Estado de membresía | Obstetra |
| GET | `/api/notificaciones` | Ver notificaciones | Todos |
| POST | `/api/webhooks/mercadopago` | Webhook de pagos | MP |

---

## Lógica de precios (automática)

| Tipo | Condición | Médico cobra | Paciente paga |
|------|-----------|-------------|---------------|
| Incluida diurna | ≤ 3 consultas, 06:00–00:00 | $7.500 | $0 (cubierta) |
| Incluida nocturna | ≤ 3 consultas, 00:00–06:00 | $8.500 | $0 (cubierta) |
| Extra diurna | > 3 consultas, 06:00–00:00 | $7.500 | $10.000 |
| Extra nocturna | > 3 consultas, 00:00–06:00 | $8.500 | $12.000 |

El cobro extra es **automático en background** — la paciente no experimenta demora.

---

## Sistema de bloqueo por falta de pago

1. Pago fallido → estado `periodo_gracia` + notificación al obstetra
2. Después de 3 días sin pago → estado `bloqueada` + notificación
3. Al acreditar pago → estado `activa` automáticamente

---

## Variables de entorno requeridas

Ver `.env.example` para la lista completa.
Las credenciales de MercadoPago se obtienen en:
**mercadopago.com.ar → Tu negocio → Credenciales**

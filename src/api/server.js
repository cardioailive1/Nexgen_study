'use strict';

require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan      = require('morgan');
const path        = require('path');
const { PrismaClient } = require('@prisma/client');

// ── Routes ────────────────────────────────────────────────────────
const authRoutes        = require('./routes/auth');
const aiRoutes          = require('./routes/ai');
const subscriptionRoutes = require('./routes/subscriptions');
const userRoutes        = require('./routes/users');
const webhookRoutes     = require('./routes/webhooks');
const complianceRoutes  = require('./routes/compliance');
const healthRoutes      = require('./routes/health');

// ── Middleware ────────────────────────────────────────────────────
const { rateLimiter, aiRateLimiter } = require('./middleware/rateLimiter');
const { errorHandler }    = require('./middleware/errorHandler');
const { requestLogger }   = require('./middleware/requestLogger');
const { securityHeaders } = require('./middleware/securityHeaders');

const app = express();

// ── Prisma — lazy connection, don't block startup ─────────────────
let prisma;
function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient({ log: ['error'] });
  }
  return prisma;
}

// ── Health check FIRST — before everything else ───────────────────
// This must respond immediately so Render's health check passes
app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'nexgen-study', timestamp: new Date().toISOString() });
});
app.get('/api/health/ready', (_req, res) => {
  res.status(200).json({ ready: true });
});
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ── Security headers ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'js.stripe.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'blob:', '*.stripe.com'],
      connectSrc:  ["'self'", 'api.anthropic.com', '*.supabase.co', 'api.stripe.com'],
      frameSrc:    ["'self'", 'js.stripe.com'],
      objectSrc:   ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

app.use(securityHeaders);

// ── Stripe webhook raw body ───────────────────────────────────────
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

// ── General middleware ────────────────────────────────────────────
app.use(compression());
app.use(cors({
  origin: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser(process.env.SESSION_SECRET));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(requestLogger);

// ── Rate limiter (after health check) ────────────────────────────
app.use('/api/', rateLimiter);

// ── Inject prisma lazily ──────────────────────────────────────────
app.use((req, _res, next) => {
  req.prisma = getPrisma();
  next();
});

// ── API Routes ────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/ai',            aiRateLimiter, aiRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/webhooks',      webhookRoutes);
app.use('/api/compliance',    complianceRoutes);

// ── Serve static frontend ─────────────────────────────────────────
const frontendPath = path.join(__dirname, '../frontend/public');
app.use(express.static(frontendPath, {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
}));

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────
app.use(errorHandler);

// ── Graceful shutdown ─────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);
  if (prisma) await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start server immediately ──────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`NexGen Study running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = { app, getPrisma };

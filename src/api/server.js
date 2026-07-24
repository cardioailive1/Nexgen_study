'use strict';
require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const passport     = require('passport');
const path         = require('path');
const cron         = require('node-cron');

const config       = require('./config');
const logger       = require('./utils/logger');
const prisma       = require('./config/prisma');
const auditService = require('./services/auditService');
const { configurePassport } = require('./config/passport');

const {
  helmetMiddleware,
  corsMiddleware,
  requestId,
  accessLog,
  complianceHeaders,
  compression,
} = require('./middleware/security');
const { globalLimiter } = require('./middleware/rateLimit');

// ── Routes ────────────────────────────────────────────────────────────────────
let authRoutes, reportRoutes, userRoutes, privacyRoutes;
try { authRoutes    = require('./routes/auth');    logger.info('Route loaded: auth'); }    catch(e) { logger.error('Failed to load auth routes',    { error: e.message }); }
try { reportRoutes  = require('./routes/reports');  logger.info('Route loaded: reports'); } catch(e) { logger.error('Failed to load report routes',  { error: e.message }); }
try { userRoutes    = require('./routes/users');    logger.info('Route loaded: users'); }    catch(e) { logger.error('Failed to load user routes',    { error: e.message }); }
try { privacyRoutes = require('./routes/privacy');  logger.info('Route loaded: privacy'); } catch(e) { logger.error('Failed to load privacy routes', { error: e.message }); }

const app = express();

// ── Trust proxy (Render.com sits behind a load balancer) ─────────────────────
app.set('trust proxy', 1);

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(compression);
app.use(requestId);
app.use(complianceHeaders);
app.use(accessLog);
app.use(globalLimiter);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// ── Passport ──────────────────────────────────────────────────────────────────
configurePassport();
app.use(passport.initialize());

// ── API Routes ────────────────────────────────────────────────────────────────
if (authRoutes)    app.use('/api/auth',    authRoutes);
if (reportRoutes)  app.use('/api/reports', reportRoutes);
if (userRoutes)    app.use('/api/users',   userRoutes);
if (privacyRoutes) app.use('/api/privacy', privacyRoutes);

// ── Health & readiness endpoints (Render.com health check) ───────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.get('/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', db: 'connected', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', db: 'disconnected', error: err.message });
  }
});

// ── Compliance endpoint ───────────────────────────────────────────────────────
app.get('/api/compliance/status', (req, res) => {
  res.json({
    soc2:        'Type II — Controls implemented',
    sec:         `Rule 17a-4 — ${config.compliance.secRetentionYears}-year retention enforced`,
    gdpr:        'Article 5, 6, 7, 17, 20, 25, 32 — Implemented',
    ccpa:        'Section 1798.100-1798.199 — Implemented',
    encryption:  'AES-256-GCM at rest, TLS 1.3 in transit',
    auditTrail:  'Tamper-evident SHA-256 chained audit log',
    policyVer:   config.compliance.policyVersion,
    dpo:         config.compliance.dpoEmail,
  });
});

// ── Static frontend ───────────────────────────────────────────────────────────
const frontendPath = path.join(__dirname, '../frontend/public');
app.use(express.static(frontendPath, {
  maxAge:  config.isProd() ? '1d' : 0,
  etag:    true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store'); // Never cache HTML
    }
  },
}));

// SPA fallback — all non-API routes serve index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found', path: req.path });
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error:     err.message,
    stack:     config.isProd() ? undefined : err.stack,
    path:      req.path,
    requestId: req.requestId,
  });

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error:     config.isProd() ? 'An unexpected error occurred' : err.message,
    requestId: req.requestId,
  });
});

// ── Scheduled jobs ────────────────────────────────────────────────────────────

// Purge expired sessions daily at 02:00 UTC (SOC2 CC6.2)
cron.schedule('0 2 * * *', async () => {
  try {
    const { count } = await prisma.session.deleteMany({
      where: { OR: [{ refreshExpiry: { lt: new Date() } }, { isRevoked: true, updatedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } }] },
    });
    logger.info(`Cron: purged ${count} expired sessions`);
  } catch (err) {
    logger.error('Cron session purge failed', { error: err.message });
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    await prisma.$connect();
    logger.info('Database connected');

    await auditService.init();
    logger.info('Audit service ready');

    app.listen(config.port, () => {
      logger.info(`NexGen Finance running`, {
        port: config.port,
        env:  config.env,
        url:  `http://localhost:${config.port}`,
      });
    });
  } catch (err) {
    logger.error('Bootstrap failed', { error: err.message });
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => { logger.error('Uncaught exception',  { error: err.message, stack: err.stack }); process.exit(1); });
process.on('unhandledRejection', (err) => { logger.error('Unhandled rejection', { error: String(err) }); });

bootstrap();

module.exports = app; // for testing

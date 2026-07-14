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

// ── Trust Render's reverse proxy ──────────────────────────────────
app.set('trust proxy', 1);

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
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  originAgentCluster: false,
  xDnsPrefetchControl: false,
  xDownloadOptions: false,
  xPermittedCrossDomainPolicies: false,
  hsts: false,
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

// ── Run DB push on startup to ensure tables exist ────────────────
// ── Create tables if they don't exist ────────────────────────────
async function ensureDatabase() {
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  try {
    // Test connection
    await p.$connect();
    console.log('Database connected.');

    // Run raw SQL to create all tables if they don't exist
    await p.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT NOT NULL,
        "email" TEXT NOT NULL,
        "emailVerified" BOOLEAN NOT NULL DEFAULT false,
        "emailVerifiedAt" TIMESTAMP(3),
        "passwordHash" TEXT,
        "fullName" TEXT NOT NULL,
        "avatarUrl" TEXT,
        "plan" TEXT NOT NULL DEFAULT 'TRIAL',
        "trialStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "trialEndsAt" TIMESTAMP(3),
        "subscriptionId" TEXT,
        "subscriptionStatus" TEXT NOT NULL DEFAULT 'INACTIVE',
        "stripeCustomerId" TEXT,
        "oauthProvider" TEXT,
        "oauthProviderId" TEXT,
        "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
        "mfaSecret" TEXT,
        "mfaBackupCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
        "dailyUsageCount" INTEGER NOT NULL DEFAULT 0,
        "dailyUsageReset" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "totalGenerations" INTEGER NOT NULL DEFAULT 0,
        "termsAcceptedAt" TIMESTAMP(3),
        "privacyAcceptedAt" TIMESTAMP(3),
        "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
        "dataRetentionDays" INTEGER NOT NULL DEFAULT 365,
        "lastLoginAt" TIMESTAMP(3),
        "lastLoginIp" TEXT,
        "loginAttempts" INTEGER NOT NULL DEFAULT 0,
        "lockedUntil" TIMESTAMP(3),
        "sessionTokenHash" TEXT,
        "deletedAt" TIMESTAMP(3),
        "deletionRequestedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "User_pkey" PRIMARY KEY ("id")
      );
    `);

    await p.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
    `);

    await p.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Session" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "tokenHash" TEXT NOT NULL,
        "ipAddress" TEXT,
        "userAgent" TEXT,
        "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
        "expiresAt" TIMESTAMP(3) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
      );
    `);

    await p.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Generation" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "tool" TEXT NOT NULL,
        "subTool" TEXT NOT NULL,
        "model" TEXT NOT NULL,
        "inputTokens" INTEGER NOT NULL,
        "outputTokens" INTEGER NOT NULL,
        "costUsd" DOUBLE PRECISION NOT NULL,
        "promptHash" TEXT,
        "outputSize" INTEGER NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'COMPLETED',
        "errorMessage" TEXT,
        "durationMs" INTEGER,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Generation_pkey" PRIMARY KEY ("id")
      );
    `);

    await p.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Subscription" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "stripeSubscriptionId" TEXT NOT NULL,
        "stripePriceId" TEXT NOT NULL,
        "plan" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "currentPeriodStart" TIMESTAMP(3) NOT NULL,
        "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
        "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
        "canceledAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
      );
    `);

    await p.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AuditLog" (
        "id" TEXT NOT NULL,
        "userId" TEXT,
        "action" TEXT NOT NULL,
        "resource" TEXT,
        "resourceId" TEXT,
        "ipAddress" TEXT,
        "userAgent" TEXT,
        "metadata" JSONB,
        "severity" TEXT NOT NULL DEFAULT 'INFO',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
      );
    `);

    await p.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "WebhookEvent" (
        "id" TEXT NOT NULL,
        "stripeEventId" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "processed" BOOLEAN NOT NULL DEFAULT false,
        "processedAt" TIMESTAMP(3),
        "payload" JSONB NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
      );
    `);

    await p.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEvent_stripeEventId_key" ON "WebhookEvent"("stripeEventId");
    `);

    await p.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DataExport" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "downloadUrl" TEXT,
        "expiresAt" TIMESTAMP(3),
        "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completedAt" TIMESTAMP(3),
        CONSTRAINT "DataExport_pkey" PRIMARY KEY ("id")
      );
    `);

    console.log('All database tables ready.');
    await p.$disconnect();
  } catch (err) {
    console.error('Database setup error:', err.message);
    await p.$disconnect();
  }
}

// Run before server starts
ensureDatabase();

// ── Start server immediately ──────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`NexGen Study running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = { app, getPrisma };

'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { auditLog }    = require('../services/auditService');

const router = express.Router();

// ── GET /api/compliance/privacy-notice ───────────────────────────
router.get('/privacy-notice', (_req, res) => {
  res.json({
    dataController: 'Corverxis Technologies Ltd',
    contact: 'support@corverxis.com',
    governingLaw: 'State of Delaware, United States',
    lastUpdated: '2025-07-01',
    standards: ['GDPR', 'CCPA', 'FERPA-aligned', 'SOC 2 Type II (in progress)'],
    dataRetentionDays: 365,
    rights: [
      'Access your personal data (Article 15 GDPR)',
      'Rectify inaccurate data (Article 16 GDPR)',
      'Request erasure (Article 17 GDPR)',
      'Data portability (Article 20 GDPR)',
      'Object to processing (Article 21 GDPR)',
      'Opt-out of sale (CCPA Section 1798.120)',
    ],
    thirdParties: [
      { name: 'Stripe Inc.',    purpose: 'Payment processing', dataShared: 'Email, name', policyUrl: 'https://stripe.com/privacy' },
      { name: 'NexGen Ultra',   purpose: 'AI generation engine', dataShared: 'Prompt text (session only, not retained)', policyUrl: 'https://corverxis.com/privacy' },
      { name: 'Render.com',     purpose: 'Cloud hosting', dataShared: 'Application logs', policyUrl: 'https://render.com/privacy' },
    ],
  });
});

// ── POST /api/compliance/data-export ─────────────────────────────
// GDPR Article 20 — Right to Data Portability
router.post('/data-export', requireAuth, async (req, res, next) => {
  try {
    const prisma = req.prisma;
    const userId = req.user.id;

    // Create export request
    const exportRequest = await prisma.dataExport.create({
      data: { userId, status: 'PENDING', requestedAt: new Date() }
    });

    await auditLog(prisma, { userId, action: 'DATA_EXPORT_REQUESTED', resource: 'data_export', resourceId: exportRequest.id, ipAddress: req.ip });

    // In production: queue async export job. Here: return available data synchronously.
    const [user, generations] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: {
        id: true, email: true, fullName: true, plan: true,
        createdAt: true, trialStartedAt: true, trialEndsAt: true,
        lastLoginAt: true, marketingConsent: true,
        termsAcceptedAt: true, privacyAcceptedAt: true,
      }}),
      prisma.generation.findMany({ where: { userId }, select: {
        id: true, tool: true, subTool: true, model: true,
        inputTokens: true, outputTokens: true, createdAt: true, status: true,
      }, orderBy: { createdAt: 'desc' }, take: 1000 }),
    ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      dataController: 'Corverxis Technologies Ltd',
      subject: user,
      generationHistory: generations,
      note: 'Prompt and output content is not stored per our privacy policy.',
    };

    await prisma.dataExport.update({ where: { id: exportRequest.id }, data: { status: 'READY', completedAt: new Date() } });

    res.setHeader('Content-Disposition', 'attachment; filename="nexgen-study-data-export.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
  } catch (err) { next(err); }
});

// ── POST /api/compliance/delete-account ──────────────────────────
// GDPR Article 17 — Right to Erasure
router.post('/delete-account', requireAuth, async (req, res, next) => {
  try {
    const prisma = req.prisma;
    const userId = req.user.id;

    // Mark for deletion (hard delete runs on scheduled job after 30 days per policy)
    await prisma.user.update({
      where: { id: userId },
      data: {
        deletionRequestedAt: new Date(),
        deletedAt: new Date(),
        email: `deleted_${userId}@deleted.invalid`,  // anonymise immediately
        fullName: 'Deleted User',
        passwordHash: null,
        mfaSecret: null,
        mfaBackupCodes: [],
        oauthProviderId: null,
      }
    });

    await auditLog(prisma, { userId, action: 'ACCOUNT_DELETION_REQUESTED', severity: 'WARN', ipAddress: req.ip });

    res.json({ message: 'Your account has been scheduled for deletion. All personal data will be permanently removed within 30 days.' });
  } catch (err) { next(err); }
});

// ── PUT /api/compliance/consent ───────────────────────────────────
router.put('/consent', requireAuth, async (req, res, next) => {
  try {
    const { marketing } = req.body;
    await req.prisma.user.update({
      where: { id: req.user.id },
      data: { marketingConsent: Boolean(marketing) },
    });
    await auditLog(req.prisma, { userId: req.user.id, action: 'CONSENT_UPDATED', metadata: { marketing }, ipAddress: req.ip });
    res.json({ message: 'Consent preferences updated.' });
  } catch (err) { next(err); }
});

// ── GET /api/compliance/audit-log ────────────────────────────────
// User's own audit log — SOC 2 transparency
router.get('/audit-log', requireAuth, async (req, res, next) => {
  try {
    const logs = await req.prisma.auditLog.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { action: true, ipAddress: true, createdAt: true, metadata: true },
    });
    res.json({ logs });
  } catch (err) { next(err); }
});

module.exports = router;

'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { auditLog }    = require('../services/auditService');
const router = express.Router();

// ── GET /api/users/me ─────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, email: true, fullName: true, plan: true,
        mfaEnabled: true, totalGenerations: true,
        trialEndsAt: true, subscriptionStatus: true,
        emailVerified: true, createdAt: true,
      }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) { next(err); }
});

// ── PUT /api/users/me ─────────────────────────────────────────────
router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const { fullName } = req.body;
    const user = await req.prisma.user.update({
      where: { id: req.user.id },
      data: { fullName, updatedAt: new Date() },
      select: { id: true, email: true, fullName: true, plan: true, mfaEnabled: true, totalGenerations: true }
    });
    res.json({ user });
  } catch (err) { next(err); }
});

// ── DELETE /api/users/me ──────────────────────────────────────────
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Anonymise user data immediately
    await req.prisma.user.update({
      where: { id: userId },
      data: {
        email:             `deleted_${userId}@deleted.corverxis.com`,
        fullName:          'Deleted User',
        passwordHash:      null,
        oauthProvider:     null,
        oauthProviderId:   null,
        mfaSecret:         null,
        mfaBackupCodes:    [],
        deletedAt:         new Date(),
        deletionRequestedAt: new Date(),
        updatedAt:         new Date(),
      }
    });

    // Delete all sessions
    await req.prisma.session.deleteMany({ where: { userId } });

    // Log
    await auditLog(req.prisma, {
      userId,
      action:   'ACCOUNT_DELETED',
      severity: 'WARN',
      ipAddress: req.ip,
    });

    // Clear cookies
    res.clearCookie('access_token');
    res.clearCookie('refresh_token');

    res.json({ message: 'Account deleted successfully.' });
  } catch (err) { next(err); }
});

// ── GET /api/users/export ─────────────────────────────────────────
router.get('/export', requireAuth, async (req, res, next) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.user.id },
      include: { generations: { orderBy: { createdAt: 'desc' }, take: 100 } }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      exportedAt: new Date().toISOString(),
      user: {
        id: user.id, email: user.email, fullName: user.fullName,
        plan: user.plan, createdAt: user.createdAt,
        totalGenerations: user.totalGenerations,
      },
      generations: user.generations.map(g => ({
        tool: g.tool, subTool: g.subTool, model: g.model,
        inputTokens: g.inputTokens, outputTokens: g.outputTokens,
        createdAt: g.createdAt,
      }))
    });
  } catch (err) { next(err); }
});

module.exports = router;

'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { auditLog }    = require('../services/auditService');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

const router = express.Router();

// ── GET /api/users/me ─────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, email: true, fullName: true, avatarUrl: true,
        plan: true, trialStartedAt: true, trialEndsAt: true,
        subscriptionStatus: true, mfaEnabled: true,
        emailVerified: true, createdAt: true, oauthProvider: true,
        dailyUsageCount: true, totalGenerations: true,
      }
    });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user });
  } catch (err) { next(err); }
});

// ── PUT /api/users/me ─────────────────────────────────────────────
router.put('/me', requireAuth, [
  body('fullName').optional().trim().isLength({ min: 2, max: 100 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { fullName } = req.body;
    const updated = await req.prisma.user.update({
      where: { id: req.user.id },
      data:  { ...(fullName && { fullName }) },
      select: { id: true, email: true, fullName: true, plan: true },
    });
    await auditLog(req.prisma, { userId: req.user.id, action: 'PROFILE_UPDATED', ipAddress: req.ip });
    res.json({ user: updated });
  } catch (err) { next(err); }
});

// ── PUT /api/users/me/password ────────────────────────────────────
router.put('/me/password', requireAuth, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const user = await req.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user.passwordHash) return res.status(400).json({ error: 'OAuth accounts cannot change password here.' });

    const valid = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    const newHash = await bcrypt.hash(req.body.newPassword, parseInt(process.env.BCRYPT_ROUNDS || '12'));
    await req.prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: newHash } });
    await auditLog(req.prisma, { userId: req.user.id, action: 'PASSWORD_CHANGED', severity: 'WARN', ipAddress: req.ip });
    res.json({ message: 'Password updated successfully.' });
  } catch (err) { next(err); }
});

module.exports = router;

'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { auditLog }    = require('../services/auditService');
const router = express.Router();

// Helper — fetch user by ID using raw SQL to avoid enum issues
async function getUserById(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, email, "fullName", plan, "mfaEnabled", "totalGenerations",
            "trialEndsAt", "subscriptionStatus", "emailVerified", "createdAt",
            "oauthProvider", "deletedAt"
     FROM "User" WHERE id = $1 LIMIT 1`,
    id
  );
  return rows && rows[0] ? rows[0] : null;
}

// ── GET /api/users/me ─────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await getUserById(req.prisma, req.user.id);
    if (!user || user.deletedAt) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) { next(err); }
});

// ── PUT /api/users/me ─────────────────────────────────────────────
router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const { fullName } = req.body;
    await req.prisma.$queryRawUnsafe(
      `UPDATE "User" SET "fullName"=$1, "updatedAt"=$2 WHERE id=$3`,
      fullName, new Date(), req.user.id
    );
    const user = await getUserById(req.prisma, req.user.id);
    res.json({ user });
  } catch (err) { next(err); }
});

// ── DELETE /api/users/me ──────────────────────────────────────────
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const now    = new Date();

    await req.prisma.$queryRawUnsafe(
      `UPDATE "User" SET
        email=$1, "fullName"='Deleted User', "passwordHash"=NULL,
        "oauthProvider"=NULL, "oauthProviderId"=NULL,
        "mfaSecret"=NULL, "mfaBackupCodes"='{}',
        "deletedAt"=$2, "deletionRequestedAt"=$2, "updatedAt"=$2
       WHERE id=$3`,
      `deleted_${userId}@deleted.corverxis.com`, now, userId
    );

    await req.prisma.$queryRawUnsafe(`DELETE FROM "Session" WHERE "userId"=$1`, userId);

    await auditLog(req.prisma, { userId, action: 'ACCOUNT_DELETED', severity: 'WARN', ipAddress: req.ip });

    res.clearCookie('access_token');
    res.clearCookie('refresh_token');
    res.json({ message: 'Account deleted successfully.' });
  } catch (err) { next(err); }
});

// ── GET /api/users/export ─────────────────────────────────────────
router.get('/export', requireAuth, async (req, res, next) => {
  try {
    const user = await getUserById(req.prisma, req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const generations = await req.prisma.$queryRawUnsafe(
      `SELECT tool, "subTool", model, "inputTokens", "outputTokens", "createdAt"
       FROM "Generation" WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 100`,
      req.user.id
    );

    res.json({
      exportedAt: new Date().toISOString(),
      user: {
        id: user.id, email: user.email, fullName: user.fullName,
        plan: user.plan, createdAt: user.createdAt,
        totalGenerations: user.totalGenerations,
      },
      generations
    });
  } catch (err) { next(err); }
});

module.exports = router;

'use strict';

/**
 * SOC 2 Type II CC7.2 — Audit trail for all significant actions
 * Retention: 365 days minimum
 */
async function auditLog(prisma, { userId, action, resource, resourceId, ipAddress, userAgent, metadata, severity = 'INFO' }) {
  try {
    await prisma.auditLog.create({
      data: {
        userId:     userId || null,
        action,
        resource:   resource || null,
        resourceId: resourceId || null,
        ipAddress:  ipAddress || null,
        userAgent:  userAgent || null,
        metadata:   metadata || null,
        severity,
      }
    });
  } catch (err) {
    // Never throw from audit logging — log to stderr but don't break the request
    console.error('[AUDIT LOG FAILED]', err.message, { action, userId });
  }
}

module.exports = { auditLog };

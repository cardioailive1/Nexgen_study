'use strict';

const jwt = require('jsonwebtoken');

async function requireAuth(req, res, next) {
  try {
    // Accept token from Authorization header or httpOnly cookie
    let token = req.cookies?.access_token;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);

    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'access') return res.status(401).json({ error: 'Invalid token type.' });

    const user = await req.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) return res.status(401).json({ error: 'User not found.' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    }
    next(err);
  }
}

function requirePlan(...plans) {
  return (req, res, next) => {
    if (!plans.includes(req.user?.plan)) {
      return res.status(403).json({ error: `This feature requires a ${plans.join(' or ')} plan.` });
    }
    next();
  };
}

module.exports = { requireAuth, requirePlan };

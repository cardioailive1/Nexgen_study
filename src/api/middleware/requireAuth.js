'use strict';

const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  try {
    // Try Bearer header first, then cookie
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.cookies && req.cookies.access_token) {
      token = req.cookies.access_token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.sub, email: decoded.email, plan: decoded.plan };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    return res.status(401).json({ error: 'Invalid authentication token.' });
  }
}

function requirePlan(...plans) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!plans.includes(req.user.plan)) {
      return res.status(403).json({ error: 'Please upgrade your plan to access this feature.' });
    }
    next();
  };
}

module.exports = { requireAuth, requirePlan };

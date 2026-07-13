'use strict';

const { v4: uuidv4 } = require('uuid');

// Additional security headers beyond helmet
function securityHeaders(req, res, next) {
  res.setHeader('X-Request-ID',          req.headers['x-request-id'] || uuidv4());
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options',       'DENY');
  res.setHeader('Referrer-Policy',       'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',    'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Powered-By',          'NexGen Ultra');
  next();
}

module.exports = { securityHeaders };

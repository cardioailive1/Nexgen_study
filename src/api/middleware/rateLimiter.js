'use strict';

const rateLimit = require('express-rate-limit');

// Skip rate limiting for health check paths
function skipHealthCheck(req) {
  return req.path.startsWith('/api/health') || req.path === '/health';
}

const rateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX       || '500'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please try again later.' },
  skip: skipHealthCheck,
});

const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_AI_MAX || '20'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many AI requests. Please wait before generating again.' },
  keyGenerator: (req) => req.user?.id || req.ip,
  skip: skipHealthCheck,
});

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  skip: skipHealthCheck,
});

module.exports = { rateLimiter, aiRateLimiter, authRateLimiter };

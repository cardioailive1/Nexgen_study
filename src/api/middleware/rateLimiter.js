'use strict';

const rateLimit = require('express-rate-limit');

const rateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX       || '100'),
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
  skip: (req) => req.path === '/api/health',
});

const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_AI_MAX || '20'),
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many AI requests. Please wait before generating again.' },
  keyGenerator: (req) => req.user?.id || req.ip,
});

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
});

module.exports = { rateLimiter, aiRateLimiter, authRateLimiter };

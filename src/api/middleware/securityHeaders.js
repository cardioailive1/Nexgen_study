'use strict';

const { v4: uuidv4 } = require('uuid');

function securityHeaders(req, res, next) {
  res.setHeader('X-Request-ID', req.headers['x-request-id'] || uuidv4());
  res.setHeader('X-Powered-By', 'NexGen Ultra');
  next();
}

module.exports = { securityHeaders };

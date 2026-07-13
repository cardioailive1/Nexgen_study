'use strict';

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    if (process.env.NODE_ENV !== 'test') {
      console[level](`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
}

module.exports = { requestLogger };

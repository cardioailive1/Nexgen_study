'use strict';

function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || err.status || 500;
  const isProd = process.env.NODE_ENV === 'production';

  // Log all server errors
  if (statusCode >= 500) {
    console.error(`[ERROR] ${req.method} ${req.path}`, { statusCode, message: err.message, stack: isProd ? undefined : err.stack });
  }

  // Prisma errors
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'A record with this value already exists.' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found.' });
  }

  res.status(statusCode).json({
    error: statusCode >= 500 && isProd ? 'An unexpected error occurred. Please try again.' : err.message,
    ...(isProd ? {} : { stack: err.stack }),
  });
}

module.exports = { errorHandler };

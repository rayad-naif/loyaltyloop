'use strict';

// Long-running entry point for Render, AWS (EC2 / ECS / App Runner / Elastic Beanstalk) and local dev.
// On Vercel the same app is exported from api/index.js as a serverless function.
const app = require('./src/app');
const config = require('./src/config');

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`LoyaltyLoop listening on :${config.port}  (${config.baseUrl})`);
  for (const w of app.warnings()) console.warn('[config] ' + w);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

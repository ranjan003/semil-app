'use strict';
// Root Vercel Serverless Function entrypoint
const { createApp } = require('../semil-app/functions/src/app');

const app = createApp();

module.exports = app;

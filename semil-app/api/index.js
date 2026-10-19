'use strict';
// Vercel Serverless Function entry point
// Connects Vercel HTTP requests to the Express application
const { createApp } = require('../functions/src/app');

const app = createApp();

module.exports = app;

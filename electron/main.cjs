'use strict';

// The entry point. The application itself is in electron/app/.
const electron = require('electron');
const { createApplication } = require('./app/application.cjs');

const application = createApplication({
  electron,
  process,
  pkg: require('../package.json'),
  launchEnvironment: Object.freeze({ ...process.env }),
});
application.lifecycle.start();

module.exports = application;

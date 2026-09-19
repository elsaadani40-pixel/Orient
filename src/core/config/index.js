const path = require('path');

const config = Object.freeze({
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '127.0.0.1',
  dataFile: path.join(__dirname, '../../../data/memories.json'),
  agentDataDirectory: path.join(__dirname, '../../../data/agent'),
  appName: 'ORIENT ONE',
  version: '0.3.0'
});

module.exports = config;

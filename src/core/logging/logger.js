const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../../../orient.log');

function write(level, message, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...meta
  };

  try {
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify(entry) + '\n',
      'utf8'
    );
  } catch {}

  console.log(`[${level}] ${message}`);
}

module.exports = Object.freeze({
  info(message, meta) {
    write('INFO', message, meta);
  },

  warn(message, meta) {
    write('WARN', message, meta);
  },

  error(message, meta) {
    write('ERROR', message, meta);
  }
});

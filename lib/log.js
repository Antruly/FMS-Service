var level = (process.env.LOG_LEVEL || 'info').toLowerCase();
var LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
var current = LEVELS[level] != null ? LEVELS[level] : LEVELS.info;
function ok(lvl) { return LEVELS[lvl] <= current; }
module.exports = {
  error: function() { console.error.apply(console, arguments); },
  warn:  function() { if (ok('warn'))  console.warn.apply(console, arguments); },
  info:  function() { if (ok('info'))  console.log.apply(console, arguments); },
  debug: function() { if (ok('debug')) console.log.apply(console, arguments); }
};

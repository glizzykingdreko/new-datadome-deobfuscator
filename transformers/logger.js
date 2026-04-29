/**
 * Professional logging system for deobfuscation tool
 */

/**
 * Log levels
 */
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4
};

/**
 * Professional logging system
 */
class Logger {
  constructor(level = LogLevel.INFO, prefix = '') {
    this.level = level;
    this.prefix = prefix;
    this.logs = [];
  }

  _log(level, levelName, message, data = null) {
    if (level < this.level) return;
    
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: levelName,
      message: this.prefix ? `[${this.prefix}] ${message}` : message,
      data
    };
    
    this.logs.push(logEntry);
    
    const prefix = `[${timestamp}] [${levelName}]`;
    const msg = this.prefix ? `[${this.prefix}] ${message}` : message;
    
    switch (levelName) {
      case 'DEBUG':
        console.debug(prefix, msg, data || '');
        break;
      case 'INFO':
        console.info(prefix, msg, data || '');
        break;
      case 'WARN':
        console.warn(prefix, msg, data || '');
        break;
      case 'ERROR':
        console.error(prefix, msg, data || '');
        break;
    }
  }

  debug(message, data = null) {
    this._log(LogLevel.DEBUG, 'DEBUG', message, data);
  }

  info(message, data = null) {
    this._log(LogLevel.INFO, 'INFO', message, data);
  }

  warn(message, data = null) {
    this._log(LogLevel.WARN, 'WARN', message, data);
  }

  error(message, data = null) {
    this._log(LogLevel.ERROR, 'ERROR', message, data);
  }

  getLogs() {
    return this.logs;
  }

  clear() {
    this.logs = [];
  }
}

module.exports = { Logger, LogLevel };



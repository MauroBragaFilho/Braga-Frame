'use strict';

const { QueueManager, STATES, ACTIVE, REORDERABLE, CONFLICT_MODES, DEFAULT_SETTINGS, MAX_PARALLEL, MAX_RETRIES } = require('./QueueManager');
const { QueueStore } = require('./queueStore');
const { jobKey, predictOutputPath, safeBaseName } = require('./jobKey');
const { QueueError, RECOVERABLE, NON_RECOVERABLE, describeError, isRecoverable } = require('./errors');

module.exports = {
  QueueManager, QueueStore, QueueError,
  STATES, ACTIVE, REORDERABLE, CONFLICT_MODES, DEFAULT_SETTINGS, MAX_PARALLEL, MAX_RETRIES,
  RECOVERABLE, NON_RECOVERABLE, describeError, isRecoverable,
  jobKey, predictOutputPath, safeBaseName
};

'use strict';

const EventRepository = require('../src/infrastructure/persistence/json/event.repository');

module.exports.fuzz = function fuzz(data) {
  let candidate;
  try {
    candidate = JSON.parse(data.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;

  const normalized = EventRepository.prototype.normalize.call(
    EventRepository.prototype,
    candidate
  );

  if (!normalized || typeof normalized !== 'object' ||
      !normalized.data || typeof normalized.data !== 'object' ||
      Array.isArray(normalized.data)) {
    throw new Error('Event normalization must return an object with object data');
  }
};

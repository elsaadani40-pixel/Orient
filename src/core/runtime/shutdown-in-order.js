'use strict';

async function shutdownInOrder({
  closeIngress,
  stopObservations = async () => {},
  stopWorkers = async () => {},
  shutdownRuntime,
  closePersistence = async () => {},
  onError = () => {}
} = {}) {
  if (typeof closeIngress !== 'function') throw new TypeError('closeIngress is required');
  if (typeof shutdownRuntime !== 'function') throw new TypeError('shutdownRuntime is required');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');

  const steps = [
    ['http-ingress', closeIngress],
    ['observations', stopObservations],
    ['workers', stopWorkers],
    ['runtime', shutdownRuntime],
    ['persistence', closePersistence]
  ];

  const failures = [];
  for (const [stage, operation] of steps) {
    try {
      await operation();
    } catch (error) {
      failures.push({ stage, error });
      try {
        onError(stage, error);
      } catch (_) {
        // Logging failures must not prevent later shutdown stages.
      }
      // If HTTP ingress cannot be confirmed closed, do not tear down Runtime
      // or persistence underneath potentially active requests. The caller's
      // forced non-zero process exit is the final containment boundary.
      if (stage === 'http-ingress') return failures;
    }
  }
  return failures;
}

module.exports = shutdownInOrder;

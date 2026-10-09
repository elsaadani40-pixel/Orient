const AppError = require('../../../core/errors/AppError');

function createAgentRoutes(agentService) {
  return {
    async events(req, res, executionId) {
      const initialEvents = await agentService.getExecutionEvents(executionId, { limit: 200 });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders?.();
      res.write('retry: 3000\\n: ORIENT execution event stream\\n\\n');

      let lastEventId = String(req.headers?.['last-event-id'] || '').replace(/[\\r\\n\\0]/g, '').slice(0, 200) || null;
      let initialized = false;
      let closed = false;
      let polling = false;
      let lastHeartbeatAt = Date.now();

      const safeEvent = (event) => {
        const rawData = event?.data && typeof event.data === 'object' ? event.data : {};
        const pick = (key, max = 80) => {
          const value = rawData[key];
          if (typeof value === 'string') return value.replace(/[\\r\\n\\0]/g, '').slice(0, max);
          if (typeof value === 'number' && Number.isFinite(value)) return value;
          return undefined;
        };
        return {
          id: String(event?.id || '').replace(/[\\r\\n\\0]/g, '').slice(0, 200),
          type: String(event?.type || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100) || 'unknown',
          executionId: String(event?.executionId || executionId).slice(0, 200),
          goalId: event?.goalId ? String(event.goalId).slice(0, 200) : null,
          timestamp: typeof event?.timestamp === 'string' ? event.timestamp.slice(0, 40) : null,
          sequence: Number.isFinite(Number(event?.sequence)) ? Number(event.sequence) : null,
          details: Object.fromEntries(['step', 'stepId', 'tool', 'status', 'errorCode'].map(key => [key, pick(key)]).filter(([, value]) => value !== undefined))
        };
      };

      const writeEvent = (event) => {
        const safe = safeEvent(event);
        if (!safe.id) return;
        res.write(`id: ${safe.id}\\nevent: execution\\ndata: ${JSON.stringify(safe)}\\n\\n`);
        lastEventId = safe.id;
      };

      const poll = async (providedEvents = null) => {
        if (closed || polling) return;
        polling = true;
        try {
          const events = providedEvents || await agentService.getExecutionEvents(executionId, { limit: 200 });
          if (closed) return;
          let startIndex = 0;
          if (!initialized) {
            if (lastEventId) {
              const cursor = events.findIndex(event => String(event.id) === lastEventId);
              if (cursor >= 0) startIndex = cursor + 1;
              else {
                res.write(`event: reset\\ndata: ${JSON.stringify({ reason: 'cursor_not_found', replayingLatest: Math.min(50, events.length) })}\\n\\n`);
                startIndex = Math.max(0, events.length - 50);
              }
            } else {
              startIndex = Math.max(0, events.length - 50);
            }
            initialized = true;
          } else if (lastEventId) {
            const cursor = events.findIndex(event => String(event.id) === lastEventId);
            if (cursor >= 0) startIndex = cursor + 1;
            else if (events.length && String(events[events.length - 1].id) !== lastEventId) {
              res.write(`event: reset\\ndata: ${JSON.stringify({ reason: 'cursor_not_found', replayingLatest: Math.min(50, events.length) })}\\n\\n`);
              startIndex = Math.max(0, events.length - 50);
            } else startIndex = events.length;
          }
          for (const event of events.slice(startIndex)) {
            if (closed) return;
            writeEvent(event);
          }
          if (Date.now() - lastHeartbeatAt >= 15000) {
            res.write(': keep-alive\\n\\n');
            lastHeartbeatAt = Date.now();
          }
        } catch {
          if (!closed) {
            res.write(`event: stream-error\\ndata: ${JSON.stringify({ error: 'Execution event stream temporarily unavailable' })}\\n\\n`);
            cleanup();
            res.end();
          }
        } finally {
          polling = false;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
      };
      const pollTimer = setInterval(() => { void poll(); }, 1000);
      const heartbeatTimer = setInterval(() => {
        if (!closed && Date.now() - lastHeartbeatAt >= 15000) {
          res.write(': keep-alive\\n\\n');
          lastHeartbeatAt = Date.now();
        }
      }, 5000);
      req.on('close', cleanup);
      res.on('close', cleanup);
      void poll(initialEvents);
    },

    async status(req, res, executionId) {
      const result = await agentService.getExecutionStatus(executionId);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });

      res.end(JSON.stringify(result, null, 2));
    },

    async approvals(req, res, executionId) {
      const result =
        await agentService.getExecutionApprovals(executionId);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });

      res.end(JSON.stringify(result, null, 2));
    },

    async resume(req, res, executionId, body) {
      let options = {};

      if (body) {
        try {
          options =
            typeof body === 'string'
              ? JSON.parse(body)
              : body;
        } catch {
          throw new AppError(
            'Invalid JSON body',
            400,
            'INVALID_JSON'
          );
        }
      }

      const result =
        await agentService.resumeExecution(executionId, options || {});

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });

      res.end(JSON.stringify(result, null, 2));
    },

    async cancel(req, res, executionId, body) {
      let options = {};
      if (body) {
        try {
          options = typeof body === 'string' ? JSON.parse(body) : body;
        } catch {
          throw new AppError('Invalid JSON body', 400, 'INVALID_JSON');
        }
      }

      const result = await agentService.cancelExecution(executionId, options || {});
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(result, null, 2));
    },

    async execute(req, res, body) {
      let input = '';

      const contentType =
        String(req.headers['content-type'] || '')
          .toLowerCase();

      if (
        contentType.includes('application/json')
      ) {
        try {
          const parsed =
            typeof body === 'string'
              ? JSON.parse(body)
              : body;

          input =
            typeof parsed?.input === 'string'
              ? parsed.input
              : '';
        } catch {
          input = '';
        }
      } else {
        input =
          new URLSearchParams(body).get('input') || '';
      }

      const result =
        await agentService.execute(input);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });

      res.end(
        JSON.stringify(result, null, 2)
      );
    }
  };
}

module.exports = createAgentRoutes;

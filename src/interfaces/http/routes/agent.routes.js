const AppError = require('../../../core/errors/AppError');

function createAgentRoutes(agentService) {
  return {
    async createTask(req, res, body) {
      let payload;
      try {
        payload = typeof body === 'string' ? JSON.parse(body || '{}') : body;
      } catch (_) {
        throw new AppError('Invalid JSON body', 400, 'INVALID_JSON');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new AppError('Task request must be a JSON object', 400, 'VALIDATION_ERROR');
      }

      const idempotencyKey = req.headers?.['idempotency-key'] || payload.idempotencyKey;
      const result = await agentService.createTask({
        goal: payload.goal,
        idempotencyKey
      });
      const statusCode = result.replayed ? 200 : 201;
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'X-ORIENT-API-Version': 'v1',
        'Location': '/api/v1/tasks/' + encodeURIComponent(result.task.id)
      });
      res.end(JSON.stringify({
        apiVersion: 'v1',
        task: result.task,
        replayed: result.replayed
      }));
    },

    async tasks(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const limitValue = url.searchParams.get('limit');
      const offsetValue = url.searchParams.get('offset');
      const limit = limitValue === null ? 20 : Number(limitValue);
      const offset = offsetValue === null ? 0 : Number(offsetValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
          !Number.isInteger(offset) || offset < 0 || offset > 10000) {
        throw new AppError('Invalid task pagination', 400, 'VALIDATION_ERROR');
      }

      const result = await agentService.listExecutionSummaries({ limit, offset });
      const tasks = (result.executions || []).map(execution => ({
        id: execution.executionId,
        status: execution.status,
        currentStep: execution.currentStep ?? null,
        createdAt: execution.startedAt || null,
        updatedAt: execution.updatedAt || null,
        completedAt: execution.completedAt || null,
        cancellationRequested: Boolean(execution.cancellationRequested),
        version: 1
      }));

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'X-ORIENT-API-Version': 'v1'
      });
      res.end(JSON.stringify({
        apiVersion: 'v1',
        items: tasks,
        page: { limit: result.limit, offset: result.offset, total: result.total }
      }));
    },

    async task(req, res, executionId) {
      const result = await agentService.getExecutionStatus(executionId);
      // Deliberately omit tenant identifiers and raw execution results from the
      // cross-device task summary. Detailed output requires a separately governed API.
      const task = {
        id: result.executionId,
        status: result.status,
        currentStep: result.currentStep ?? null,
        createdAt: result.startedAt || null,
        updatedAt: result.updatedAt || null,
        completedAt: result.completedAt || null,
        cancellationRequested: Boolean(result.cancellationRequested),
        agentLifecycle: result.agentLifecycle || null,
        version: 1
      };
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'X-ORIENT-API-Version': 'v1'
      });
      res.end(JSON.stringify({ apiVersion: 'v1', task }));
    },

    async taskEvents(req, res, executionId) {
      const url = new URL(req.url, 'http://localhost');
      const limitValue = url.searchParams.get('limit');
      const after = url.searchParams.get('after');
      const limit = limitValue === null ? 50 : Number(limitValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new AppError('Invalid task event pagination', 400, 'VALIDATION_ERROR');
      }
      if (after !== null && (after.length < 1 || after.length > 200 || /[\r\n\0]/.test(after))) {
        throw new AppError('Invalid task event cursor', 400, 'VALIDATION_ERROR');
      }

      // The service scopes the execution and its events to the runtime tenant.
      // Only the newest 200 events are currently retrievable; if a cursor falls
      // outside that window, report a gap instead of silently skipping history.
      const events = await agentService.getExecutionEvents(executionId, { limit: 200 });
      let startIndex = 0;
      if (after !== null) {
        const cursorIndex = events.findIndex(event => String(event.id) === after);
        if (cursorIndex < 0) {
          throw new AppError('Task event cursor is no longer available', 409, 'EVENT_CURSOR_NOT_FOUND');
        }
        startIndex = cursorIndex + 1;
      }

      const page = events.slice(startIndex, startIndex + limit).map(event => {
        const data = event?.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? event.data
          : {};
        const safeString = (value, max = 100) =>
          typeof value === 'string' ? value.replace(/[\r\n\0]/g, '').slice(0, max) : null;
        const sequence = event?.sequence == null ? null : Number(event.sequence);
        return {
          id: safeString(String(event?.id || ''), 200),
          taskId: executionId,
          sequence: Number.isFinite(sequence) ? sequence : null,
          timestamp: safeString(event?.timestamp, 40),
          type: safeString(event?.type, 100) || 'unknown',
          stepId: safeString(data.stepId || (typeof data.step === 'string' ? data.step : ''), 100),
          outcome: safeString(data.status, 80),
          details: Object.fromEntries(
            ['step', 'stepId', 'tool', 'status', 'errorCode']
              .map(key => [key, data[key]])
              .filter(([, value]) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
              .map(([key, value]) => [key, typeof value === 'string' ? value.replace(/[\r\n\0]/g, '').slice(0, 100) : value])
          )
        };
      });

      const hasMore = startIndex + page.length < events.length;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'X-ORIENT-API-Version': 'v1'
      });
      res.end(JSON.stringify({
        apiVersion: 'v1',
        items: page,
        page: {
          limit,
          nextCursor: page.length ? page[page.length - 1].id : after,
          hasMore,
          gapDetected: false
        }
      }));
    },

    async executions(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const limitValue = url.searchParams.get('limit');
      const offsetValue = url.searchParams.get('offset');
      const limit = limitValue === null ? 50 : Number(limitValue);
      const offset = offsetValue === null ? 0 : Number(offsetValue);
      if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || offset < 0) {
        throw new AppError('Invalid execution history pagination', 400, 'INVALID_PAGINATION');
      }
      const result = await agentService.listExecutionSummaries({ limit, offset });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(result, null, 2));
    },

    async pendingApprovals(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const limitValue = url.searchParams.get('limit');
      const limit = limitValue === null ? 100 : Number(limitValue);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError('Invalid approval inbox limit', 400, 'INVALID_PAGINATION');
      }
      const result = await agentService.listPendingApprovals({ limit });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(result, null, 2));
    },

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
      res.write('retry: 3000\n: ORIENT execution event stream\n\n');

      let lastEventId = String(req.headers?.['last-event-id'] || '').replace(/[\r\n\0]/g, '').slice(0, 200) || null;
      let initialized = false;
      let closed = false;
      let polling = false;
      let lastHeartbeatAt = Date.now();

      const safeEvent = (event) => {
        const rawData = event?.data && typeof event.data === 'object' ? event.data : {};
        const pick = (key, max = 80) => {
          const value = rawData[key];
          if (typeof value === 'string') return value.replace(/[\r\n\0]/g, '').slice(0, max);
          if (typeof value === 'number' && Number.isFinite(value)) return value;
          return undefined;
        };
        return {
          id: String(event?.id || '').replace(/[\r\n\0]/g, '').slice(0, 200),
          type: String(event?.type || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100) || 'unknown',
          executionId: String(event?.executionId || executionId).slice(0, 200),
          goalId: event?.goalId ? String(event.goalId).slice(0, 200) : null,
          timestamp: typeof event?.timestamp === 'string' ? event.timestamp.slice(0, 40) : null,
          sequence: event?.sequence != null && Number.isFinite(Number(event.sequence)) ? Number(event.sequence) : null,
          details: Object.fromEntries(['step', 'stepId', 'tool', 'status', 'errorCode'].map(key => [key, pick(key)]).filter(([, value]) => value !== undefined))
        };
      };

      const writeEvent = (event) => {
        const safe = safeEvent(event);
        if (!safe.id) return;
        res.write(`id: ${safe.id}\nevent: execution\ndata: ${JSON.stringify(safe)}\n\n`);
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
                res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'cursor_not_found', replayingLatest: Math.min(50, events.length) })}\n\n`);
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
              res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'cursor_not_found', replayingLatest: Math.min(50, events.length) })}\n\n`);
              startIndex = Math.max(0, events.length - 50);
            } else startIndex = events.length;
          }
          for (const event of events.slice(startIndex)) {
            if (closed) return;
            writeEvent(event);
          }
          if (Date.now() - lastHeartbeatAt >= 15000) {
            res.write(': keep-alive\n\n');
            lastHeartbeatAt = Date.now();
          }
        } catch {
          if (!closed) {
            res.write(`event: stream-error\ndata: ${JSON.stringify({ error: 'Execution event stream temporarily unavailable' })}\n\n`);
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
          res.write(': keep-alive\n\n');
          lastHeartbeatAt = Date.now();
        }
      }, 5000);
      req.on('aborted', cleanup);
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

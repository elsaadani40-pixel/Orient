const AppError = require('../../../core/errors/AppError');

function createAgentRoutes(agentService) {
  return {
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

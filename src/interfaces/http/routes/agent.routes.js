function createAgentRoutes(agentService) {
  return {
    async status(req, res, executionId) {
      const result = agentService.getExecutionStatus(executionId);

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

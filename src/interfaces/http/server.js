const http = require('http');
const { URL } = require('url');

const AppError = require('../../core/errors/AppError');
const logger = require('../../core/logging/logger');

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;

      if (size > maxBytes) {
        reject(
          new AppError(
            'Request body too large',
            413,
            'REQUEST_TOO_LARGE'
          )
        );

        req.destroy();
        return;
      }

      body += chunk.toString();
    });

    req.on('end', () => resolve(body));

    req.on('error', reject);
  });
}

function createServer({ memoryRoutes, agentRoutes }) {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(
      req.url,
      'http://localhost'
    );

    try {
      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/dashboard'
      ) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
          'Referrer-Policy': 'no-referrer'
        });
        res.end(require('fs').readFileSync(require('path').join(__dirname, 'dashboard.html'), 'utf8'));
        return;
      }
      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/'
      ) {
        memoryRoutes.home(req, res, requestUrl);
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === '/memory/add'
      ) {
        const body = await readBody(req);
        memoryRoutes.add(req, res, body);
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === '/memory/delete'
      ) {
        const body = await readBody(req);
        memoryRoutes.delete(req, res, body);
        return;
      }

      const executionStatusMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)$/);

      if (
        req.method === 'GET' &&
        executionStatusMatch
      ) {
        await agentRoutes.status(
          req,
          res,
          decodeURIComponent(executionStatusMatch[1])
        );
        return;
      }

      const executionApprovalsMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/approvals$/);

      if (
        req.method === 'GET' &&
        executionApprovalsMatch
      ) {
        await agentRoutes.approvals(
          req,
          res,
          decodeURIComponent(executionApprovalsMatch[1])
        );
        return;
      }

      const executionCancelMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/cancel$/);

      if (
        req.method === 'POST' &&
        executionCancelMatch
      ) {
        const body = await readBody(req);
        await agentRoutes.cancel(
          req,
          res,
          decodeURIComponent(executionCancelMatch[1]),
          body
        );
        return;
      }

      const executionResumeMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/resume$/);

      if (
        req.method === 'POST' &&
        executionResumeMatch
      ) {
        const body = await readBody(req);
        await agentRoutes.resume(
          req,
          res,
          decodeURIComponent(executionResumeMatch[1]),
          body
        );
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === '/agent'
      ) {
        const body = await readBody(req);
        await agentRoutes.execute(req, res, body);
        return;
      }

      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });

      res.end('Not found');
    } catch (error) {
      logger.error(error.message, {
        code: error.code,
        statusCode: error.statusCode
      });

      const statusCode =
        error instanceof AppError
          ? error.statusCode
          : 500;

      const message =
        error instanceof AppError
          ? error.message
          : 'Internal server error';

      res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });

      res.end(message);
    }
  });
}

module.exports = createServer;

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

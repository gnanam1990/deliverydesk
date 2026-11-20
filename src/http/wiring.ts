import type { Db } from '../db/db.ts';
import type { Config } from '../config.ts';
import { App } from './server.ts';
import { registerCoreRoutes } from './routes/core.ts';
import { registerConnectorRoutes } from './routes/connectors.ts';
import type http from 'node:http';

/** Compose the application: routes + domain event handlers. */
export function buildApp(db: Db, config: Config): App {
  const app = new App(db, config);
  registerCoreRoutes(app);
  registerConnectorRoutes(app);
  return app;
}

export function listen(app: App, port = app.config.port): Promise<http.Server> {
  const server = app.server();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

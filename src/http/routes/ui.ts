import type { App } from '../server.ts';
import { authenticateBuyer, authenticateOperator } from '../../domain/auth.ts';
import { renderLogin } from '../render.ts';

/** Browser sign-in: exchanges an issued pilot token for an HttpOnly session cookie. */
export function registerUiRoutes(app: App): void {
  app.route('GET', '/login', {
    auth: { kind: 'none' },
    handler: () => ({ status: 200, html: renderLogin() }),
  });

  app.route('POST', '/login', {
    auth: { kind: 'none' },
    handler: (ctx) => {
      const form = new URLSearchParams(ctx.rawBody);
      const token = form.get('token') ?? '';
      const audience = form.get('audience') === 'operator' ? 'operator' : 'buyer';
      try {
        if (audience === 'operator') authenticateOperator(ctx.db, token);
        else authenticateBuyer(ctx.db, token);
      } catch {
        return { status: 401, html: renderLogin('The token could not be verified.') };
      }
      const target = audience === 'operator' ? '/console' : '/buyer';
      return {
        status: 303,
        headers: {
          location: target,
          'set-cookie': `dd_actor=${encodeURIComponent(`${audience}:${token}`)}; Path=/; HttpOnly; SameSite=Lax`,
        },
        html: '',
      };
    },
  });

  app.route('POST', '/logout', {
    auth: { kind: 'none' },
    handler: () => ({
      status: 303,
      headers: {
        location: '/login',
        'set-cookie': 'dd_actor=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      },
      html: '',
    }),
  });
}

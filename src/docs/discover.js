// Lista todas as rotas direto do Express, com tudo que dá para saber do código: autenticação, perfis permitidos,
// schemas de entrada (params, query, body) e limite de requisições. É a fonte da documentação e dos testes de segurança.
import { authenticate, authenticatePlatform } from '../middlewares/auth.js';
import { limiters } from '../middlewares/rateLimit.js';
import { MOUNTS } from '../routes.js';

const LIMITERS = Object.values(limiters);

// acumula o que os middlewares informam sobre si mesmos
function absorb(state, handlers) {
  const next = { ...state, schemas: { ...state.schemas } };
  for (const handler of handlers) {
    if (handler === authenticate) next.auth = 'clinic';
    if (handler === authenticatePlatform) next.auth = 'platform';
    if (handler.roles) next.roles = handler.roles;
    if (handler.schemas) next.schemas = handler.schemas;
    if (LIMITERS.includes(handler)) next.rateLimited = true;
  }
  return next;
}

export function listRoutes() {
  const routes = [];
  for (const [prefix, router] of MOUNTS) {
    // middlewares registrados com router.use(...) valem para as rotas que vêm depois deles
    let inherited = { auth: null, roles: null, schemas: {}, rateLimited: false };
    for (const layer of router.stack) {
      if (!layer.route) {
        inherited = absorb(inherited, [layer.handle]);
        continue;
      }
      const meta = absorb({ ...inherited, schemas: {}, rateLimited: false }, layer.route.stack.map((entry) => entry.handle));
      const path = `/api${prefix}${layer.route.path === '/' ? '' : layer.route.path}`;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), path, openApiPath: path.replace(/:(\w+)/g, '{$1}'), ...meta });
      }
    }
  }
  return routes;
}

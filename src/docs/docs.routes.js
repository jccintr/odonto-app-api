import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

/** Documentação interativa em /docs (Swagger UI) e a especificação em /openapi.json. */
export function createDocsRouter(spec) {
  const router = Router();
  router.get('/openapi.json', (req, res) => res.json(spec));
  router.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'OdontoApp API', swaggerOptions: { persistAuthorization: true } }));
  return router;
}

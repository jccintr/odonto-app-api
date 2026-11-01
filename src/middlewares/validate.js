// Valida params, query e body com schemas zod. Os valores já convertidos ficam em req.valid
// (em Express 5 req.query é somente leitura, por isso não sobrescrevemos o original).
export const validate = (schemas) => {
  const middleware = (req, res, next) => {
    req.valid = {};
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      // Express 5 deixa req.body indefinido quando a requisição não tem corpo: trata como objeto vazio
      const result = schema.safeParse(part === 'body' ? (req.body ?? {}) : req[part]);
      if (!result.success) {
        return res.status(400).json({
          error: 'Dados inválidos',
          details: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        });
      }
      req.valid[part] = result.data;
    }
    next();
  };
  middleware.schemas = schemas; // lido pelo gerador da documentação (src/docs)
  return middleware;
};

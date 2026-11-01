// Contrato: toda resposta da API vista pelos testes é conferida contra a documentação OpenAPI gerada.
// - o status devolvido precisa estar documentado na rota;
// - o corpo precisa bater com o schema documentado (campos a mais ou a menos falham).
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildOpenApi } from '../../src/docs/openapi.js';

export const spec = await SwaggerParser.dereference(structuredClone(buildOpenApi()));
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
const validators = new Map();

/** "MÉTODO /caminho status" de cada resposta já conferida (a jornada usa para provar que todas as rotas foram exercitadas). */
export const validated = new Set();

const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({
    key: `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase(),
    regex: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
    operation,
  })));

const validatorFor = (key, status, schema) => {
  const id = `${key} ${status}`;
  if (!validators.has(id)) validators.set(id, ajv.compile(schema));
  return validators.get(id);
};

export function checkContract(res) {
  const method = res.request.method;
  const { pathname } = new URL(res.request.url);
  const matches = operations.filter((o) => o.method === method && o.regex.test(pathname));
  if (matches.length === 0) return; // fora da API documentada: /, /health, /docs e rotas que não existem
  if (matches.length > 1) throw new Error(`Rota ambígua na documentação: ${method} ${pathname}`);

  const { key, operation } = matches[0];
  const documented = operation.responses[String(res.status)];
  if (!documented) throw new Error(`${key} respondeu ${res.status}, que não está documentado. Corpo: ${JSON.stringify(res.body).slice(0, 200)}`);

  const schema = documented.content?.['application/json']?.schema;
  if (!schema) {
    if (res.text !== '') throw new Error(`${key} ${res.status}: a documentação diz "sem conteúdo", mas veio corpo`);
    validated.add(`${key} ${res.status}`);
    return;
  }
  const validate = validatorFor(key, res.status, schema);
  if (!validate(res.body)) {
    throw new Error(`${key} ${res.status}: a resposta não bate com a documentação.\n${JSON.stringify(validate.errors, null, 2).slice(0, 1200)}\nCorpo: ${JSON.stringify(res.body).slice(0, 400)}`);
  }
  validated.add(`${key} ${res.status}`);
}

const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

/** Envolve o cliente do supertest: cada requisição, ao ser aguardada, passa por checkContract. */
export function withContract(agent) {
  return new Proxy(agent, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (!VERBS.includes(property)) return value;
      return (...args) => {
        const test = value.apply(target, args);
        const original = test.then.bind(test);
        test.then = (onFulfilled, onRejected) => original((res) => { checkContract(res); return res; }).then(onFulfilled, onRejected);
        return test;
      };
    },
  });
}

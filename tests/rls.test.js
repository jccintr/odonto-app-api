import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { enableTenantRls } from '../src/db/rls.js';
import { withTenant } from '../src/db/tenant.js';
import { createClinic, createUser } from './helpers/factories.js';

describe('isolamento por clínica (RLS)', () => {
  it('toda tabela com clinic_id tem RLS ligado e a política de isolamento', async () => {
    const { rows } = await db.raw(`
      SELECT c.relname AS tabela, c.relrowsecurity AS rls,
             EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS politica
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r' AND c.relname NOT LIKE 'knex_%'
         AND EXISTS (SELECT 1 FROM information_schema.columns k
                      WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name IN ('clinic_id'))`);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row, `tabela ${row.tabela}`).toMatchObject({ rls: true, politica: true });
    }
  });

  it('a clínica enxerga só os próprios usuários', async () => {
    const [a, b] = [await createClinic(), await createClinic()];
    const ua = await createUser(a);
    await createUser(b);
    const rows = await withTenant(a.id, (trx) => trx('users').select('id', 'clinic_id'));
    expect(rows).toEqual([{ id: ua.id, clinic_id: a.id }]);
  });

  it('não lê, altera nem apaga dados de outra clínica, mesmo pelo id', async () => {
    const [a, b] = [await createClinic(), await createClinic()];
    const ub = await createUser(b);
    await withTenant(a.id, async (trx) => {
      expect(await trx('users').where({ id: ub.id }).first()).toBeUndefined();
      expect(await trx('users').where({ id: ub.id }).update({ name: 'invadido' })).toBe(0);
      expect(await trx('users').where({ id: ub.id }).del()).toBe(0);
    });
    expect((await db('users').where({ id: ub.id }).first()).name).toBe(ub.name);
  });

  it('não grava dados em nome de outra clínica (WITH CHECK)', async () => {
    const [a, b] = [await createClinic(), await createClinic()];
    await expect(
      withTenant(a.id, (trx) => trx('users').insert({ clinic_id: b.id, name: 'x', email: 'x@x.com', password_hash: 'h', role: 'admin' })),
    ).rejects.toThrow(/row-level security/);
  });

  it('a própria clínica só enxerga o próprio registro na tabela clinics', async () => {
    const [a] = [await createClinic(), await createClinic()];
    const rows = await withTenant(a.id, (trx) => trx('clinics').select('id'));
    expect(rows).toEqual([{ id: a.id }]);
  });

  it('o papel da aplicação não ultrapassa a transação: depois dela, a conexão volta ao papel dono', async () => {
    const a = await createClinic();
    await createClinic();
    await withTenant(a.id, () => {});
    expect(await db('clinics').count({ n: '*' }).first()).toEqual({ n: '2' });
  });

  it('sem clínica definida na sessão, nenhuma linha é visível', async () => {
    await createUser(await createClinic());
    const rows = await db.transaction(async (trx) => {
      await trx.raw('SET LOCAL ROLE odonto_app');
      return trx('users');
    });
    expect(rows).toEqual([]);
  });

  it('withTenant recusa clinicId que não é UUID', async () => {
    await expect(withTenant('1; DROP TABLE users', () => {})).rejects.toThrow('clinicId inválido');
    await expect(withTenant(undefined, () => {})).rejects.toThrow('clinicId inválido');
  });

  it('enableTenantRls aceita coluna e permissões personalizadas', async () => {
    await db.raw('CREATE TABLE tmp_rls (id serial PRIMARY KEY, dono uuid NOT NULL)');
    await enableTenantRls(db, 'tmp_rls', { column: 'dono', grants: 'SELECT' });
    const a = await createClinic();
    await db('tmp_rls').insert({ dono: a.id });
    const rows = await withTenant(a.id, (trx) => trx('tmp_rls'));
    expect(rows).toHaveLength(1);
    await db.raw('DROP TABLE tmp_rls');
  });
});

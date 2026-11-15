import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { enableTenantRls } from '../src/db/rls.js';
import { withTenant } from '../src/db/tenant.js';
import { addMembership, createClinic, createUser } from './helpers/factories.js';

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

  it('a clínica enxerga só as pessoas que têm vínculo com ela (inclusive quem também está em outra clínica)', async () => {
    const [a, b] = [await createClinic(), await createClinic()];
    const ua = await createUser(a);
    await createUser(b);
    const both = await createUser(b);
    await addMembership(both, a, { role: 'dentist' });
    const ids = (await withTenant(a.id, (trx) => trx('users').select('id'))).map((r) => r.id).sort();
    expect(ids).toEqual([ua.id, both.id].sort());
    // e só os vínculos da própria clínica, mesmo da pessoa que está nas duas
    const memberships = await withTenant(a.id, (trx) => trx('memberships').select('clinic_id', 'user_id'));
    expect(memberships.every((m) => m.clinic_id === a.id)).toBe(true);
    expect(memberships).toHaveLength(2);
  });

  it('não lê nem altera pessoas sem vínculo com a clínica, mesmo pelo id; ninguém apaga pessoas', async () => {
    const [a, b] = [await createClinic(), await createClinic()];
    const ub = await createUser(b);
    await withTenant(a.id, async (trx) => {
      expect(await trx('users').where({ id: ub.id }).first()).toBeUndefined();
      expect(await trx('users').where({ id: ub.id }).update({ name: 'invadido' })).toBe(0);
    });
    await expect(withTenant(a.id, (trx) => trx('users').where({ id: ub.id }).del())).rejects.toThrow(/permission denied/);
    expect((await db('users').where({ id: ub.id }).first()).name).toBe(ub.name);
  });

  it('não grava vínculos em nome de outra clínica (WITH CHECK); cadastrar uma pessoa nova é livre, mas ela só aparece com vínculo', async () => {
    const [a, b] = [await createClinic(), await createClinic()];
    const ub = await createUser(b);
    await expect(
      withTenant(a.id, (trx) => trx('memberships').insert({ clinic_id: b.id, user_id: ub.id, role: 'admin' })),
    ).rejects.toThrow(/row-level security/);
    const id = '00000000-0000-4000-8000-0000000000aa';
    const seen = await withTenant(a.id, async (trx) => {
      await trx('users').insert({ id, name: 'Nova', email: 'nova@x.com', password_hash: 'h' });
      const before = await trx('users').where({ id }).first();
      await trx('memberships').insert({ clinic_id: a.id, user_id: id, role: 'secretary' });
      return { before, after: await trx('users').where({ id }).first('id') };
    });
    expect(seen).toEqual({ before: undefined, after: { id } });
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

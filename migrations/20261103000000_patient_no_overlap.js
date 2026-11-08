// Um paciente não pode estar em dois atendimentos ao mesmo tempo, nem com dentistas diferentes.
export async function up(knex) {
  // atendimentos já gravados em conflito (criados antes desta regra): o mais recente é cancelado para a regra poder valer
  await knex.raw(`
    UPDATE appointments b
       SET status = 'canceled',
           canceled_reason = COALESCE(b.canceled_reason, 'Cancelado automaticamente: paciente já tinha outro atendimento no mesmo horário.'),
           updated_at = now()
     WHERE b.status <> 'canceled'
       AND EXISTS (
         SELECT 1 FROM appointments a
          WHERE a.patient_id = b.patient_id AND a.id <> b.id AND a.status <> 'canceled'
            AND tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
            AND (a.created_at, a.id) < (b.created_at, b.id))`);
  await knex.raw(`ALTER TABLE appointments ADD CONSTRAINT appointments_patient_no_overlap
    EXCLUDE USING gist (patient_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status <> 'canceled')`);
}

export async function down(knex) {
  await knex.raw('ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_patient_no_overlap');
}

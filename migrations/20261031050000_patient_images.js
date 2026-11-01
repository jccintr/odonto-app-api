// Imagens e radiografias do paciente. O arquivo fica no Cloudinary (privado); aqui só os dados.
// Nada é apagado do banco: a remoção é lógica (quem removeu e quando), como no odontograma.
import { enableTenantRls } from '../src/db/rls.js';
import { IMAGE_KINDS } from '../src/utils/images.js';
import { TEETH } from '../src/utils/tooth.js';

const quoted = (list) => list.map((v) => `'${v}'`).join(', ');

export async function up(knex) {
  await knex.schema.createTable('patient_images', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('patient_id').notNullable();
    t.string('kind', 20).notNullable();
    t.string('public_id', 300).notNullable().unique();
    t.string('format', 10).notNullable();
    t.integer('bytes').notNullable();
    t.integer('width');
    t.integer('height');
    t.specificType('tooth', 'smallint');
    t.date('taken_on').notNullable();
    t.text('notes');
    t.uuid('uploaded_by');
    t.timestamp('removed_at', { useTz: true });
    t.uuid('removed_by');
    t.timestamps(true, true);
    t.index(['clinic_id', 'patient_id', 'taken_on']);
    t.foreign(['clinic_id', 'patient_id']).references(['clinic_id', 'id']).inTable('patients').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE patient_images ADD CONSTRAINT patient_images_kind_check CHECK (kind IN (${quoted(IMAGE_KINDS)}))`);
  await knex.raw(`ALTER TABLE patient_images ADD CONSTRAINT patient_images_tooth_check CHECK (tooth IS NULL OR tooth IN (${TEETH.join(', ')}))`);
  await knex.raw('ALTER TABLE patient_images ADD CONSTRAINT patient_images_bytes_check CHECK (bytes > 0)');
  await enableTenantRls(knex, 'patient_images', { grants: 'SELECT, INSERT, UPDATE' });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('patient_images');
}

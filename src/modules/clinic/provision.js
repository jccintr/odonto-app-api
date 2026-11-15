// Criação de uma clínica completa (usada pelo cadastro público e pela plataforma): clínica, primeiro administrador, período de teste,
// procedimentos do modelo escolhido e aceite dos termos, tudo na mesma transação. O e-mail de verificação sai depois do commit.
import db from '../../db/knex.js';
import { config } from '../../config/env.js';
import { toClinicDto, toUserDto } from '../../utils/dto.js';
import { addDays, businessDate } from '../../utils/dates.js';
import { conflict } from '../../utils/errors.js';
import { slugify } from '../../utils/slug.js';
import { hashPassword, verifyPassword } from '../../services/password.js';
import { findMember, setClinicalProfile } from '../../services/members.js';
import { sendInviteSafely, sendVerificationSafely } from '../auth/auth.service.js';
import { findTemplate } from '../signup/templates.js';

async function uniqueSlug(trx, base) {
  let slug = base;
  let n = 1;
  while (await trx('clinics').where({ slug }).first('id')) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

/**
 * @param admin { name, email, password, phone?, attendsPatients? } — telefone e nome são ignorados se o e-mail já tem conta — attendsPatients = o administrador também atende pacientes (clínica pequena)
 * @param acceptance { termsVersion, privacyVersion, ip, userAgent } (cadastro público)
 *
 * O e-mail do administrador pode já ter conta no OdontoApp (por exemplo, um dentista que trabalha em outra clínica e abre a própria):
 * - no cadastro público, a pessoa comprova que é dona da conta com a mesma senha; a clínica nova entra na conta dela;
 * - pela plataforma, o vínculo nasce como convite, que a pessoa aceita pelo e-mail (a plataforma não conhece a senha dela).
 */
export async function provisionClinic({ name, slug, document, plan, admin, templateCode = null, acceptance = null }) {
  const existing = await db('users').where({ email: admin.email }).first();
  if (existing && acceptance && !(await verifyPassword(admin.password, existing.password_hash))) {
    throw conflict(
      'Este e-mail já tem uma conta no OdontoApp. Para criar outra clínica com ele, use a mesma senha da sua conta (ou recupere a senha em "Esqueci a senha").',
      { code: 'EMAIL_IN_USE' },
    );
  }
  const passwordHash = existing ? null : await hashPassword(admin.password);
  let result;
  try {
    result = await db.transaction(async (trx) => {
      const [clinic] = await trx('clinics')
        .insert({
          name, slug: slug ?? (await uniqueSlug(trx, slugify(name))), document, template_code: templateCode, ...(plan && { plan }),
        })
        .returning('*');
      // a assinatura nasce por gatilho do banco; aqui só ajustamos a duração do teste configurada
      const trialEndsOn = addDays(businessDate(), config.trialDays);
      await trx('subscriptions').where({ clinic_id: clinic.id }).update({ trial_ends_on: trialEndsOn });

      const userId = existing?.id ?? (await trx('users').insert({ name: admin.name, email: admin.email, phone: admin.phone ?? null, password_hash: passwordHash }).returning('id'))[0].id;
      const invited = Boolean(existing) && !acceptance;
      await trx('memberships').insert({ clinic_id: clinic.id, user_id: userId, role: 'admin', accepted_at: invited ? null : new Date() });
      if (admin.attendsPatients) await setClinicalProfile(trx, clinic.id, userId, true);

      const procedures = findTemplate(templateCode)?.procedures ?? [];
      if (procedures.length > 0) {
        await trx('procedures').insert(procedures.map((p) => ({
          clinic_id: clinic.id, name: p.name, category: p.category, price_cents: p.priceCents, cost_cents: p.costCents, odontogram_condition: p.odontogramCondition,
        })));
      }
      if (acceptance) {
        await trx('terms_acceptances').insert({
          clinic_id: clinic.id, user_id: userId, terms_version: acceptance.termsVersion, privacy_version: acceptance.privacyVersion,
          ip: acceptance.ip, user_agent: acceptance.userAgent?.slice(0, 255) || null,
        });
      }
      await trx('billing_events').insert({
        clinic_id: clinic.id, type: 'clinic_created', data: JSON.stringify({ source: acceptance ? 'signup' : 'platform', template: templateCode, trialEndsOn }), actor: 'system',
      });
      return { clinic, member: await findMember(trx, userId, clinic.id), trialEndsOn };
    });
  } catch (err) {
    if (err.code === '23505') throw conflict('Identificador (slug) já em uso.');
    throw err;
  }
  const { clinic, member } = result;
  if (!member.accepted_at) await sendInviteSafely(member, clinic);
  else if (!member.email_verified_at) await sendVerificationSafely(member);
  return { clinic: toClinicDto(clinic), admin: toUserDto(member), trialEndsOn: result.trialEndsOn };
}

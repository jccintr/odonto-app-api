// Criação de uma clínica completa (usada pelo cadastro público e pela plataforma): clínica, primeiro administrador, período de teste,
// procedimentos do modelo escolhido e aceite dos termos, tudo na mesma transação. O e-mail de verificação sai depois do commit.
import db from '../../db/knex.js';
import { config } from '../../config/env.js';
import { toClinicDto, toUserDto } from '../../utils/dto.js';
import { addDays, businessDate } from '../../utils/dates.js';
import { conflict } from '../../utils/errors.js';
import { slugify } from '../../utils/slug.js';
import { hashPassword } from '../../services/password.js';
import { sendVerificationSafely } from '../auth/auth.service.js';
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

/** @param acceptance { termsVersion, privacyVersion, ip, userAgent } (cadastro público) */
export async function provisionClinic({ name, slug, document, plan, admin, templateCode = null, acceptance = null }) {
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

      const [user] = await trx('users')
        .insert({ clinic_id: clinic.id, name: admin.name, email: admin.email, password_hash: await hashPassword(admin.password), role: 'admin' })
        .returning('*');

      const procedures = findTemplate(templateCode)?.procedures ?? [];
      if (procedures.length > 0) {
        await trx('procedures').insert(procedures.map((p) => ({
          clinic_id: clinic.id, name: p.name, category: p.category, price_cents: p.priceCents, cost_cents: p.costCents, odontogram_condition: p.odontogramCondition,
        })));
      }
      if (acceptance) {
        await trx('terms_acceptances').insert({
          clinic_id: clinic.id, user_id: user.id, terms_version: acceptance.termsVersion, privacy_version: acceptance.privacyVersion,
          ip: acceptance.ip, user_agent: acceptance.userAgent?.slice(0, 255) || null,
        });
      }
      await trx('billing_events').insert({
        clinic_id: clinic.id, type: 'clinic_created', data: JSON.stringify({ source: acceptance ? 'signup' : 'platform', template: templateCode, trialEndsOn }), actor: 'system',
      });
      return { clinic, user, trialEndsOn };
    });
  } catch (err) {
    if (err.code === '23505') {
      throw conflict(err.constraint === 'users_email_unique' ? 'E-mail do administrador já cadastrado.' : 'Identificador (slug) já em uso.');
    }
    throw err;
  }
  await sendVerificationSafely(result.user);
  return { clinic: toClinicDto(result.clinic), admin: toUserDto(result.user), trialEndsOn: result.trialEndsOn };
}

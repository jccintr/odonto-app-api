import db from '../../db/knex.js';
import { conflict, notFound, tooManyRequests, unauthorized } from '../../utils/errors.js';
import { toClinicDto, toPlatformAdminDto, toUserDto } from '../../utils/dto.js';
import { escapeLike, pageResult, paginate } from '../../utils/pagination.js';
import { slugify } from '../../utils/slug.js';
import { loginThrottle } from '../../utils/loginThrottle.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../services/password.js';
import { signPlatformToken } from '../../services/tokens.js';
import { sendVerificationSafely } from '../auth/auth.service.js';

// ---- administradores da plataforma ----

export async function createPlatformAdmin({ name, email, password }) {
  try {
    const [admin] = await db('platform_admins')
      .insert({ name, email: email.trim().toLowerCase(), password_hash: await hashPassword(password) })
      .returning('*');
    return toPlatformAdminDto(admin);
  } catch (err) {
    if (err.code === '23505') throw conflict('E-mail já cadastrado.');
    throw err;
  }
}

export async function platformLogin({ email, password, ip }) {
  const key = `platform|${ip}|${email}`;
  const wait = loginThrottle.blockedFor(key);
  if (wait > 0) throw tooManyRequests('Muitas tentativas de login. Tente novamente mais tarde.', wait);

  const admin = await db('platform_admins').where({ email }).first();
  const passwordOk = await verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !passwordOk || !admin.active) {
    loginThrottle.fail(key);
    throw unauthorized('E-mail ou senha inválidos.');
  }
  loginThrottle.reset(key);
  return { token: signPlatformToken(admin), admin: toPlatformAdminDto(admin) };
}

// ---- clínicas ----

async function uniqueSlug(trx, base) {
  let slug = base;
  let n = 1;
  while (await trx('clinics').where({ slug }).first('id')) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

/** Cria a clínica e o primeiro administrador, na mesma transação. O e-mail de verificação sai depois do commit. */
export async function createClinic({ name, slug, document, plan, admin }) {
  let result;
  try {
    result = await db.transaction(async (trx) => {
      const [clinic] = await trx('clinics')
        .insert({ name, slug: slug ?? (await uniqueSlug(trx, slugify(name))), document, ...(plan && { plan }) })
        .returning('*');
      const [user] = await trx('users')
        .insert({ clinic_id: clinic.id, name: admin.name, email: admin.email, password_hash: await hashPassword(admin.password), role: 'admin' })
        .returning('*');
      return { clinic, user };
    });
  } catch (err) {
    if (err.code === '23505') {
      throw conflict(err.constraint === 'users_email_unique' ? 'E-mail do administrador já cadastrado.' : 'Identificador (slug) já em uso.');
    }
    throw err;
  }
  await sendVerificationSafely(result.user);
  return { clinic: toClinicDto(result.clinic), admin: toUserDto(result.user) };
}

export async function listClinics({ status, q, ...paging }) {
  const filtered = () =>
    db('clinics').modify((query) => {
      if (status) query.where({ status });
      if (q) query.where((b) => b.whereILike('name', `%${escapeLike(q)}%`).orWhereILike('slug', `%${escapeLike(q)}%`));
    });
  const [{ count }] = await filtered().count({ count: '*' });
  const { limit, offset } = paginate(paging);
  const rows = await filtered().orderBy('name').limit(limit).offset(offset);
  return pageResult(rows.map(toClinicDto), Number(count), paging);
}

export async function getClinic(id) {
  const clinic = await db('clinics').where({ id }).first();
  if (!clinic) throw notFound('Clínica');
  return toClinicDto(clinic);
}

export async function updateClinic(id, changes) {
  const [clinic] = await db('clinics').where({ id }).update({ ...changes, updated_at: new Date() }).returning('*');
  if (!clinic) throw notFound('Clínica');
  return toClinicDto(clinic);
}

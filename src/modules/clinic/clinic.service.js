import { withTenant } from '../../db/tenant.js';
import { toClinicDto } from '../../utils/dto.js';

// O RLS garante que a consulta só enxerga a própria clínica.
export function getClinic(clinicId) {
  return withTenant(clinicId, async (trx) => toClinicDto(await trx('clinics').first()));
}

export function updateClinic(clinicId, changes) {
  return withTenant(clinicId, async (trx) => {
    const [clinic] = await trx('clinics').update({ ...changes, updated_at: new Date() }).returning('*');
    return toClinicDto(clinic);
  });
}

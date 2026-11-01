// "Clínica Sorriso & Cia" -> "clinica-sorriso-cia"
export function slugify(text) {
  const slug = String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'clinica';
}

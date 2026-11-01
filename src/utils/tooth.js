// Odontograma: numeração FDI (dois dígitos: quadrante + dente), faces e condições.
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);

// permanentes: quadrantes 1 a 4, dentes 1 a 8; decíduos (leite): quadrantes 5 a 8, dentes 1 a 5
export const PERMANENT_TEETH = [1, 2, 3, 4].flatMap((q) => range(1, 8).map((n) => q * 10 + n));
export const DECIDUOUS_TEETH = [5, 6, 7, 8].flatMap((q) => range(1, 5).map((n) => q * 10 + n));
export const TEETH = [...PERMANENT_TEETH, ...DECIDUOUS_TEETH];

// V vestibular, L lingual/palatina, M mesial, D distal, O oclusal/incisal
export const FACES = ['V', 'L', 'M', 'D', 'O'];

// sem repetição e sempre na ordem canônica (ex.: "dom" vira "MDO")
export const normalizeFaces = (faces) => FACES.filter((face) => faces.includes(face)).join('');

export const CONDITIONS = [
  'caries', 'restoration', 'crown', 'implant', 'missing', 'extracted', 'root_canal', 'sealant', 'fracture', 'prosthesis', 'other',
];

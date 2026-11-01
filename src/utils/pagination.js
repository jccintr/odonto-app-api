import { z } from '../config/zod.js';

export const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
};

export const paginate = ({ page, perPage }) => ({ limit: perPage, offset: (page - 1) * perPage });

export const pageResult = (data, total, { page, perPage }) => ({
  data,
  page,
  perPage,
  total,
  totalPages: Math.ceil(total / perPage),
});

// escapa % e _ para busca com LIKE/ILIKE literal
export const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

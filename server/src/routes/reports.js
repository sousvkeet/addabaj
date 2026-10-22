import { Router } from 'express';
import { z } from 'zod';
import { AppError, isUuid } from '../errors.js';
import { REASONS, createReport } from '../services/reports.js';
import { rateLimiter } from '../socket/util.js';

export const reportsRouter = Router();

// No floods of reports: 5 a minute (and 20 a day, see services/reports.js).
const canReport = rateLimiter(5, 60_000);

const reportSchema = z.object({
  scope: z.enum(['user', 'dm', 'room'], 'Choose what to report.'),
  targetId: z.string().refine(isUuid, "That person doesn't exist.").optional(),
  messageId: z.union([z.number(), z.string()]).optional(),
  reason: z.enum(REASONS, 'Choose a reason.'),
  details: z.string().max(500, 'Keep it under 500 characters.').optional(),
  block: z.boolean().optional(),
});

// Report a person, or a message of theirs, to the host admin.
reportsRouter.post('/', async (req, res) => {
  if (!canReport(req.userId)) throw new AppError(429, 'Wait a moment before sending another report.');
  res.status(201).json(await createReport(req.userId, reportSchema.parse(req.body)));
});

import { Router } from 'express';
import { currentUser, requireAuth } from '../auth/session';
import { badRequest } from '../lib/errors';
import {
  cancelEmail,
  emailStats,
  getEmail,
  listQuerySchema,
  listScheduled,
  listSent,
  scheduleCampaign,
  scheduleSchema,
  search,
  searchQuerySchema,
} from './emailService';

export const emailRouter = Router();
emailRouter.use('/api/emails', requireAuth);

emailRouter.post('/api/emails/schedule', async (req, res) => {
  const input = scheduleSchema.parse(req.body);
  const key = req.get('Idempotency-Key');
  if (key !== undefined && (key.length < 8 || key.length > 200)) throw badRequest('Idempotency-Key must be 8-200 characters');
  const result = await scheduleCampaign(currentUser(req).id, input, key);
  res.status(result.replayed ? 200 : 201).json(result);
});

emailRouter.get('/api/emails/scheduled', async (req, res) => {
  const { page, pageSize } = listQuerySchema.parse(req.query);
  res.json(await listScheduled(currentUser(req).id, page, pageSize));
});

emailRouter.get('/api/emails/sent', async (req, res) => {
  const { page, pageSize } = listQuerySchema.parse(req.query);
  res.json(await listSent(currentUser(req).id, page, pageSize));
});

emailRouter.get('/api/emails/stats', async (req, res) => {
  res.json(await emailStats(currentUser(req).id));
});

emailRouter.get('/api/emails/search', async (req, res) => {
  res.json(await search(currentUser(req).id, searchQuerySchema.parse(req.query)));
});

emailRouter.get('/api/emails/:id', async (req, res) => {
  res.json(await getEmail(currentUser(req).id, req.params.id!));
});

emailRouter.post('/api/emails/:id/cancel', async (req, res) => {
  res.json(await cancelEmail(currentUser(req).id, req.params.id!));
});

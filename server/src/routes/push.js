import { Router } from 'express';
import { z } from 'zod';
import { registerDevice, unregisterDevice } from '../services/push.js';

export const pushRouter = Router();

// The Android app's Firebase token: where this person's notifications go.
const deviceSchema = z.object({
  token: z.string().trim().min(20, 'That push token is not valid.').max(4096, 'That push token is not valid.'),
  platform: z.enum(['android']).default('android'),
});

pushRouter.post('/devices', async (req, res) => {
  const { token, platform } = deviceSchema.parse(req.body);
  await registerDevice(req.userId, token, platform);
  res.status(204).end();
});

// Signing out on the phone: stop its notifications.
pushRouter.delete('/devices', async (req, res) => {
  const { token } = deviceSchema.pick({ token: true }).parse(req.body);
  await unregisterDevice(req.userId, token);
  res.status(204).end();
});

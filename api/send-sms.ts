/**
 * Vercel Serverless Function: POST /api/send-sms
 *
 * Real Twilio integration — ports the /api/send-sms handler from server.mjs
 * so the "Send Test SMS" button in Admin → SMS works on Vercel too.
 *
 * Body: { to, message, twilioSettings: { isEnabled, accountSid, authToken, fromNumber } }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

type RL = { count: number; reset: number };
const rl: Map<string, RL> = (globalThis as any).__fruSmsRL || new Map();
(globalThis as any).__fruSmsRL = rl;

function checkRate(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const cur = rl.get(key);
  if (!cur || now > cur.reset) {
    rl.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (cur.count >= max) return false;
  cur.count++;
  return true;
}

const sanitize = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max) : '';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const raw = (req.body || {}) as any;
  const to      = sanitize(raw.to, 20);
  const message = sanitize(raw.message, 500);
  const ts      = raw.twilioSettings || {};

  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'Missing fields' });
  }

  if (!ts.isEnabled || !ts.accountSid || !ts.authToken || !ts.fromNumber) {
    return res.status(200).json({
      success: true, simulated: true,
      message: 'SMS gateway not configured.',
    });
  }

  if (!checkRate(`sms:${to}`, 3, 60_000)) {
    return res.status(429).json({
      success: false,
      error: 'Too many SMS requests. Please wait before requesting another OTP.',
    });
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(ts.accountSid)}/Messages.json`;
    const basic = Buffer.from(`${ts.accountSid}:${ts.authToken}`).toString('base64');
    const body = new URLSearchParams({ To: to, From: ts.fromNumber, Body: message });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const data: any = await resp.json().catch(() => ({}));
    if (resp.ok && data.sid) {
      return res.status(200).json({ success: true, sid: data.sid });
    }
    return res.status(502).json({
      success: false,
      error: data.message || 'Twilio error',
      code: data.code,
      status: resp.status,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Unknown error' });
  }
}

// api/razorpay/create-order.ts
// Creates a Razorpay order. Client then opens Razorpay Checkout with the returned id.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getGatewayCreds, missingCreds } from '../_lib/getGatewayCreds';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { amount, currency = 'INR', receipt } = req.body || {};
    if (!amount) return res.status(400).json({ error: 'amount required' });

    const creds = await getGatewayCreds('razorpay');
    const missing = missingCreds(creds, ['keyId', 'keySecret']);
    if (missing.length) {
      return res.status(500).json({ error: `Missing Razorpay credentials: ${missing.join(', ')}` });
    }

    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: Math.round(Number(amount) * 100), // paise
        currency,
        receipt: receipt || `rcpt_${Date.now()}`,
      }),
    });
    const j: any = await r.json();
    if (!j?.id) return res.status(502).json({ error: 'Razorpay order failed', detail: j });

    return res.status(200).json({ orderId: j.id, amount: j.amount, currency: j.currency, keyId: creds.keyId });
  } catch (e: any) {
    console.error('[razorpay/create]', e);
    return res.status(500).json({ error: e?.message });
  }
}

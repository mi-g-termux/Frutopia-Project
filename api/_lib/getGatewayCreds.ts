// api/_lib/getGatewayCreds.ts
// Reads gateway credentials with env-first, Firebase-fallback strategy.
// Works on Vercel Serverless (Node 18+).

import { initializeApp, getApps, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length) return;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      initializeApp({ credential: cert(svc) });
    } else {
      initializeApp({ credential: applicationDefault() });
    }
  } catch (e) {
    console.warn('[gateway-creds] firebase init skipped:', (e as Error).message);
  }
}

async function readFirebasePaymentSettings(): Promise<Record<string, any>> {
  try {
    initFirebase();
    if (!getApps().length) return {};
    const db = getFirestore();
    const snap = await db.collection('settings').doc('payment').get();
    return snap.exists ? (snap.data() as Record<string, any>) : {};
  } catch (e) {
    console.warn('[gateway-creds] firebase read failed:', (e as Error).message);
    return {};
  }
}

/**
 * Returns gateway credentials. ENV wins; falls back to Firebase paymentSettings.
 * gateway = 'nagad' | 'sslcommerz' | 'razorpay' | 'bkash'
 */
export async function getGatewayCreds(gateway: string): Promise<Record<string, string>> {
  const fbAll = await readFirebasePaymentSettings();
  const fb = (fbAll?.[gateway] || {}) as Record<string, string>;

  const pick = (envKey: string, fbKey: string): string =>
    (process.env[envKey] && String(process.env[envKey])) || (fb?.[fbKey] ? String(fb[fbKey]) : '');

  switch (gateway) {
    case 'nagad':
      return {
        merchantId: pick('NAGAD_MERCHANT_ID', 'merchantId'),
        merchantNumber: pick('NAGAD_MERCHANT_NUMBER', 'merchantNumber'),
        publicKey: pick('NAGAD_PUBLIC_KEY', 'publicKey'),
        privateKey: pick('NAGAD_PRIVATE_KEY', 'privateKey'),
        baseUrl:
          pick('NAGAD_BASE_URL', 'baseUrl') ||
          'https://api.mynagad.com/api/dfs', // live
        callbackUrl: pick('NAGAD_CALLBACK_URL', 'callbackUrl'),
      };
    case 'sslcommerz':
      return {
        storeId: pick('SSLCZ_STORE_ID', 'storeId'),
        storePass: pick('SSLCZ_STORE_PASSWORD', 'storePassword'),
        isSandbox: pick('SSLCZ_SANDBOX', 'sandbox') || 'true',
      };
    case 'razorpay':
      return {
        keyId: pick('RAZORPAY_KEY_ID', 'keyId'),
        keySecret: pick('RAZORPAY_KEY_SECRET', 'keySecret'),
      };
    case 'bkash':
      return {
        appKey: pick('BKASH_APP_KEY', 'appKey'),
        appSecret: pick('BKASH_APP_SECRET', 'appSecret'),
        username: pick('BKASH_USERNAME', 'username'),
        password: pick('BKASH_PASSWORD', 'password'),
        baseUrl:
          pick('BKASH_BASE_URL', 'baseUrl') ||
          'https://tokenized.pay.bka.sh/v1.2.0-beta',
      };
    default:
      return {};
  }
}

export function missingCreds(creds: Record<string, string>, required: string[]): string[] {
  return required.filter((k) => !creds[k]);
}

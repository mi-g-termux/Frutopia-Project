// api/_lib/getGatewayCreds.ts
// Reads gateway credentials with env-first, Firebase-fallback strategy.
// Works on Vercel Serverless (Node 18+).
//
// Firebase doc path: settings/paymentSettings (flat camelCase keys)
// matching exactly what AdminPanel saves via db.ts savePaymentSettings().

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
    // CORRECT path: settings/paymentSettings — matches db.ts savePaymentSettings()
    const snap = await db.collection('settings').doc('paymentSettings').get();
    return snap.exists ? (snap.data() as Record<string, any>) : {};
  } catch (e) {
    console.warn('[gateway-creds] firebase read failed:', (e as Error).message);
    return {};
  }
}

/**
 * Returns gateway credentials. ENV vars win; falls back to Firestore paymentSettings doc.
 * Field names match the flat camelCase keys AdminPanel stores in Firestore.
 * gateway = 'nagad' | 'sslcommerz' | 'razorpay' | 'bkash'
 */
export async function getGatewayCreds(gateway: string): Promise<Record<string, string>> {
  const fb = await readFirebasePaymentSettings();

  // ENV wins over Firestore. Both fall back to empty string.
  const pick = (envKey: string, fbKey: string): string =>
    (process.env[envKey] ? String(process.env[envKey]) : '') ||
    (fb[fbKey] ? String(fb[fbKey]) : '');

  switch (gateway) {
    case 'stripe':
      return {
        secretKey:  pick('STRIPE_SECRET_KEY',  'stripeSecretKey'),
        publicKey:  pick('STRIPE_PUBLIC_KEY',  'stripePublicKey'),
        isSandbox:  pick('STRIPE_SANDBOX',     'stripeSandboxMode') || 'true',
      };

    case 'paypal':
      return {
        clientId:     pick('PAYPAL_CLIENT_ID',     'paypalClientId'),
        clientSecret: pick('PAYPAL_CLIENT_SECRET', 'paypalClientSecret'),
        isSandbox:    pick('PAYPAL_SANDBOX',       'paypalSandboxMode') || 'true',
      };

    case 'sslcommerz':
      return {
        storeId:   pick('SSLCZ_STORE_ID',       'sslCommerzStoreId'),
        storePass: pick('SSLCZ_STORE_PASSWORD',  'sslCommerzStorePassword'),
        isSandbox: pick('SSLCZ_SANDBOX',         'sslCommerzSandboxMode') || 'true',
      };

    case 'nagad':
      return {
        merchantId:     pick('NAGAD_MERCHANT_ID',      'nagadMerchantId'),
        merchantNumber: pick('NAGAD_MERCHANT_NUMBER',  'nagadMerchantNumber'),
        publicKey:      pick('NAGAD_PUBLIC_KEY',       'nagadPublicKey'),
        privateKey:     pick('NAGAD_PRIVATE_KEY',      'nagadMerchantPrivateKey'),
        baseUrl:        pick('NAGAD_BASE_URL',         'nagadBaseUrl') ||
                        'https://api.mynagad.com/api/dfs',
        callbackUrl:    pick('NAGAD_CALLBACK_URL',     'nagadCallbackUrl'),
        isSandbox:      pick('NAGAD_SANDBOX',          'nagadSandboxMode') || 'true',
      };

    case 'razorpay':
      return {
        keyId:     pick('RAZORPAY_KEY_ID',     'razorpayKeyId'),
        keySecret: pick('RAZORPAY_KEY_SECRET', 'razorpayKeySecret'),
        isSandbox: pick('RAZORPAY_SANDBOX',    'razorpaySandboxMode') || 'false',
      };

    case 'bkash':
      return {
        appKey:   pick('BKASH_APP_KEY',    'bKashAppKey'),
        appSecret:pick('BKASH_APP_SECRET', 'bKashAppSecret'),
        username: pick('BKASH_USERNAME',   'bKashUsername'),
        password: pick('BKASH_PASSWORD',   'bKashPassword'),
        baseUrl:  pick('BKASH_BASE_URL',   'bKashBaseUrl') ||
                  'https://tokenized.pay.bka.sh/v1.2.0-beta',
        isSandbox:pick('BKASH_SANDBOX',    'bKashSandboxMode') || 'true',
      };

    default:
      return {};
  }
}

export function missingCreds(creds: Record<string, string>, required: string[]): string[] {
  return required.filter((k) => !creds[k]);
}

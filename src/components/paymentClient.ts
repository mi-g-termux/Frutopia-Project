// src/components/paymentClient.ts
// Drop-in helpers used by CartModal for each Auto gateway.
// Import and call from CartModal's `handlePlaceOrder` switch.

export type OrderBasics = {
  orderId: string;
  amount: number;
  customer: {
    name: string;
    email: string;
    phone: string;
    address?: string;
    city?: string;
    country?: string;
  };
  productName?: string;
};

// ---- bKash (already shipped in v2, kept here for parity) ----
export async function startBkash(o: OrderBasics): Promise<void> {
  const r = await fetch('/api/bkash/create-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: o.amount, orderId: o.orderId }),
  });
  const j = await r.json();
  if (!r.ok || !j?.bkashURL) throw new Error(j?.error || 'bKash init failed');
  // Persist pending order BEFORE redirect (handled in CartModal already)
  window.location.href = j.bkashURL;
}

// ---- Nagad (Auto) ----
export async function startNagad(o: OrderBasics): Promise<void> {
  const r = await fetch('/api/nagad/create-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: o.amount, orderId: o.orderId }),
  });
  const j = await r.json();
  if (!r.ok || !j?.callBackUrl) throw new Error(j?.error || 'Nagad init failed');
  window.location.href = j.callBackUrl;
}

// ---- SSLCommerz (Auto) ----
export async function startSSLCommerz(o: OrderBasics): Promise<void> {
  const r = await fetch('/api/sslcommerz/create-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: o.amount,
      orderId: o.orderId,
      customer: o.customer,
      productName: o.productName,
    }),
  });
  const j = await r.json();
  if (!r.ok || !j?.redirectUrl) throw new Error(j?.error || 'SSLCommerz init failed');
  window.location.href = j.redirectUrl;
}

// ---- Razorpay (Auto) ----
declare global {
  interface Window {
    Razorpay?: any;
  }
}
function loadRzpScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Razorpay'));
    document.body.appendChild(s);
  });
}

export async function startRazorpay(
  o: OrderBasics,
  onSuccess: (p: { paymentId: string; orderId: string; signature: string }) => Promise<void> | void,
  onFailure?: (err: any) => void,
): Promise<void> {
  const r = await fetch('/api/razorpay/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: o.amount, currency: 'INR', receipt: o.orderId }),
  });
  const j = await r.json();
  if (!r.ok || !j?.orderId || !j?.keyId) throw new Error(j?.error || 'Razorpay order failed');

  await loadRzpScript();
  const rzp = new window.Razorpay({
    key: j.keyId,
    amount: j.amount,
    currency: j.currency,
    order_id: j.orderId,
    name: o.productName || 'Frutopia',
    prefill: { name: o.customer.name, email: o.customer.email, contact: o.customer.phone },
    handler: async (resp: any) => {
      const v = await fetch('/api/razorpay/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_order_id: resp.razorpay_order_id,
          razorpay_payment_id: resp.razorpay_payment_id,
          razorpay_signature: resp.razorpay_signature,
        }),
      }).then((x) => x.json());
      if (!v?.success) return onFailure?.(new Error('Signature verification failed'));
      await onSuccess({
        paymentId: resp.razorpay_payment_id,
        orderId: resp.razorpay_order_id,
        signature: resp.razorpay_signature,
      });
    },
    modal: { ondismiss: () => onFailure?.(new Error('Razorpay closed')) },
  });
  rzp.open();
}

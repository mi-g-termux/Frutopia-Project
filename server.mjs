import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const { fileURLToPath } = require('url');
const { createServer: createViteServer } = await import('vite');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Input sanitization helpers ────────────────────────────────────────────────
function sanitizeStr(s, max = 2000) { return typeof s === 'string' ? s.replace(/<[^>]*>/g, '').substring(0, max) : ''; }
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e)); }

// ── Transporter pool (reuse connections for speed) ────────────────────────────
const _transporterCache = new Map();
function getTransporter(smtp) {
  const cacheKey = `${smtp.host}:${smtp.port}:${smtp.email}`;
  if (_transporterCache.has(cacheKey)) return _transporterCache.get(cacheKey);
  const port = Number(smtp.port || 587);
  const t = nodemailer.createTransport({
    host: smtp.host,
    port,
    secure: port === 465,
    auth: { user: smtp.email, pass: smtp.password },
    tls: { rejectUnauthorized: false },
    pool: true,           // keep TCP connections alive
    maxConnections: 5,
    maxMessages: 100,
    rateLimit: 14,        // messages per second (safe for most ESPs)
  });
  _transporterCache.set(cacheKey, t);
  return t;
}

// ── Rate limiter (OTP abuse protection) ──────────────────────────────────────
const _rateLimitMap = new Map(); // key -> { count, windowStart }
function checkRateLimit(key, maxPerWindow = 5, windowMs = 60_000) {
  const now = Date.now();
  const entry = _rateLimitMap.get(key) || { count: 0, windowStart: now };
  if (now - entry.windowStart > windowMs) {
    // reset window
    _rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= maxPerWindow) return false;
  entry.count++;
  _rateLimitMap.set(key, entry);
  return true;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const PORT = process.env.PORT || 3005;
  const isProd = process.env.NODE_ENV === 'production';

  // ── CORS headers for dev ──────────────────────────────────────────────────
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // --- HEALTH ---
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'healthy', time: new Date().toISOString() });
  });

  // --- SEND EMAIL (pooled, fast) ---
  app.post('/api/send-email', async (req, res) => {
    const raw = req.body || {};
    const to      = sanitizeStr(raw.to, 254);
    const subject = sanitizeStr(raw.subject, 200);
    const html    = sanitizeStr(raw.html, 50000);
    const { smtpSettings } = raw;
    if (!to || !subject || !html) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, html' });
    }
    if (!isValidEmail(to)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    const smtp = smtpSettings || { isEnabled: false };
    if (!smtp.isEnabled || !smtp.host || !smtp.email || !smtp.password) {
      console.log(`[EMAIL SKIPPED] SMTP not configured → ${to} | ${subject}`);
      return res.json({ success: true, simulated: true, message: 'SMTP not configured — email skipped.' });
    }
    try {
      const transporter = getTransporter(smtp);
      // verify once every 5 minutes (cached)
      const info = await transporter.sendMail({
        from: `"${smtp.fromName || 'Store'}" <${smtp.email}>`,
        to, subject, html,
        headers: {
          'X-Priority': '1',
          'X-Mailer': 'E-Shop Mailer v5.6',
        },
      });
      console.log(`[EMAIL SENT] To: ${to} | ID: ${info.messageId}`);
      return res.json({ success: true, messageId: info.messageId });
    } catch (err) {
      // Invalidate cached transporter on auth errors so it rebuilds
      const cacheKey = `${smtp.host}:${smtp.port}:${smtp.email}`;
      _transporterCache.delete(cacheKey);
      console.error('[EMAIL ERROR]', err.message);
      return res.status(500).json({
        success: false, error: err.message,
        hint: 'For Gmail: use an App Password (not your Gmail password). Enable 2FA → myaccount.google.com/apppasswords',
      });
    }
  });

  // --- SEND SMS OTP via Twilio ---
  app.post('/api/send-sms', async (req, res) => {
    const raw = req.body || {};
    const to      = sanitizeStr(raw.to, 20);
    const message = sanitizeStr(raw.message, 500);
    const { twilioSettings } = raw;
    if (!to || !message) return res.status(400).json({ error: 'Missing fields' });
    
    const ts = twilioSettings || {};
    if (!ts.isEnabled || !ts.accountSid || !ts.authToken || !ts.fromNumber) {
      console.log(`[SMS SKIPPED] Twilio not configured → ${to}`);
      return res.json({ success: true, simulated: true, message: 'SMS gateway not configured.' });
    }

    // Rate limit: max 3 SMS per phone number per minute
    const rateLimitKey = `sms:${to}`;
    if (!checkRateLimit(rateLimitKey, 3, 60_000)) {
      return res.status(429).json({ success: false, error: 'Too many SMS requests. Please wait before requesting another OTP.' });
    }

    try {
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${ts.accountSid}/Messages.json`;
      const basicAuth = Buffer.from(`${ts.accountSid}:${ts.authToken}`).toString('base64');
      const body = new URLSearchParams({ To: to, From: ts.fromNumber, Body: message });

      const resp = await fetch(twilioUrl, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await resp.json();
      if (data.sid) {
        console.log(`[SMS SENT] To: ${to} | SID: ${data.sid}`);
        return res.json({ success: true, sid: data.sid });
      }
      return res.status(502).json({ success: false, error: data.message || 'Twilio error', code: data.code });
    } catch (err) {
      console.error('[SMS ERROR]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- VERIFY EMAIL (send verification link) ---
  app.post('/api/send-verification', async (req, res) => {
    const raw = req.body || {};
    const email     = sanitizeStr(raw.email, 254);
    const token     = sanitizeStr(raw.token, 200);
    const storeName = sanitizeStr(raw.storeName, 100);
    const { smtpSettings } = raw;
    if (!email || !token) return res.status(400).json({ error: 'Missing email or token' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });

    const smtp = smtpSettings || { isEnabled: false };
    const baseUrl = req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const verifyUrl = `${baseUrl}?verify_token=${token}&verify_email=${encodeURIComponent(email)}`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:32px;background:#f8fafc;border-radius:12px;">
        <div style="background:#10b981;border-radius:8px;padding:20px 24px;text-align:center;margin-bottom:24px;">
          <div style="font-size:36px;margin-bottom:6px;">✉️</div>
          <div style="color:#fff;font-size:18px;font-weight:800;">${storeName || 'E-Shop'}</div>
          <div style="color:#d1fae5;font-size:12px;margin-top:4px;">Email Verification</div>
        </div>
        <h2 style="color:#0f172a;font-size:16px;margin:0 0 10px;">Verify your email address</h2>
        <p style="color:#475569;font-size:13px;margin:0 0 20px;">Click the button below to verify your email and activate your account. This link expires in <strong>24 hours</strong>.</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${verifyUrl}" style="display:inline-block;background:#10b981;color:#fff;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;">✅ Verify My Email</a>
        </div>
        <p style="color:#94a3b8;font-size:11px;text-align:center;">If you didn't create this account, please ignore this email.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;"/>
        <p style="color:#94a3b8;font-size:10px;text-align:center;">Or copy this link: <a href="${verifyUrl}" style="color:#10b981;">${verifyUrl}</a></p>
      </div>`;

    if (!smtp.isEnabled || !smtp.host || !smtp.email || !smtp.password) {
      console.log(`[VERIFY SKIPPED] SMTP not configured → ${email} | Token: ${token}`);
      return res.json({ success: true, simulated: true });
    }

    try {
      const transporter = getTransporter(smtp);
      await transporter.sendMail({
        from: `"${smtp.fromName || storeName || 'Store'}" <${smtp.email}>`,
        to: email,
        subject: `Verify your ${storeName || 'E-Shop'} account`,
        html,
      });
      return res.json({ success: true });
    } catch (err) {
      console.error('[VERIFY EMAIL ERROR]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- SEND WHATSAPP (Meta Cloud API) ---
  app.post('/api/send-whatsapp', async (req, res) => {
    const raw = req.body || {};
    const to = sanitizeStr(raw.to, 20);
    const { waSettings } = raw;
    const phoneNumberId = waSettings?.phoneNumberId;
    const accessToken = waSettings?.accessToken;
    const templateName = waSettings?.templateName || 'hello_world';

    if (!phoneNumberId || !accessToken) {
      return res.json({ success: false, error: 'WhatsApp not configured', simulated: true });
    }
    if (!to) return res.status(400).json({ success: false, error: 'Missing recipient phone number' });

    try {
      const waRes = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: { name: templateName, language: { code: 'en_US' } },
        }),
      });
      const data = await waRes.json();
      if (data.messages?.[0]?.id) {
        console.log(`[WHATSAPP SENT] To: ${to} | MsgId: ${data.messages[0].id}`);
        return res.json({ success: true, messageId: data.messages[0].id });
      }
      return res.status(502).json({ success: false, error: data.error?.message || 'WhatsApp API error', detail: data });
    } catch (err) {
      console.error('[WHATSAPP ERROR]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- STRIPE ---
  // Creates a Stripe PaymentIntent and returns clientSecret to the frontend.
  app.post('/api/stripe/create-payment-intent', async (req, res) => {
    const { amount, currency = 'usd', stripeSecretKey, sandboxMode } = req.body || {};
    if (!stripeSecretKey)
      return res.status(400).json({ error: 'Stripe secret key not configured.' });
    if (!amount || isNaN(Number(amount)))
      return res.status(400).json({ error: 'Invalid amount.' });
    try {
      // amount in smallest currency unit (cents for USD)
      const amountCents = Math.round(Number(amount) * 100);
      const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          amount: String(amountCents),
          currency,
          'automatic_payment_methods[enabled]': 'true',
        }).toString(),
      });
      const data = await stripeRes.json();
      if (data.error) return res.status(502).json({ error: data.error.message });
      return res.json({ success: true, clientSecret: data.client_secret, paymentIntentId: data.id });
    } catch (err) {
      return res.status(500).json({ error: `Stripe API error: ${err.message}` });
    }
  });

  // Confirms a Stripe PaymentIntent with a card token (created on the frontend via Stripe.js)
  app.post('/api/stripe/confirm-payment', async (req, res) => {
    const { paymentIntentId, paymentMethodId, stripeSecretKey } = req.body || {};
    if (!stripeSecretKey || !paymentIntentId || !paymentMethodId)
      return res.status(400).json({ error: 'Missing required Stripe parameters.' });
    try {
      const confirmRes = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}/confirm`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ payment_method: paymentMethodId }).toString(),
      });
      const data = await confirmRes.json();
      if (data.error) return res.status(502).json({ error: data.error.message });
      if (data.status === 'succeeded' || data.status === 'requires_capture')
        return res.json({ success: true, status: data.status, transactionId: data.id });
      return res.status(502).json({ error: `Unexpected Stripe status: ${data.status}`, status: data.status });
    } catch (err) {
      return res.status(500).json({ error: `Stripe confirm error: ${err.message}` });
    }
  });

  // --- PAYPAL ---
  // Step 1: Create a PayPal order and return orderId + approvalUrl
  app.post('/api/paypal/create-order', async (req, res) => {
    const { amount, currency = 'USD', clientId, clientSecret, sandboxMode } = req.body || {};
    if (!clientId || !clientSecret)
      return res.status(400).json({ error: 'PayPal credentials not configured.' });
    if (!amount || isNaN(Number(amount)))
      return res.status(400).json({ error: 'Invalid amount.' });
    const baseUrl = sandboxMode !== false
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com';
    try {
      // Get access token
      const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token)
        return res.status(502).json({ error: 'PayPal token grant failed.', detail: tokenData });

      // Create order
      const orderRes = await fetch(`${baseUrl}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            amount: { currency_code: currency, value: Number(amount).toFixed(2) },
          }],
          application_context: {
            return_url: `${req.protocol}://${req.get('host')}/api/paypal/callback?status=success`,
            cancel_url: `${req.protocol}://${req.get('host')}/api/paypal/callback?status=cancelled`,
          },
        }),
      });
      const orderData = await orderRes.json();
      if (orderData.id) {
        const approvalLink = orderData.links?.find(l => l.rel === 'approve')?.href;
        return res.json({ success: true, orderId: orderData.id, approvalUrl: approvalLink });
      }
      return res.status(502).json({ error: 'PayPal order creation failed.', detail: orderData });
    } catch (err) {
      return res.status(500).json({ error: `PayPal API error: ${err.message}` });
    }
  });

  // Step 2: Capture a PayPal order after buyer approves
  app.post('/api/paypal/capture-order', async (req, res) => {
    const { orderId, clientId, clientSecret, sandboxMode } = req.body || {};
    if (!clientId || !clientSecret || !orderId)
      return res.status(400).json({ error: 'Missing PayPal capture parameters.' });
    const baseUrl = sandboxMode !== false
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com';
    try {
      const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token)
        return res.status(502).json({ error: 'PayPal token grant failed.' });

      const captureRes = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json',
        },
      });
      const captureData = await captureRes.json();
      if (captureData.status === 'COMPLETED') {
        const txnId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id;
        return res.json({ success: true, status: 'COMPLETED', transactionId: txnId });
      }
      return res.status(502).json({ error: 'PayPal capture failed.', detail: captureData });
    } catch (err) {
      return res.status(500).json({ error: `PayPal capture error: ${err.message}` });
    }
  });

  app.get('/api/paypal/callback', (req, res) => {
    const { token, status } = req.query; // token = PayPal orderId
    if (status === 'cancelled')
      return res.redirect(`/?paypal=cancelled&orderId=${token}`);
    res.redirect(`/?paypal=approved&orderId=${token}`);
  });

  // --- SSLCOMMERZ ---
  app.post('/api/sslcommerz/create-payment', async (req, res) => {
    const { amount, currency = 'BDT', orderId, customerName, customerEmail, customerPhone, customerAddress, storeId, storePassword, sandboxMode } = req.body || {};
    if (!storeId || !storePassword)
      return res.status(400).json({ error: 'SSLCommerz credentials not configured.' });
    const baseUrl = sandboxMode !== false
      ? 'https://sandbox.sslcommerz.com'
      : 'https://securepay.sslcommerz.com';
    try {
      const params = new URLSearchParams({
        store_id: storeId,
        store_passwd: storePassword,
        total_amount: Number(amount).toFixed(2),
        currency,
        tran_id: orderId || `QF-${Date.now()}`,
        success_url: `${req.protocol}://${req.get('host')}/api/sslcommerz/callback?status=success`,
        fail_url: `${req.protocol}://${req.get('host')}/api/sslcommerz/callback?status=failed`,
        cancel_url: `${req.protocol}://${req.get('host')}/api/sslcommerz/callback?status=cancelled`,
        ipn_url: `${req.protocol}://${req.get('host')}/api/sslcommerz/ipn`,
        cus_name: customerName || 'Customer',
        cus_email: customerEmail || 'customer@example.com',
        cus_phone: customerPhone || '01700000000',
        cus_add1: customerAddress || 'Dhaka',
        cus_city: 'Dhaka',
        cus_country: 'Bangladesh',
        shipping_method: 'NO',
        product_name: 'Order',
        product_category: 'General',
        product_profile: 'general',
      });
      const sslRes = await fetch(`${baseUrl}/gwprocess/v4/api.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const data = await sslRes.json();
      if (data.status === 'SUCCESS' && data.GatewayPageURL)
        return res.json({ success: true, gatewayUrl: data.GatewayPageURL, sessionKey: data.sessionkey });
      return res.status(502).json({ error: 'SSLCommerz session initiation failed.', detail: data });
    } catch (err) {
      return res.status(500).json({ error: `SSLCommerz API error: ${err.message}` });
    }
  });

  app.get('/api/sslcommerz/callback', (req, res) => {
    const { status } = req.query;
    if (status === 'success') return res.redirect('/?sslcommerz=success');
    if (status === 'failed') return res.redirect('/?sslcommerz=failed');
    res.redirect('/?sslcommerz=cancelled');
  });

  app.post('/api/sslcommerz/ipn', (req, res) => {
    // IPN (Instant Payment Notification) — log and acknowledge
    console.log('[SSLCommerz IPN]', req.body);
    res.status(200).send('OK');
  });

  // --- RAZORPAY ---
  // Creates a Razorpay order and returns orderId + key for frontend SDK
  app.post('/api/razorpay/create-order', async (req, res) => {
    const { amount, currency = 'INR', keyId, keySecret, orderId, sandboxMode } = req.body || {};
    if (!keyId || !keySecret)
      return res.status(400).json({ error: 'Razorpay credentials not configured.' });
    if (!amount || isNaN(Number(amount)))
      return res.status(400).json({ error: 'Invalid amount.' });
    try {
      const amountPaise = Math.round(Number(amount) * 100); // Razorpay uses smallest unit
      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency,
          receipt: orderId || `QF-${Date.now()}`,
          payment_capture: 1,
        }),
      });
      const data = await rzpRes.json();
      if (data.id) return res.json({ success: true, rzpOrderId: data.id, amount: data.amount, currency: data.currency, keyId });
      return res.status(502).json({ error: 'Razorpay order creation failed.', detail: data });
    } catch (err) {
      return res.status(500).json({ error: `Razorpay API error: ${err.message}` });
    }
  });

  // Verifies Razorpay payment signature after successful checkout
  app.post('/api/razorpay/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, keySecret } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !keySecret)
      return res.status(400).json({ error: 'Missing verification parameters.' });
    try {
      const crypto = require('crypto');
      const expectedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');
      if (expectedSignature === razorpay_signature)
        return res.json({ success: true, verified: true, transactionId: razorpay_payment_id });
      return res.status(400).json({ error: 'Signature verification failed. Payment may be tampered.', verified: false });
    } catch (err) {
      return res.status(500).json({ error: `Razorpay verify error: ${err.message}` });
    }
  });

  // --- BKASH ---
  app.post('/api/bkash/create-payment', async (req, res) => {
    const { amount, orderId, appKey, appSecret, username, password, sandboxMode } = req.body || {};
    if (!appKey || !appSecret || !username || !password)
      return res.status(400).json({ error: 'bKash API credentials not configured.' });
    const baseUrl = sandboxMode
      ? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta'
      : 'https://tokenized.pay.bka.sh/v1.2.0-beta';
    try {
      const tokenRes = await fetch(`${baseUrl}/tokenized/checkout/token/grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', username, password },
        body: JSON.stringify({ app_key: appKey, app_secret: appSecret }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.id_token)
        return res.status(502).json({ error: 'bKash token grant failed.', detail: tokenData });
      const createRes = await fetch(`${baseUrl}/tokenized/checkout/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: tokenData.id_token, 'X-APP-Key': appKey },
        body: JSON.stringify({
          mode: '0011', payerReference: orderId,
          callbackURL: `${req.protocol}://${req.get('host')}/api/bkash/callback`,
          amount: String(amount), currency: 'BDT', intent: 'sale', merchantInvoiceNumber: orderId,
        }),
      });
      const createData = await createRes.json();
      if (createData.statusCode === '0000' && createData.bkashURL)
        return res.json({ success: true, bkashURL: createData.bkashURL, paymentID: createData.paymentID });
      return res.status(502).json({ error: 'bKash payment creation failed.', detail: createData });
    } catch (err) {
      return res.status(500).json({ error: `bKash API error: ${err.message}` });
    }
  });

  app.get('/api/bkash/callback', (req, res) => {
    const { paymentID, status } = req.query;
    if (status === 'cancel' || status === 'failure')
      return res.redirect(`/?bkash=failed&paymentID=${paymentID}`);
    res.redirect(`/?bkash=success&paymentID=${paymentID}`);
  });

  // --- NAGAD ---
  app.post('/api/nagad/create-payment', async (req, res) => {
    const { amount, orderId, merchantId, sandboxMode } = req.body || {};
    if (!merchantId)
      return res.status(400).json({ error: 'Nagad Merchant ID not configured.' });
    const baseUrl = sandboxMode
      ? 'https://sandbox.mynagad.com:10080/remote-payment-gateway-1.0/api/dfs'
      : 'https://api.mynagad.com/api/dfs';
    const datetime = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    try {
      const initRes = await fetch(`${baseUrl}/check-out/initialize/${merchantId}/${orderId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-KM-Api-Version': 'v-0.2.0', 'X-KM-IP-V4': req.ip || '127.0.0.1', 'X-KM-Client-Type': 'PC_WEB', 'X-KM-MC-Id': merchantId },
        body: JSON.stringify({ dateTime: datetime, sensitiveData: Buffer.from(JSON.stringify({ merchantId, orderId, datetime, challenge: orderId })).toString('base64'), signature: '' }),
      });
      const initData = await initRes.json();
      if (initData.callBackUrl)
        return res.json({ success: true, nagadURL: initData.callBackUrl, paymentReferenceId: initData.paymentReferenceId });
      return res.status(502).json({ error: 'Nagad initialization failed.', detail: initData });
    } catch (err) {
      return res.status(500).json({ error: `Nagad API error: ${err.message}` });
    }
  });

  app.get('/api/nagad/callback', (req, res) => {
    const { order_id, payment_ref_id, status } = req.query;
    if (status === 'Aborted' || status === 'Cancelled')
      return res.redirect(`/?nagad=failed&order=${order_id}`);
    res.redirect(`/?nagad=success&order=${order_id}&ref=${payment_ref_id}`);
  });

  // --- SERVE firebase-config.json to ALL browsers (cross-browser fix) ---
  // Vite only serves files from public/ so we also expose a dedicated route
  // so any browser (not just the one that ran the installer) can load it.
  app.get('/firebase-config.json', (req, res) => {
    const fs = require('fs');
    const locations = [
      path.join(__dirname, 'public', 'firebase-config.json'),
      path.join(__dirname, 'firebase-config.json'),
      path.join(__dirname, 'dist', 'firebase-config.json'),
    ];
    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        return res.sendFile(loc);
      }
    }
    res.status(404).json({ error: 'firebase-config.json not found. Run the install wizard first.' });
  });

  // --- SAVE FIREBASE CONFIG (Node/VPS equivalent of install-helper.php) ---
  // Receives Firebase credentials from InstallWizard and writes
  // firebase-config.json to the dist/ (prod) or project root (dev) directory.
  // A lock file prevents overwriting after a successful install.
  app.get('/api/save-config', (_req, res) => {
    // probeInstallHelper() uses a GET probe to detect this endpoint exists.
    res.json({ ok: true, message: 'Fruitopia Node save-config endpoint ready.' });
  });

  app.post('/api/save-config', async (req, res) => {
    const fs   = require('fs');
    const data = req.body || {};

    const required = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
    for (const field of required) {
      if (!data[field] || typeof data[field] !== 'string' || !data[field].trim()) {
        return res.status(400).json({ success: false, message: `Missing required field: "${field}"` });
      }
    }

    if (!data.apiKey.trim().startsWith('AIza')) {
      return res.status(400).json({ success: false, message: 'Invalid apiKey format. Firebase Web API keys start with "AIza".' });
    }

    // Determine output path — write alongside index.html so the static server
    // and the fetch('/firebase-config.json') both resolve correctly.
    const outDir  = isProd ? path.join(__dirname, 'dist') : path.join(__dirname, 'public');
    const cfgFile = path.join(outDir, 'firebase-config.json');
    const lockFile = isProd ? path.join(path.join(__dirname, 'dist'), 'install-helper.lock') : path.join(__dirname, 'install-helper.lock');

    if (fs.existsSync(lockFile)) {
      return res.status(403).json({ success: false, message: 'Already installed. Delete install-helper.lock to reinstall.' });
    }

    const configData = {
      apiKey:            data.apiKey.trim(),
      authDomain:        data.authDomain.trim(),
      projectId:         data.projectId.trim(),
      storageBucket:     data.storageBucket.trim(),
      messagingSenderId: data.messagingSenderId.trim(),
      appId:             data.appId.trim(),
      ...(data.databaseId?.trim() ? { databaseId: data.databaseId.trim() } : {}),
    };

    try {
      fs.writeFileSync(cfgFile, JSON.stringify(configData, null, 2), 'utf8');
      fs.writeFileSync(lockFile, JSON.stringify({
        lockedAt:  new Date().toISOString(),
        projectId: configData.projectId,
        message:   'Fruitopia installation complete. Delete this file to allow reinstallation.',
      }, null, 2), 'utf8');
      res.json({ success: true, message: 'firebase-config.json saved successfully.' });
    } catch (err) {
      console.error('[save-config] Write error:', err);
      res.status(500).json({ success: false, message: `Failed to write config: ${err.message}` });
    }
  });

  // --- VITE DEV or STATIC PROD ---
  if (!isProd) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[OK] Server running → http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('[CRITICAL] Server startup error:', err);
  process.exit(1);
});

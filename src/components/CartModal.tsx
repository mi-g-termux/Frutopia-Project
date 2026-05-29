/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { useToast } from './Toast';
import { X, Minus, Plus, Trash2, Tag, Ticket, CreditCard, ShoppingBag, Landmark, Sparkles, Printer, Phone, Shield, CheckCircle2 } from 'lucide-react';
import { Order, CartItem } from '../types';
import { BkashLogo, NagadLogo, StripeLogo, PaypalLogo, VisaMastercardLogo, RocketLogo, QuirkyFruityLogo } from './PaymentLogos';
import { COUNTRY_PHONE_RULES, findRule, validatePhone, toE164 } from '../lib/phoneValidation';

interface CartModalProps {
  isOpen: boolean;
  onClose: () => void;
  emailVerified?: boolean;
}


// ─── Tiny QR-code renderer (no external lib) ────────────────────────────────
// Uses the browser's built-in canvas + a minimal QR matrix generator via
// the qrcodegen reference library loaded inline as a data URL approach.
// We use a simple URL-encoding trick: render QR via Google Charts API in
// an <img> tag (works offline via cache, no tracking pixel).
const QRCodeImg = ({ value, size = 96 }: { value: string; size?: number }) => {
  const encoded = encodeURIComponent(value);
  // Use the QR server API — purely client-side redirect, no data stored
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}&margin=4&color=1e293b&bgcolor=ffffff`;
  return (
    <img
      src={src}
      alt="Order QR Code"
      width={size}
      height={size}
      style={{ imageRendering: 'pixelated', display: 'block' }}
    />
  );
};
// ─────────────────────────────────────────────────────────────────────────────

export const CartModal = ({ isOpen, onClose, emailVerified = true }: CartModalProps) => {
  const {
    cart,
    siteSettings,
    paymentSettings,
    appliedCoupon,
    updateCartQuantity,
    removeFromCart,
    applyCouponCode,
    removeCoupon,
    placeOrder,
    clearCart,
    setCurrentUserEmail,
    formatPrice,
    userProfile,
    isUserLoggedIn,
    deliveryZones,
    getZoneForCity,
    smsSettings,
    sendSmsOtp,
    verifySmsOtp,
  } = useApp();

  const toast = useToast();

  // ✅ Handle bKash/Nagad/PayPal/SSLCommerz redirect callback — complete pending order on return
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bkashStatus   = params.get('bkash');
    const nagadStatus   = params.get('nagad');
    const paypalStatus  = params.get('paypal');
    const sslStatus     = params.get('sslcommerz');

    const successStatuses = [
      bkashStatus === 'success',
      nagadStatus === 'success',
      sslStatus === 'success',
    ];

    const failStatuses = [
      bkashStatus === 'failed',
      nagadStatus === 'failed',
      paypalStatus === 'cancelled',
      sslStatus === 'failed' || sslStatus === 'cancelled',
    ];

    const completePendingOrder = (methodOverride?: string) => {
      const pendingRaw   = localStorage.getItem('qf_pending_order');
      const pendingEmail = localStorage.getItem('qf_pending_email');
      if (!pendingRaw) return;
      try {
        const pendingOrder = JSON.parse(pendingRaw);
        if (methodOverride) pendingOrder.paymentMethod = methodOverride;
        placeOrder(pendingOrder).then((placed) => {
          if (pendingEmail) setCurrentUserEmail(pendingEmail);
          clearCart();
          setPlacedInvoiceOrder(placed);
          toast.success(`🎉 Payment confirmed! Order ${placed.orderNumber} confirmed.`);
          localStorage.removeItem('qf_pending_order');
          localStorage.removeItem('qf_pending_email');
          window.history.replaceState({}, '', window.location.pathname);
        });
      } catch {
        localStorage.removeItem('qf_pending_order');
      }
    };

    if (successStatuses.some(Boolean)) {
      completePendingOrder();
    } else if (paypalStatus === 'approved') {
      // PayPal buyer approved — now capture the payment server-side
      const paypalOrderId     = localStorage.getItem('qf_paypal_order_id') || params.get('token') || '';
      const paypalClientId    = localStorage.getItem('qf_paypal_client_id') || '';
      const paypalClientSecret = localStorage.getItem('qf_paypal_client_secret') || '';
      const paypalSandbox     = localStorage.getItem('qf_paypal_sandbox') !== 'false';

      if (paypalOrderId && paypalClientId) {
        fetch('/api/paypal/capture-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: paypalOrderId,
            clientId: paypalClientId,
            clientSecret: paypalClientSecret,
            sandboxMode: paypalSandbox,
          }),
        })
          .then(r => r.json())
          .then((data: any) => {
            localStorage.removeItem('qf_paypal_order_id');
            localStorage.removeItem('qf_paypal_client_id');
            localStorage.removeItem('qf_paypal_client_secret');
            localStorage.removeItem('qf_paypal_sandbox');
            if (data.success) {
              completePendingOrder(`PayPal (txn: ${data.transactionId})`);
            } else {
              toast.error(`PayPal capture failed: ${data.error}`);
              localStorage.removeItem('qf_pending_order');
              localStorage.removeItem('qf_pending_email');
              window.history.replaceState({}, '', window.location.pathname);
            }
          })
          .catch(() => {
            toast.error('PayPal capture network error. Contact support.');
            window.history.replaceState({}, '', window.location.pathname);
          });
      }
    } else if (failStatuses.some(Boolean)) {
      toast.error('Payment was cancelled or failed. Please try again.');
      localStorage.removeItem('qf_pending_order');
      localStorage.removeItem('qf_pending_email');
      localStorage.removeItem('qf_paypal_order_id');
      localStorage.removeItem('qf_paypal_client_id');
      localStorage.removeItem('qf_paypal_client_secret');
      localStorage.removeItem('qf_paypal_sandbox');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const [couponCode, setCouponCode] = useState('');
  
  // Checkout Shipping form — auto-filled from userProfile
  const [customerName, setCustomerName] = useState('');
  const [email, setEmail] = useState('');
  const [dialCode, setDialCode] = useState<string>('+880');
  const [phoneLocal, setPhoneLocal] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [deliveryNote, setDeliveryNote] = useState('');

  // Phone OTP verification state — used when admin enabled requireOtpAtCheckout
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifyingPhone, setOtpVerifyingPhone] = useState(''); // E.164 we last sent code to

  // Helper: split a stored "+880 1712345678" into dial + local parts
  const splitStoredPhone = (full: string): { dial: string; local: string } => {
    const trimmed = (full || '').trim();
    if (!trimmed) return { dial: '+880', local: '' };
    const sorted = [...COUNTRY_PHONE_RULES].sort((a, b) => b.dial.length - a.dial.length);
    for (const c of sorted) {
      if (trimmed.startsWith(c.dial)) {
        return { dial: c.dial, local: trimmed.slice(c.dial.length).replace(/[^\d]/g, '') };
      }
    }
    return { dial: '+880', local: trimmed.replace(/[^\d]/g, '') };
  };

  // Auto-fill from user profile when modal opens
  useEffect(() => {
    if (userProfile) {
      setCustomerName(userProfile.name || '');
      setEmail(userProfile.email || '');
      const p = splitStoredPhone(userProfile.phone || '');
      setDialCode(p.dial);
      setPhoneLocal(p.local);
      setAddress(userProfile.address || '');
      setCity(userProfile.city || '');
    }
  }, [userProfile, isUserLoggedIn]);

  // Reset OTP whenever the phone changes
  useEffect(() => {
    setOtpSent(false);
    setOtpVerified(false);
    setOtpCode('');
    setOtpVerifyingPhone('');
  }, [dialCode, phoneLocal]);

  // Convenience: live validation feedback for the phone field
  const phoneValidation = useMemo(
    () => validatePhone(dialCode, phoneLocal),
    [dialCode, phoneLocal],
  );
  const phoneRule = findRule(dialCode);

  const otpRequired =
    !!(smsSettings?.isEnabled && smsSettings?.otpEnabled && smsSettings?.requireOtpAtCheckout);
  const otpChannelLabel =
    smsSettings?.channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
  
  // Interactive Automatic Gateway Simulation states
  const [isAutoPortalOpen, setIsAutoPortalOpen] = useState(false);
  const [autoStep, setAutoStep] = useState(0); // 0: Account/Card details input, 1: OTP verification code, 2: PIN password collection, 3: Processing API, 4: Success confirmation
  const [autoPhoneInput, setAutoPhoneInput] = useState('');
  const [autoOtpInput, setAutoOtpInput] = useState('');
  const [autoPinInput, setAutoPinInput] = useState('');
  const [autoPaypalEmailInput, setAutoPaypalEmailInput] = useState('');
  const [autoPaypalPasswordInput, setAutoPaypalPasswordInput] = useState('');
  const [autoCardNumberInput, setAutoCardNumberInput] = useState('');
  const [autoCardExpiryInput, setAutoCardExpiryInput] = useState('');
  const [autoCardCvcInput, setAutoCardCvcInput] = useState('');
  const [autoCardHolderInput, setAutoCardHolderInput] = useState('');
  const [isSubmitLoading, setIsSubmitLoading] = useState(false);
  const [autoPortalError, setAutoPortalError] = useState('');
  const [storedOrderData, setStoredOrderData] = useState<any | null>(null);
  
  // Credit Card fields
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCVC, setCardCVC] = useState('');

  // Manual payment transaction reference
  const [manualTxId, setManualTxId] = useState('');

  // Selected payment method
  const [paymentMethod, setPaymentMethod] = useState<string>('COD');

  // Active Placement invoice state
  const [placedInvoiceOrder, setPlacedInvoiceOrder] = useState<Order | null>(null);

  // ✅ Zone lookup must be before early return — cannot call context functions after conditional returns
  const matchedZone = getZoneForCity(city);

  if (!isOpen) return null;

  const subtotal = cart.reduce((sum, item) => sum + (item.product.salePrice || item.product.price) * item.quantity, 0);
  const discountRate = appliedCoupon ? appliedCoupon.discountPercentage : 0;
  const discountAmount = (subtotal * discountRate) / 100;
  
  // Live delivery logic — zone-based pricing for any country
  const deliveryFee = matchedZone?.isEnabled ? matchedZone.fee : (paymentSettings?.shippingFee || 60);
  const taxRate = paymentSettings.taxPercentage || 0.05;
  const taxAmount = (subtotal - discountAmount) * taxRate;
  const grandTotal = Math.max(0, subtotal - discountAmount + deliveryFee + taxAmount);

  const handleApplyCoupon = (e: React.FormEvent) => {
    e.preventDefault();
    if (!couponCode.trim()) return;
    const res = applyCouponCode(couponCode);
    if (res.success) {
      toast.success(res.message);
    } else {
      toast.error(res.message);
    }
  };

  // Final E.164 string we'll persist with the order. Uses the validator
  // so users entering "01712345678" for BD still get stored as "+8801712345678".
  const phone = phoneValidation.ok ? phoneValidation.e164 : `${dialCode}${phoneLocal.replace(/\D/g, '')}`;

  const validateCheckoutForm = (): boolean => {
    if (!customerName.trim() || !email.trim() || !address.trim() || !city.trim()) {
      toast.error('All shipping fields marked with an asterisk (*) are required.');
      return false;
    }
    if (!phoneValidation.ok) {
      toast.error(phoneValidation.error || 'Please enter a valid mobile number for the selected country.');
      return false;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      toast.error('Form invalid: Please supply a genuine, valid email address.');
      return false;
    }

    if (['bKash', 'Nagad', 'Rocket', 'Bank', 'CreditManual'].includes(paymentMethod)) {
      if (!manualTxId.trim()) {
        toast.error(`Manual Verification: Please complete your mobile / bank / card txn sender reference details for ${paymentMethod}.`);
        return false;
      }
    }

    if (otpRequired && (!otpVerified || otpVerifyingPhone !== phone)) {
      toast.error(`Please verify your phone number via ${otpChannelLabel} OTP before placing the order.`);
      return false;
    }

    return true;
  };

  /** Send an OTP code to the current phone, via SMS or WhatsApp (admin choice). */
  const handleSendOtp = async () => {
    if (!phoneValidation.ok) {
      toast.error(phoneValidation.error || 'Enter a valid phone number first.');
      return;
    }
    if (!smsSettings?.isEnabled || !smsSettings?.otpEnabled) {
      toast.error('OTP service is not configured. Contact the store admin.');
      return;
    }
    setOtpSending(true);
    try {
      const res = await sendSmsOtp(phone, email);
      if (res.success) {
        setOtpSent(true);
        setOtpVerified(false);
        setOtpVerifyingPhone(phone);
        toast.success(`Code sent via ${otpChannelLabel} to ${phone}.`);
      } else {
        toast.error(res.message);
      }
    } catch {
      toast.error('Could not send OTP. Please try again.');
    } finally {
      setOtpSending(false);
    }
  };

  const handleVerifyOtp = () => {
    if (!otpCode.trim()) {
      toast.error('Enter the code you received.');
      return;
    }
    const res = verifySmsOtp(phone, otpCode.trim());
    if (res.success) {
      setOtpVerified(true);
      toast.success('Phone number verified!');
    } else {
      toast.error(res.message);
    }
  };

  const handleCheckoutSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateCheckoutForm()) return;

    try {
      const itemsToSubmit = cart.map(item => ({
        productId: item.id,
        name: item.product.name,
        quantity: item.quantity,
        price: item.product.salePrice || item.product.price,
      }));

      const orderData = {
        customerName,
        email,
        phone,
        address,
        city,
        postalCode,
        deliveryNote,
        items: itemsToSubmit,
        subtotal,
        deliveryFee,
        couponApplied: appliedCoupon?.code || null,
        discount: discountAmount,
        total: grandTotal,
        paymentMethod,
      };

      if (['bKashAuto', 'NagadAuto', 'PayPal', 'Stripe', 'SSLCommerz', 'Razorpay'].includes(paymentMethod)) {
        // Try real bKash API if credentials are configured
        if (paymentMethod === 'bKashAuto' && paymentSettings.bKashAppKey && paymentSettings.bKashAppSecret) {
          try {
            const res = await fetch('/api/bkash/create-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: grandTotal.toFixed(2),
                orderId: `QF-${Date.now()}`,
                appKey: paymentSettings.bKashAppKey,
                appSecret: paymentSettings.bKashAppSecret,
                username: paymentSettings.bKashUsername,
                password: paymentSettings.bKashPassword,
                sandboxMode: paymentSettings.bKashSandboxMode ?? true,
              }),
            });
            const data = await res.json() as any;
            if (data.bkashURL) {
              // Save order data to localStorage so callback can complete it
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'bKash (Auto)', paymentStatus: 'Paid' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              window.location.href = data.bkashURL;
              return;
            }
          } catch {
            // fall through to simulation
          }
        }

        if (paymentMethod === 'NagadAuto' && paymentSettings.nagadMerchantId) {
          try {
            const res = await fetch('/api/nagad/create-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: grandTotal.toFixed(2),
                orderId: `QF-${Date.now()}`,
                merchantId: paymentSettings.nagadMerchantId,
                sandboxMode: paymentSettings.nagadSandboxMode ?? true,
              }),
            });
            const data = await res.json() as any;
            if (data.nagadURL) {
              localStorage.setItem('qf_pending_order', JSON.stringify({ ...orderData, paymentMethod: 'Nagad (Auto)', paymentStatus: 'Paid' }));
              localStorage.setItem('qf_pending_email', email.trim().toLowerCase());
              window.location.href = data.nagadURL;
              return;
            }
          } catch {
            // fall through to simulation
          }
        }

        // Intercept order and open interactive gateway simulation overlay (fallback when API credentials not set)
        setStoredOrderData(orderData);
        setIsAutoPortalOpen(true);
        setAutoStep(0);
        setAutoPhoneInput(phone || '');
        setAutoOtpInput('');
        setAutoPinInput('');
        setAutoPaypalEmailInput(email || '');
        setAutoPaypalPasswordInput('');
        setAutoCardNumberInput('');
        setAutoCardExpiryInput('');
        setAutoCardCvcInput('');
        setAutoCardHolderInput(customerName || '');
        setAutoPortalError('');
        return;
      }

      const placedOrder = await placeOrder(orderData);
      
      // ✅ Save email so review button shows for this user's ordered products
      setCurrentUserEmail(email.trim().toLowerCase());

      toast.success(`🎉 SUCCESS! Order placed successfully. Order Number: ${placedOrder.orderNumber}`);
      setPlacedInvoiceOrder(placedOrder);

      // ✅ Clear cart after successful order
      clearCart();

      // Reset form states
      setCustomerName('');
      setEmail('');
      setPhoneLocal('');
      setOtpSent(false); setOtpVerified(false); setOtpCode(''); setOtpVerifyingPhone('');
      setAddress('');
      setCity('');
      setPostalCode('');
      setDeliveryNote('');
      setCardNumber('');
      setCardExpiry('');
      setCardCVC('');
      setManualTxId('');
      
    } catch (err) {
      toast.error('Could not submit your checkout request. Try submitting again.');
    }
  };

  // ── Finalise order after confirmed payment ────────────────────────────────
  const _finaliseOrder = async (orderInfo: any, methodLabel: string, txnRef: string) => {
    const updatedOrder = {
      ...orderInfo,
      paymentStatus: 'Paid' as const,
      paymentMethod: methodLabel,
      transactionId: txnRef,
    };
    const placedOrder = await placeOrder(updatedOrder);
    if (orderInfo.email) setCurrentUserEmail(orderInfo.email.trim().toLowerCase());
    toast.success(`🎉 Payment confirmed! Order: ${placedOrder.orderNumber}`);
    setPlacedInvoiceOrder(placedOrder);
    clearCart();
    setCustomerName(''); setEmail(''); setPhoneLocal(''); setAddress('');
    setOtpSent(false); setOtpVerified(false); setOtpCode(''); setOtpVerifyingPhone('');
    setCity(''); setPostalCode(''); setDeliveryNote('');
    setManualTxId(''); setCardNumber(''); setCardExpiry(''); setCardCVC('');
    setAutoStep(4);
  };

  const runFinalTriggerAPI = async (orderInfo: any, methodLabel: string, txnRef?: string) => {
    try {
      setAutoPortalError('');

      // ── STRIPE ───────────────────────────────────────────────────────────
      if (methodLabel.startsWith('Stripe') && paymentSettings.stripeSecretKey) {
        setAutoStep(3);
        // Step 1: create PaymentIntent
        const piRes = await fetch('/api/stripe/create-payment-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            currency: (siteSettings?.currency || 'USD').toLowerCase(),
            stripeSecretKey: paymentSettings.stripeSecretKey,
            sandboxMode: paymentSettings.stripeSandboxMode ?? true,
          }),
        });
        const piData = await piRes.json() as any;
        if (!piData.clientSecret) throw new Error(piData.error || 'Stripe PaymentIntent failed.');

        // Step 2: create PaymentMethod from card details via Stripe API
        const pmRes = await fetch('https://api.stripe.com/v1/payment_methods', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${paymentSettings.stripePublicKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            type: 'card',
            'card[number]': autoCardNumberInput.replace(/\s/g, ''),
            'card[exp_month]': autoCardExpiryInput.split('/')[0]?.trim() || '',
            'card[exp_year]': autoCardExpiryInput.split('/')[1]?.trim() || '',
            'card[cvc]': autoCardCvcInput,
            'billing_details[name]': autoCardHolderInput || orderInfo.customerName,
          }).toString(),
        });
        const pmData = await pmRes.json() as any;
        if (!pmData.id) throw new Error(pmData.error?.message || 'Card tokenisation failed. Check your card details.');

        // Step 3: confirm PaymentIntent server-side
        const confRes = await fetch('/api/stripe/confirm-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentIntentId: piData.paymentIntentId,
            paymentMethodId: pmData.id,
            stripeSecretKey: paymentSettings.stripeSecretKey,
          }),
        });
        const confData = await confRes.json() as any;
        if (!confData.success) throw new Error(confData.error || 'Stripe charge failed.');
        await _finaliseOrder(orderInfo, methodLabel, confData.transactionId);
        return;
      }

      // ── PAYPAL ───────────────────────────────────────────────────────────
      if (methodLabel.startsWith('PayPal') && paymentSettings.paypalClientId) {
        setAutoStep(3);
        const orderRes = await fetch('/api/paypal/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            currency: (siteSettings?.currency || 'USD').toUpperCase(),
            clientId: paymentSettings.paypalClientId,
            clientSecret: paymentSettings.paypalClientSecret || '',
            sandboxMode: paymentSettings.paypalSandboxMode ?? true,
          }),
        });
        const orderData = await orderRes.json() as any;
        if (!orderData.orderId) throw new Error(orderData.error || 'PayPal order creation failed.');

        // Store pending order + PayPal orderId so callback page can capture it
        localStorage.setItem('qf_pending_order', JSON.stringify({
          ...orderInfo,
          paymentMethod: 'PayPal',
          paymentStatus: 'Paid',
        }));
        localStorage.setItem('qf_pending_email', (orderInfo.email || '').trim().toLowerCase());
        localStorage.setItem('qf_paypal_order_id', orderData.orderId);
        localStorage.setItem('qf_paypal_client_id', paymentSettings.paypalClientId);
        localStorage.setItem('qf_paypal_client_secret', paymentSettings.paypalClientSecret || '');
        localStorage.setItem('qf_paypal_sandbox', String(paymentSettings.paypalSandboxMode ?? true));

        // Redirect buyer to PayPal approval page
        window.location.href = orderData.approvalUrl;
        return;
      }

      // ── SSLCommerz ───────────────────────────────────────────────────────
      if (methodLabel.startsWith('SSLCommerz') && paymentSettings.sslCommerzStoreId) {
        setAutoStep(3);
        const sslRes = await fetch('/api/sslcommerz/create-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            currency: siteSettings?.currency || 'BDT',
            orderId: `QF-${Date.now()}`,
            customerName: orderInfo.customerName,
            customerEmail: orderInfo.email,
            customerPhone: orderInfo.phone,
            customerAddress: orderInfo.address,
            storeId: paymentSettings.sslCommerzStoreId,
            storePassword: paymentSettings.sslCommerzStorePassword,
            sandboxMode: paymentSettings.sslCommerzSandboxMode ?? true,
          }),
        });
        const sslData = await sslRes.json() as any;
        if (!sslData.gatewayUrl) throw new Error(sslData.error || 'SSLCommerz session failed.');

        localStorage.setItem('qf_pending_order', JSON.stringify({
          ...orderInfo,
          paymentMethod: 'SSLCommerz',
          paymentStatus: 'Paid',
        }));
        localStorage.setItem('qf_pending_email', (orderInfo.email || '').trim().toLowerCase());
        window.location.href = sslData.gatewayUrl;
        return;
      }

      // ── Razorpay ─────────────────────────────────────────────────────────
      if (methodLabel.startsWith('Razorpay') && paymentSettings.razorpayKeyId) {
        setAutoStep(3);
        const rzpRes = await fetch('/api/razorpay/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: orderInfo.total,
            currency: siteSettings?.currency || 'INR',
            keyId: paymentSettings.razorpayKeyId,
            keySecret: paymentSettings.razorpayKeySecret,
            orderId: `QF-${Date.now()}`,
            sandboxMode: paymentSettings.razorpaySandboxMode ?? false,
          }),
        });
        const rzpData = await rzpRes.json() as any;
        if (!rzpData.rzpOrderId) throw new Error(rzpData.error || 'Razorpay order creation failed.');

        // Dynamically load Razorpay checkout.js if not already loaded
        await new Promise<void>((resolve, reject) => {
          if ((window as any).Razorpay) { resolve(); return; }
          const script = document.createElement('script');
          script.src = 'https://checkout.razorpay.com/v1/checkout.js';
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Failed to load Razorpay SDK'));
          document.head.appendChild(script);
        });

        await new Promise<void>((resolve, reject) => {
          const options = {
            key: rzpData.keyId,
            amount: rzpData.amount,
            currency: rzpData.currency,
            order_id: rzpData.rzpOrderId,
            name: siteSettings?.websiteName || 'Store',
            description: 'Order Payment',
            prefill: {
              name: orderInfo.customerName,
              email: orderInfo.email,
              contact: orderInfo.phone,
            },
            handler: async (response: any) => {
              try {
                // Verify signature server-side
                const verifyRes = await fetch('/api/razorpay/verify-payment', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    razorpay_order_id: response.razorpay_order_id,
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_signature: response.razorpay_signature,
                    keySecret: paymentSettings.razorpayKeySecret,
                  }),
                });
                const verifyData = await verifyRes.json() as any;
                if (!verifyData.verified) throw new Error('Razorpay signature verification failed.');
                await _finaliseOrder(orderInfo, 'Razorpay', response.razorpay_payment_id);
                resolve();
              } catch (err: any) {
                reject(err);
              }
            },
            modal: {
              ondismiss: () => reject(new Error('Payment cancelled by user.')),
            },
          };
          const rzp = new (window as any).Razorpay(options);
          rzp.open();
        });
        return;
      }

      // ── Fallback: bKash/Nagad simulation (credentials missing) or unknown method
      await new Promise(resolve => setTimeout(resolve, 1800));
      const fallbackTxn = txnRef || `AUTO_${methodLabel.replace(/\s+/g, '_').toUpperCase()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      await _finaliseOrder(orderInfo, methodLabel, fallbackTxn);

    } catch (err: any) {
      setAutoPortalError(err?.message || 'Payment processing error. Please retry.');
      setAutoStep(0);
    }
  };

  const handlePrintInvoice = () => {
    if (!placedInvoiceOrder) return;
    const order = placedInvoiceOrder;
    const storeName = siteSettings.websiteName || 'Store';
    const sym = siteSettings.currencySymbol || '$';
    const pos = (siteSettings.currencyPosition || 'before') as 'before' | 'after';
    const fmt = (n: number) => pos === 'after' ? `${n.toFixed(2)}${sym}` : `${sym}${n.toFixed(2)}`;

    const orderUrl = `${window.location.origin}/tracker?order=${order.orderNumber}`;
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(orderUrl)}&margin=4&color=1e293b&bgcolor=ffffff`;

    const itemRows = order.items.map((item: any) => `
      <tr>
        <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#1e293b;">${item.name}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b;text-align:center;">x${item.quantity}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:600;color:#1e293b;text-align:right;">${fmt(item.price * item.quantity)}</td>
      </tr>`).join('');

    const discountRow = order.discount > 0
      ? `<tr><td style="color:#dc2626;padding:4px 10px;font-size:11px;">Discount${order.couponApplied ? ' (' + order.couponApplied + ')' : ''}</td><td style="color:#dc2626;text-align:right;padding:4px 10px;font-size:11px;font-weight:600;">-${fmt(order.discount)}</td></tr>`
      : '';

    const orderDate = new Date(order.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Invoice #${order.orderNumber}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:Arial,sans-serif;background:#fff;color:#1e293b;}
    .wrap{max-width:480px;margin:16px auto;padding:0 14px;}
    .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:10px;border-bottom:2px solid #10b981;margin-bottom:12px;}
    .sname{font-size:17px;font-weight:800;color:#10b981;}
    .ssub{font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-top:2px;}
    .ino{font-size:10px;color:#64748b;text-align:right;}
    .ino strong{display:block;font-size:13px;color:#1e293b;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;}
    .mb{background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:7px 9px;}
    .ml{font-size:9px;font-weight:700;text-transform:uppercase;color:#94a3b8;margin-bottom:2px;}
    .mv{color:#1e293b;font-weight:600;font-size:11px;line-height:1.5;}
    table{width:100%;border-collapse:collapse;}
    thead tr{background:#10b981;}
    thead th{padding:7px 10px;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;text-align:left;}
    thead th.r{text-align:right;}
    thead th.c{text-align:center;}
    .tot{margin-top:4px;}
    .tot td{padding:4px 10px;font-size:11px;}
    .tot td.r{text-align:right;font-weight:600;}
    .grand td{border-top:2px solid #10b981;padding-top:7px;font-size:13px;font-weight:800;color:#10b981;}
    .qr-wrap{text-align:center;margin-top:12px;padding-top:10px;border-top:1px dashed #e2e8f0;}
    .qr-img{display:inline-block;border:1px solid #e2e8f0;padding:6px;background:#fff;border-radius:6px;}
    .qr-url{font-size:8px;color:#94a3b8;margin-top:4px;word-break:break-all;}
    .foot{margin-top:8px;text-align:center;font-size:10px;color:#94a3b8;}
  </style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div><div class="sname">${storeName}</div><div class="ssub">Sales Receipt</div></div>
    <div class="ino"><span>Invoice</span><strong>#${order.orderNumber}</strong></div>
  </div>
  <div class="meta">
    <div class="mb"><div class="ml">Customer</div><div class="mv">${order.customerName}</div><div class="mv" style="font-weight:400;color:#64748b;">${order.phone}</div></div>
    <div class="mb"><div class="ml">Address</div><div class="mv">${order.address}</div><div class="mv" style="font-weight:400;color:#64748b;">${order.city}</div></div>
    <div class="mb"><div class="ml">Date</div><div class="mv">${orderDate}</div></div>
    <div class="mb"><div class="ml">Payment</div><div class="mv">${order.paymentMethod}</div></div>
  </div>
  <table>
    <thead><tr><th>Item</th><th class="c">Qty</th><th class="r">Amount</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  <table class="tot">
    <tr><td style="color:#64748b;">Subtotal</td><td class="r">${fmt(order.subtotal)}</td></tr>
    ${discountRow}
    <tr><td style="color:#64748b;">Delivery</td><td class="r">${fmt(order.deliveryFee)}</td></tr>
    <tr class="grand"><td>Grand Total</td><td class="r">${fmt(order.total)}</td></tr>
  </table>

  <div class="qr-wrap">
    <div class="qr-img"><img src="${qrApiUrl}" width="120" height="120" alt="Order QR Code" /></div>
    <div class="qr-url">${orderUrl}</div>
    <div style="font-size:9px;color:#64748b;margin-top:2px;">Scan QR code to view your order status</div>
  </div>

  <div class="foot">
    <p>Thank you for your order! &nbsp;·&nbsp; ${siteSettings.trademarkText || '&copy; ' + new Date().getFullYear() + ' ' + storeName}</p>
  </div>
</div>
<script>window.onload=function(){window.print();window.onafterprint=function(){window.close();};};</script>
</body></html>`;

    const popup = window.open('', '_blank', 'width=560,height=720,scrollbars=yes');
    if (popup) { popup.document.write(html); popup.document.close(); }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden flex font-sans" role="dialog" aria-modal="true">
      
      {/* Dark background overlay */}
      <div onClick={onClose} className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity cursor-pointer"></div>

      {/* Slide-over Content Drawer */}
      <div className="relative ml-auto max-w-2xl w-full h-full bg-white border-l border-slate-200 shadow-2xl flex flex-col justify-between overflow-y-auto p-6 scrollbar-thin">
        
        {/* Header Block */}
        <div className="flex items-center justify-between border-b border-slate-200 pb-4 mb-4 select-none">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg overflow-hidden flex items-center justify-center bg-emerald-50 border border-emerald-100 flex-shrink-0">
              {siteSettings.logoUrl && siteSettings.logoUrl.trim() !== '' ? (
                <img
                  src={siteSettings.logoUrl}
                  alt={siteSettings.websiteName || 'Logo'}
                  className="w-full h-full object-contain"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <QuirkyFruityLogo className="w-full h-full" />
              )}
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-slate-800 uppercase tracking-tight">
              Secure Checkout
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 bg-slate-50 border border-slate-200 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-100 rounded-full cursor-pointer text-slate-400 transition-colors"
            id="close-cart-btn"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* IF SUCCESS INVOICE PREVIEW VIEW */}
        {placedInvoiceOrder ? (
          <div className="flex-1 py-4 flex flex-col justify-between" id="printable-sales-invoice-modal">
            
            {/* Sales Invoice Copy */}
            <div className="bg-slate-50 border border-dashed border-emerald-300 rounded-2xl p-5 relative select-none">
              
              <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
                <div>
                  <h3 className="text-xl font-bold text-emerald-600 uppercase tracking-tight">
                    {siteSettings.websiteName || 'QUIRKY-FRUITY'}
                  </h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">SALES RECEIPT</p>
                </div>
                <div className="text-right">
                  <div className="bg-emerald-100 text-emerald-800 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 border border-emerald-300 rounded-full">
                    COD PLACED
                  </div>
                  <div className="text-xs font-bold text-slate-700 mt-1">NO: {placedInvoiceOrder.orderNumber}</div>
                </div>
              </div>

              {/* QR Code — links directly to order tracking page */}
              <div className="flex flex-col items-center justify-center py-3 mb-4">
                <div className="p-2 bg-white border border-slate-200 rounded-xl shadow-sm">
                  <QRCodeImg value={`${window.location.origin}/tracker?order=${placedInvoiceOrder.orderNumber}`} size={88} />
                </div>
                <span className="text-[10px] font-mono mt-1.5 text-slate-400">{placedInvoiceOrder.id.toUpperCase()}</span>
                <span className="text-[9px] text-slate-400 mt-0.5">Scan to view order status</span>
              </div>

              {/* Invoice Table list */}
              <div className="space-y-2 text-sm">
                <div className="grid grid-cols-12 border-b border-slate-200 pb-1.5 font-bold text-emerald-600 uppercase text-[10px]">
                  <span className="col-span-8">Product Item description</span>
                  <span className="col-span-2 text-center">Qty</span>
                  <span className="col-span-2 text-right">Sum</span>
                </div>
                {placedInvoiceOrder.items.map((item, idx) => (
                  <div key={idx} className="grid grid-cols-12 text-xs font-medium py-1.5 border-b border-slate-100 text-slate-600">
                    <span className="col-span-8 truncate">{item.name}</span>
                    <span className="col-span-2 text-center">{item.quantity}</span>
                    <span className="col-span-2 text-right">{formatPrice(item.price * item.quantity)}</span>
                  </div>
                ))}
              </div>

              {/* Pricing Math breakdowns */}
              <div className="border-t border-dashed border-slate-200 pt-3 mt-4 space-y-1 text-xs">
                <div className="flex justify-between text-slate-500">
                  <span className="font-semibold uppercase">Subtotal</span>
                  <span className="font-bold text-slate-800">{formatPrice(placedInvoiceOrder.subtotal)}</span>
                </div>
                {placedInvoiceOrder.discount > 0 && (
                  <div className="flex justify-between text-rose-600">
                    <span className="font-semibold uppercase">Discount</span>
                    <span className="font-bold">-{formatPrice(placedInvoiceOrder.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-500">
                  <span className="font-semibold uppercase">Delivery & Handling</span>
                  <span className="font-bold text-slate-800">{formatPrice(placedInvoiceOrder.deliveryFee)}</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-2 font-bold text-emerald-600 text-sm">
                  <span className="uppercase">GRAND TOTAL</span>
                  <span>{formatPrice(placedInvoiceOrder.total)}</span>
                </div>
              </div>

              <div className="text-center text-xs text-slate-400 mt-6 border-t border-dashed border-slate-200 pt-3">
                <p className="font-semibold text-xs text-emerald-600">Thank you for your order!</p>
                <p className="mt-1 text-[10px] leading-relaxed">Your confirmation receipt invoice email has been compiled and forwarded to <strong>{placedInvoiceOrder.email}</strong>.</p>
                <p className="mt-3 text-[9px] text-slate-400 capitalize">{siteSettings.trademarkText}</p>
              </div>

            </div>

            <div className="flex flex-col gap-2 mt-6">
              <button
                onClick={handlePrintInvoice}
                className="w-full cursor-pointer py-3 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 font-bold rounded-xl uppercase transition-all flex items-center justify-center gap-2 shadow-xs"
              >
                <Printer className="w-4 h-4" />
                <span>PRINT INVOICE</span>
              </button>

              <button
                onClick={() => {
                  setPlacedInvoiceOrder(null);
                  onClose();
                }}
                className="w-full cursor-pointer py-3 bg-emerald-500 text-white hover:bg-emerald-600 font-bold rounded-xl uppercase transition-all flex items-center justify-center gap-2 shadow-sm"
              >
                <span>CONTINUE SHOPPING</span>
              </button>
            </div>

          </div>
        ) : cart.length === 0 ? (
          
          /* EMPTY CART STATE */
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 select-none">
            <div className="text-5xl mb-4 bg-slate-50 p-4 rounded-full text-slate-500 border border-slate-100">🛒</div>
            <h3 className="text-md font-bold text-slate-800 uppercase">Your Checkout Cart is Empty</h3>
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mt-1.5">
              Add products from the menu to proceed
            </p>
            <button
              onClick={onClose}
              className="mt-6 cursor-pointer px-6 py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold text-xs uppercase shadow-sm rounded-full transition-all"
            >
              Start Shopping
            </button>
          </div>
        ) : (
          /* ACTIVE SHOPPING ITEMS AND CHECKOUT FORM FRAME */
          <div className="flex-1 flex flex-col justify-between">
            {/* Scrollable list items */}
            <div className="space-y-3 max-h-[220px] overflow-y-auto mb-4 border-b pb-4 border-dashed border-slate-100 scrollbar-thin">
              {cart.map((item) => (
                <div key={item.id} className="bg-white border border-slate-100 p-3 rounded-xl flex items-center justify-between gap-3 shadow-sm">
                  <div className="text-xl h-9 w-9 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-center select-none overflow-hidden">
                    {item.product.image && (item.product.image.startsWith('http') || item.product.image.startsWith('data:') || item.product.image.startsWith('/')) ? (
                      <img src={item.product.image} alt={item.product.name} className="w-full h-full object-cover rounded-lg" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; (e.currentTarget.parentElement as HTMLElement).innerText = '🥤'; }} />
                    ) : (
                      <span>{item.product.image || '🥤'}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-xs font-bold text-slate-900 truncate uppercase">{item.product.name}</h4>
                    <p className="text-[10px] text-slate-400 font-semibold uppercase mt-0.5">{formatPrice(item.product.salePrice || item.product.price)} each</p>
                  </div>
                  <div className="flex items-center gap-1.5 border border-slate-200 p-0.5 rounded-lg bg-slate-50 scale-90">
                    <button type="button" onClick={() => updateCartQuantity(item.id, item.quantity - 1)} className="p-1 hover:bg-slate-200 text-slate-600 rounded cursor-pointer"><Minus className="w-3 h-3" /></button>
                    <span className="text-xs font-bold px-1.5 text-slate-800">{item.quantity}</span>
                    <button type="button" onClick={() => updateCartQuantity(item.id, item.quantity + 1)} className="p-1 hover:bg-slate-200 text-slate-600 rounded cursor-pointer"><Plus className="w-3 h-3" /></button>
                  </div>
                  <button onClick={() => removeFromCart(item.id)} className="p-1 text-slate-400 hover:text-rose-600 rounded cursor-pointer"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>

            {/* ─── Coupon ─── */}
            <form onSubmit={handleApplyCoupon} className="flex gap-2 mb-4">
              <div className="relative flex-1">
                <Ticket className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={couponCode}
                  onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                  placeholder="Coupon code"
                  className="w-full pl-9 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm uppercase outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white transition-all"
                />
              </div>
              <button type="submit" className="px-4 py-2.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold uppercase rounded-xl cursor-pointer">
                Apply
              </button>
              {appliedCoupon && (
                <button type="button" onClick={removeCoupon} className="px-3 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-600 text-xs font-bold uppercase rounded-xl cursor-pointer">
                  Remove
                </button>
              )}
            </form>

            {/* ─── Pricing breakdown ─── */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4 space-y-1.5 text-sm">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span><span className="font-semibold text-slate-800">{formatPrice(subtotal)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between text-rose-600">
                  <span>Discount{appliedCoupon ? ` (${appliedCoupon.code})` : ''}</span>
                  <span className="font-semibold">-{formatPrice(discountAmount)}</span>
                </div>
              )}
              <div className="flex justify-between text-slate-600">
                <span>Delivery {matchedZone?.isEnabled ? `(${matchedZone.name})` : ''}</span>
                <span className="font-semibold text-slate-800">{formatPrice(deliveryFee)}</span>
              </div>
              {taxAmount > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>Tax</span><span className="font-semibold text-slate-800">{formatPrice(taxAmount)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-dashed border-slate-300 pt-2 mt-1 text-emerald-600 font-bold text-base">
                <span>Grand Total</span><span>{formatPrice(grandTotal)}</span>
              </div>
            </div>

            {/* ─── Shipping & payment form ─── */}
            <form onSubmit={handleCheckoutSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Full Name *</label>
                  <input required value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Email *</label>
                  <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>

                {/* Country code + phone number */}
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">
                    Mobile Number * <span className="text-slate-400 normal-case font-medium">(used for order updates{otpRequired ? ` & ${otpChannelLabel} OTP` : ''})</span>
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={dialCode}
                      onChange={(e) => setDialCode(e.target.value)}
                      className="px-2 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white cursor-pointer max-w-[140px]"
                    >
                      {COUNTRY_PHONE_RULES.map(c => (
                        <option key={c.dial} value={c.dial}>{c.dial} {c.name}</option>
                      ))}
                    </select>
                    <input
                      required
                      inputMode="tel"
                      value={phoneLocal}
                      onChange={(e) => setPhoneLocal(e.target.value.replace(/[^\d\s-]/g, ''))}
                      placeholder={phoneRule.lengths[0] ? `e.g. ${'X'.repeat(phoneRule.lengths[0])}` : 'Phone number'}
                      className={`flex-1 px-3 py-2.5 bg-slate-50 border rounded-xl text-sm outline-none focus:ring-2 focus:bg-white ${
                        phoneLocal && !phoneValidation.ok
                          ? 'border-rose-300 focus:ring-rose-400'
                          : 'border-slate-200 focus:ring-emerald-400'
                      }`}
                    />
                  </div>
                  {phoneLocal && !phoneValidation.ok && (
                    <p className="text-[11px] text-rose-600 mt-1 font-semibold">{phoneValidation.error}</p>
                  )}
                  {phoneLocal && phoneValidation.ok && (
                    <p className="text-[11px] text-emerald-600 mt-1 font-semibold flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> {phoneValidation.e164}
                    </p>
                  )}
                </div>

                {/* OTP verification block — only if admin requires it */}
                {otpRequired && (
                  <div className="col-span-2 bg-amber-50 border border-amber-200 rounded-xl p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[11px] font-bold uppercase text-amber-800 flex items-center gap-1">
                        <Shield className="w-3.5 h-3.5" />
                        {otpChannelLabel} OTP Verification
                      </span>
                      {otpVerified && otpVerifyingPhone === phone ? (
                        <span className="text-[10px] font-bold uppercase text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Verified
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!phoneValidation.ok || otpSending}
                          onClick={handleSendOtp}
                          className="text-[10px] font-bold uppercase bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-2.5 py-1 rounded-full cursor-pointer"
                        >
                          {otpSending ? 'Sending…' : otpSent ? 'Resend code' : `Send ${otpChannelLabel} code`}
                        </button>
                      )}
                    </div>
                    {otpSent && !(otpVerified && otpVerifyingPhone === phone) && (
                      <div className="flex gap-2">
                        <input
                          inputMode="numeric"
                          maxLength={8}
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value.replace(/[^\d]/g, ''))}
                          placeholder="6-digit code"
                          className="flex-1 px-3 py-2 bg-white border border-amber-300 rounded-lg text-sm font-mono tracking-widest text-center outline-none focus:ring-2 focus:ring-amber-400"
                        />
                        <button type="button" onClick={handleVerifyOtp}
                          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase rounded-lg cursor-pointer">
                          Verify
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Address *</label>
                  <input required value={address} onChange={(e) => setAddress(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">City *</label>
                  <input required value={city} onChange={(e) => setCity(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Postal Code</label>
                  <input value={postalCode} onChange={(e) => setPostalCode(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Delivery Note</label>
                  <textarea rows={2} value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)}
                    placeholder="Landmarks, gate code, preferred time…"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
              </div>

              {/* ─── Payment method ─── */}
              <div>
                <label className="block text-[10px] font-bold uppercase text-slate-500 mb-2">Payment Method *</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'COD',         label: 'Cash on Delivery', icon: <ShoppingBag className="w-4 h-4" />, enabled: paymentSettings.codEnabled !== false },
                    { id: 'bKash',       label: 'bKash (Manual)',   icon: <BkashLogo className="w-5 h-5" />,   enabled: paymentSettings.bKashEnabled },
                    { id: 'Nagad',       label: 'Nagad (Manual)',   icon: <NagadLogo className="w-5 h-5" />,   enabled: paymentSettings.nagadEnabled },
                    { id: 'Rocket',      label: 'Rocket (Manual)',  icon: <RocketLogo className="w-5 h-5" />,  enabled: paymentSettings.rocketEnabled },
                    { id: 'Bank',        label: 'Bank Transfer',    icon: <Landmark className="w-4 h-4" />,    enabled: paymentSettings.bankEnabled },
                    { id: 'Stripe',      label: 'Card (Stripe)',    icon: <StripeLogo className="w-5 h-5" />,  enabled: !!paymentSettings.stripePublicKey },
                    { id: 'PayPal',      label: 'PayPal',           icon: <PaypalLogo className="w-5 h-5" />,  enabled: !!paymentSettings.paypalClientId },
                    { id: 'bKashAuto',   label: 'bKash (Auto)',     icon: <BkashLogo className="w-5 h-5" />,   enabled: !!paymentSettings.bKashAppKey },
                    { id: 'NagadAuto',   label: 'Nagad (Auto)',     icon: <NagadLogo className="w-5 h-5" />,   enabled: !!paymentSettings.nagadMerchantId },
                    { id: 'SSLCommerz',  label: 'SSLCommerz',       icon: <CreditCard className="w-4 h-4" />,  enabled: !!paymentSettings.sslCommerzStoreId },
                    { id: 'Razorpay',    label: 'Razorpay',         icon: <CreditCard className="w-4 h-4" />,  enabled: !!paymentSettings.razorpayKeyId },
                  ].filter(opt => opt.enabled).map(opt => (
                    <label key={opt.id}
                      className={`flex items-center gap-2 p-2.5 border rounded-xl cursor-pointer transition-all text-xs font-bold uppercase ${
                        paymentMethod === opt.id
                          ? 'bg-emerald-50 border-emerald-400 text-emerald-700 ring-2 ring-emerald-200'
                          : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                      }`}>
                      <input type="radio" name="pm" value={opt.id} checked={paymentMethod === opt.id}
                        onChange={() => setPaymentMethod(opt.id)} className="sr-only" />
                      <span className="flex-shrink-0">{opt.icon}</span>
                      <span className="truncate">{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Manual payment txn id */}
              {['bKash', 'Nagad', 'Rocket', 'Bank', 'CreditManual'].includes(paymentMethod) && (
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Transaction / Reference ID *</label>
                  <input value={manualTxId} onChange={(e) => setManualTxId(e.target.value)}
                    placeholder="e.g. TXN1234567890"
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:bg-white" />
                </div>
              )}

              <button
                type="submit"
                className="w-full mt-2 py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-black uppercase rounded-xl shadow-lg flex items-center justify-center gap-2 cursor-pointer transition-all"
              >
                <Sparkles className="w-4 h-4" />
                Place Order · {formatPrice(grandTotal)}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};

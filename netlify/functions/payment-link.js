// ================================================
// Payment Link API  (PayU + UPI)
//
// POST /api/payment-link          → create & send payment link
// GET  /api/payment-link?businessId=X → list payment links
// POST /api/payment-link/webhook  → PayU payment success callback
//
// PayU docs: https://devguide.payu.in/payment-links/create-payment-link/
// ================================================

const { createClient } = require('@supabase/supabase-js');
const crypto            = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helpers ───────────────────────────────────────────────────────────────

/** Generate a unique transaction ID */
function makeTxnId() {
  return 'WA' + Date.now() + Math.random().toString(36).slice(2, 7).toUpperCase();
}

/** PayU standard SHA512 hash
 *  sha512(key|txnid|amount|productinfo|firstname|email|udf1|...|udf5||||||salt)
 */
function payuHash(key, txnid, amount, productinfo, firstname, email, salt) {
  const hashStr = [
    key, txnid, amount, productinfo, firstname, email,
    '', '', '', '', '',   // udf1–udf5
    '', '', '', '', '',   // empty fields per PayU spec
    salt,
  ].join('|');
  return crypto.createHash('sha512').update(hashStr).digest('hex');
}

/** Create a PayU Payment Link via API */
async function createPayuPaymentLink(business, { amount, productinfo, firstname, phone, txnid }) {
  const key   = business.payu_merchant_key;
  const salt  = business.payu_merchant_salt;
  const isTest = business.payu_is_test;

  // PayU Payment Links API endpoint
  const baseUrl = isTest
    ? 'https://test.payu.in'
    : 'https://api.payu.in';

  const amountStr = Number(amount).toFixed(2);
  const hash      = payuHash(key, txnid, amountStr, productinfo, firstname || 'Customer', '', salt);

  const body = {
    key,
    txnid,
    amount:       amountStr,
    productinfo,
    firstname:    firstname || 'Customer',
    email:        '',
    phone:        (phone || '').replace(/^\+91/, '').replace(/\D/g, ''),
    currency:     'INR',
    hash,
    send_sms_now: phone ? '1' : '0',
    send_email_now: '0',
  };

  const res = await fetch(`${baseUrl}/v1/payment-links/`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  const data = await res.json();
  return data; // { status: 1, paymentLink: 'https://payu.in/pay/xxx', linkId: 'xxx' }
}

/** Generate UPI deep link string */
function generateUpiLink(upiId, businessName, amount, description) {
  const params = new URLSearchParams({
    pa: upiId,
    pn: businessName,
    am: Number(amount).toFixed(2),
    cu: 'INR',
    tn: (description || 'Payment').slice(0, 50),
  });
  return `upi://pay?${params.toString()}`;
}

/** Format the WhatsApp payment message */
function formatPaymentMessage({ amount, description, payuUrl, upiId, businessName, txnid }) {
  const amtFormatted = `₹${Number(amount).toLocaleString('en-IN')}`;
  let msg = `💳 *Payment Request*\n\n`;
  msg += `🛍 ${description || 'Your Order'}\n`;
  msg += `💰 Amount: *${amtFormatted}*\n`;
  msg += `🔖 Ref: ${txnid}\n\n`;

  if (payuUrl) {
    msg += `👇 *Pay securely via PayU (UPI, Card, Net Banking, Wallets):*\n`;
    msg += `${payuUrl}\n\n`;
  }

  if (upiId) {
    msg += `📱 *Or pay directly via UPI:*\n`;
    msg += `UPI ID: *${upiId}*\n`;
    msg += `Amount: *${amtFormatted}*\n`;
    msg += `_Open Google Pay / PhonePe / Paytm → 'Pay contact or number' → enter UPI ID above_\n\n`;
  }

  msg += `✅ Once paid, please share the payment screenshot here to confirm your order. Thank you! 🙏`;
  return msg;
}

/** Send a WhatsApp text message */
async function sendWhatsAppMessage(accessToken, phoneNumberId, toPhone, text) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                toPhone,
        type:              'text',
        text:              { preview_url: false, body: text },
      }),
    }
  );
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  // ── GET: list payment links ────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };

    const { data } = await supabase
      .from('payment_links')
      .select('*, contacts(name, phone), products(name)')
      .eq('business_id', q.businessId)
      .order('created_at', { ascending: false })
      .limit(100);

    return { statusCode: 200, headers, body: JSON.stringify({ paymentLinks: data || [] }) };
  }

  // ── POST: create & send payment link ──────────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const {
        businessId,
        conversationId,
        contactId,
        productId,
        amount,
        description,
        method = 'both',   // 'upi' | 'payu' | 'both'
        customerName,
        customerPhone,
        sendToWhatsApp = true,
      } = body;

      if (!businessId || !amount) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId and amount required' }) };
      }

      // Fetch business credentials
      const { data: biz } = await supabase
        .from('businesses')
        .select('*')
        .eq('id', businessId)
        .single();

      if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };

      const txnid = makeTxnId();
      let payuUrl  = null;
      let upiStr   = null;
      let payuLinkId = null;

      // ── Create PayU payment link ────────────────────────────────────
      if ((method === 'payu' || method === 'both') && biz.payu_merchant_key && biz.payu_merchant_salt) {
        try {
          const payuRes = await createPayuPaymentLink(biz, {
            amount,
            productinfo: description || 'Order',
            firstname:   customerName,
            phone:       customerPhone,
            txnid,
          });

          if (payuRes.status === 1 && payuRes.paymentLink) {
            payuUrl    = payuRes.paymentLink;
            payuLinkId = payuRes.linkId || null;
          } else {
            console.error('PayU error:', JSON.stringify(payuRes));
          }
        } catch (e) {
          console.error('PayU link creation failed:', e.message);
        }
      }

      // ── Generate UPI link ───────────────────────────────────────────
      if ((method === 'upi' || method === 'both') && biz.upi_id) {
        upiStr = generateUpiLink(biz.upi_id, biz.name, amount, description);
      }

      if (!payuUrl && !upiStr) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: 'No payment method available. Configure UPI ID or PayU credentials in Settings.' }),
        };
      }

      // ── Format WhatsApp message ─────────────────────────────────────
      const whatsappMsg = formatPaymentMessage({
        amount, description, txnid,
        payuUrl,
        upiId:        (method !== 'payu') ? biz.upi_id : null,
        businessName: biz.name,
      });

      // ── Store in DB ─────────────────────────────────────────────────
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: linkRow } = await supabase
        .from('payment_links')
        .insert({
          business_id:     businessId,
          conversation_id: conversationId || null,
          contact_id:      contactId || null,
          product_id:      productId || null,
          amount:          parseFloat(amount),
          currency:        'INR',
          description,
          method,
          txn_id:          txnid,
          payu_link_id:    payuLinkId,
          payu_short_url:  payuUrl,
          upi_string:      upiStr,
          status:          'created',
          expires_at:      expiresAt,
        })
        .select()
        .single();

      // ── Send via WhatsApp ───────────────────────────────────────────
      let waSent = false;
      if (sendToWhatsApp && customerPhone && biz.access_token && biz.phone_number_id) {
        const waRes = await sendWhatsAppMessage(biz.access_token, biz.phone_number_id, customerPhone, whatsappMsg);
        waSent = !!waRes.messages?.[0]?.id;

        if (waSent) {
          await supabase.from('payment_links').update({ sent_at: new Date().toISOString() }).eq('id', linkRow.id);

          // Log in conversation if exists
          if (conversationId) {
            await supabase.from('messages').insert({
              conversation_id: conversationId,
              from_phone:      biz.phone_number_id,
              to_phone:        customerPhone,
              content:         whatsappMsg,
              direction:       'outbound',
              sender_type:     'agent',
              status:          'sent',
              timestamp:       new Date().toISOString(),
            });
          }
        }
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success:      true,
          linkId:       linkRow?.id,
          txnid,
          payuUrl,
          upiStr,
          whatsappMsg,
          sent:         waSent,
        }),
      };
    } catch (err) {
      console.error('payment-link error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};

// ================================================
// Broadcast Send — processes one batch of contacts
// Called repeatedly by the frontend in chunks of 30
// POST /api/broadcast-send
// Body: { broadcastId, businessId, contacts: [{id,phone,name}],
//         campaign: {...}, displayMsg, isFinal, runningTotals: {sent,failed} }
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const delay = ms => new Promise(r => setTimeout(r, ms));

function personalize(text, contact) {
  if (!text) return text;
  const firstName = (contact.name || '').split(' ')[0] || contact.phone;
  return text
    .replace(/\{name\}/gi, contact.name || contact.phone)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{phone\}/gi, contact.phone);
}

function buildPayload(campaign, contact) {
  const { messageType, message, templateName, templateLanguage, templateVariables, templateButtons, mediaUrl, mediaType, mediaCaption } = campaign;

  if (messageType === 'template') {
    const components = [];
    if (mediaUrl && mediaType && mediaType !== 'none') {
      const key = mediaType === 'video' ? 'video' : 'image';
      components.push({ type: 'header', parameters: [{ type: key, [key]: { link: mediaUrl } }] });
    }
    if (templateVariables?.length) {
      components.push({ type: 'body', parameters: templateVariables.map(v => ({ type: 'text', text: personalize(v, contact) })) });
    }
    if (templateButtons?.length) {
      templateButtons.forEach(btn => {
        if (!btn.value) return;
        const idx = String(btn.index ?? 0);
        if (btn.sub_type === 'url') {
          components.push({ type: 'button', sub_type: 'url', index: idx, parameters: [{ type: 'text', text: personalize(btn.value, contact) }] });
        } else if (btn.sub_type === 'quick_reply') {
          components.push({ type: 'button', sub_type: 'quick_reply', index: idx, parameters: [{ type: 'payload', payload: personalize(btn.value, contact) }] });
        } else if (btn.sub_type === 'copy_code') {
          components.push({ type: 'button', sub_type: 'COPY_CODE', index: idx, parameters: [{ type: 'coupon_code', coupon_code: btn.value }] });
        }
      });
    }
    return { type: 'template', template: { name: templateName, language: { code: templateLanguage || 'en' }, ...(components.length ? { components } : {}) } };
  }

  if (messageType === 'image') return { type: 'image', image: { link: mediaUrl, ...(mediaCaption ? { caption: personalize(mediaCaption, contact) } : {}) } };
  if (messageType === 'video') return { type: 'video', video: { link: mediaUrl, ...(mediaCaption ? { caption: personalize(mediaCaption, contact) } : {}) } };

  return { type: 'text', text: { preview_url: true, body: personalize(message, contact) } };
}

async function sendWhatsAppMessage(accessToken, phoneNumberId, toPhone, payload) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: toPhone, ...payload }),
  });
  return res.json();
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const { broadcastId, businessId, contacts, campaign, displayMsg, isFinal, runningTotals = { sent: 0, failed: 0 } } = JSON.parse(event.body || '{}');

    if (!broadcastId || !businessId || !contacts?.length || !campaign) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'broadcastId, businessId, contacts, and campaign required' }) };
    }

    const { data: biz } = await supabase.from('businesses').select('access_token, phone_number_id').eq('id', businessId).single();
    if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };

    let sent = 0, failed = 0;
    const firstErrors = [];
    const now = new Date().toISOString();

    // Phase 1: send all WhatsApp messages sequentially (50ms gap for rate limiting)
    const results = [];
    for (const contact of contacts) {
      try {
        const payload = buildPayload(campaign, contact);
        const waRes = await sendWhatsAppMessage(biz.access_token, biz.phone_number_id, contact.phone, payload);
        const msgId = waRes.messages?.[0]?.id;
        const metaErr = waRes.error ? `${waRes.error.code}: ${waRes.error.message}` : null;
        const status = msgId ? 'sent' : 'failed';
        if (msgId) sent++;
        else {
          failed++;
          if (metaErr && firstErrors.length < 3) firstErrors.push({ phone: contact.phone, error: metaErr });
          console.error(`[broadcast-send] failed to ${contact.phone}:`, metaErr || JSON.stringify(waRes));
        }
        results.push({ contact, msgId, metaErr, status });
      } catch (err) {
        failed++;
        results.push({ contact, msgId: null, metaErr: err.message, status: 'failed' });
        console.error(`[broadcast-send] error for ${contact.phone}:`, err.message);
      }
      await delay(50);
    }

    // Phase 2: flush DB writes in parallel so they don't add to wall-clock time
    const contentText = displayMsg || campaign.message || campaign.templateName || '';
    const msgType = campaign.messageType === 'image' ? 'image' : campaign.messageType === 'video' ? 'video' : 'text';
    await Promise.all(results.map(async ({ contact, msgId, metaErr, status }) => {
      await supabase.from('broadcast_recipients')
        .update({ status, meta_message_id: msgId || null, error_message: metaErr, sent_at: now })
        .eq('broadcast_id', broadcastId)
        .eq('contact_id', contact.id);

      const { data: conv } = await supabase.from('conversations').select('id')
        .eq('contact_id', contact.id).eq('business_id', businessId).eq('status', 'open').maybeSingle();
      if (conv) {
        await supabase.from('messages').insert({
          conversation_id: conv.id,
          from_phone: biz.phone_number_id,
          to_phone: contact.phone,
          content: contentText,
          message_type: msgType,
          direction: 'outbound',
          sender_type: 'agent',
          status,
          meta_message_id: msgId || null,
          media_url: campaign.mediaUrl || null,
          timestamp: now,
        });
      }
    }));

    // On the last batch, finalize the broadcast record
    if (isFinal) {
      await supabase.from('broadcasts').update({
        status: 'sent',
        sent_count: runningTotals.sent + sent,
        failed_count: runningTotals.failed + failed,
      }).eq('id', broadcastId);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        sent,
        failed,
        ...(firstErrors.length ? { sample_errors: firstErrors } : {}),
      }),
    };
  } catch (err) {
    console.error('[broadcast-send] error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

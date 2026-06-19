// ================================================
// Scheduled Broadcast — runs every 5 minutes via Netlify cron
// Finds broadcasts with status='scheduled' and scheduled_at <= NOW()
// and sends them server-side (background function, 15-min timeout)
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
        } else if (btn.sub_type === 'flow') {
          components.push({ type: 'button', sub_type: 'flow', index: idx, parameters: [{ type: 'action', action: { flow_token: btn.value } }] });
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

async function processBroadcast(broadcast, biz) {
  // Fetch pending recipients joined with contact details
  const { data: rows } = await supabase
    .from('broadcast_recipients')
    .select('contact_id, contacts(id, phone, name)')
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'pending');

  if (!rows?.length) {
    await supabase.from('broadcasts').update({ status: 'sent', sent_count: 0, failed_count: 0 }).eq('id', broadcast.id);
    return;
  }

  const contacts = rows.map(r => r.contacts).filter(Boolean);
  const campaign = {
    messageType: broadcast.message_type,
    message: broadcast.message,
    templateName: broadcast.template_name,
    templateLanguage: broadcast.template_language || 'en',
    templateVariables: broadcast.template_variables || [],
    templateButtons: broadcast.template_buttons || [],
    mediaUrl: broadcast.media_url,
    mediaType: broadcast.media_type || 'none',
    mediaCaption: broadcast.media_caption,
  };

  let totalSent = 0, totalFailed = 0;
  const now = new Date().toISOString();
  const contentText = broadcast.message || '';
  const msgType = campaign.messageType === 'image' ? 'image' : campaign.messageType === 'video' ? 'video' : 'text';

  // Process in groups of 10 to keep memory usage steady
  const GROUP = 10;
  for (let i = 0; i < contacts.length; i += GROUP) {
    const group = contacts.slice(i, i + GROUP);
    const results = [];

    // Phase 1: send messages sequentially with 50ms gap
    for (const contact of group) {
      try {
        const payload = buildPayload(campaign, contact);
        const waRes = await sendWhatsAppMessage(biz.access_token, biz.phone_number_id, contact.phone, payload);
        const msgId = waRes.messages?.[0]?.id;
        const metaErr = waRes.error ? `${waRes.error.code}: ${waRes.error.message}` : null;
        const status = msgId ? 'sent' : 'failed';
        if (msgId) totalSent++; else totalFailed++;
        results.push({ contact, msgId, metaErr, status });
      } catch (err) {
        totalFailed++;
        results.push({ contact, msgId: null, metaErr: err.message, status: 'failed' });
        console.error(`[scheduled-broadcast] error for ${contact.phone}:`, err.message);
      }
      await delay(50);
    }

    // Phase 2: flush DB writes in parallel
    await Promise.all(results.map(async ({ contact, msgId, metaErr, status }) => {
      await supabase.from('broadcast_recipients')
        .update({ status, meta_message_id: msgId || null, error_message: metaErr, sent_at: now })
        .eq('broadcast_id', broadcast.id)
        .eq('contact_id', contact.id);

      const { data: conv } = await supabase.from('conversations').select('id')
        .eq('contact_id', contact.id).eq('business_id', broadcast.business_id).eq('status', 'open').maybeSingle();
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
  }

  await supabase.from('broadcasts').update({
    status: 'sent',
    sent_count: totalSent,
    failed_count: totalFailed,
    sent_at: now,
  }).eq('id', broadcast.id);

  console.log(`[scheduled-broadcast] ${broadcast.id} done — sent:${totalSent} failed:${totalFailed}`);
}

exports.handler = async () => {
  const now = new Date().toISOString();
  console.log(`[scheduled-broadcast] cron fired at ${now}`);

  // Claim due broadcasts atomically by setting status to 'sending' first
  const { data: due } = await supabase
    .from('broadcasts')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now);

  if (!due?.length) {
    console.log('[scheduled-broadcast] nothing due');
    return { statusCode: 200 };
  }

  console.log(`[scheduled-broadcast] found ${due.length} due broadcast(s)`);

  for (const broadcast of due) {
    // Claim it — if another invocation already claimed it, this update affects 0 rows
    const { data: claimed } = await supabase
      .from('broadcasts')
      .update({ status: 'sending', sent_at: now })
      .eq('id', broadcast.id)
      .eq('status', 'scheduled') // guard against double-processing
      .select('id');

    if (!claimed?.length) {
      console.log(`[scheduled-broadcast] ${broadcast.id} already claimed by another invocation, skipping`);
      continue;
    }

    const { data: biz } = await supabase.from('businesses').select('access_token, phone_number_id').eq('id', broadcast.business_id).single();
    if (!biz) {
      console.error(`[scheduled-broadcast] business ${broadcast.business_id} not found`);
      await supabase.from('broadcasts').update({ status: 'failed' }).eq('id', broadcast.id);
      continue;
    }

    try {
      await processBroadcast(broadcast, biz);
    } catch (err) {
      console.error(`[scheduled-broadcast] broadcast ${broadcast.id} failed:`, err.message);
      await supabase.from('broadcasts').update({ status: 'failed' }).eq('id', broadcast.id);
    }
  }

  return { statusCode: 200 };
};

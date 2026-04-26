// ================================================
// Broadcast Campaign API
// GET  /api/broadcast?businessId=X  → list campaigns
// POST /api/broadcast               → create & send campaign
//
// Supported messageType values:
//   'text'     — plain text (24-hr window only)
//   'template' — Meta-approved template (works anytime)
//   'image'    — image with optional caption (24-hr window)
//   'video'    — video with optional caption (24-hr window)
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Personalize text with contact fields ──────────────────────────────────
function personalize(text, contact) {
  if (!text) return text;
  const firstName = (contact.name || '').split(' ')[0] || contact.phone;
  return text
    .replace(/\{name\}/gi, contact.name || contact.phone)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{phone\}/gi, contact.phone);
}

// ── Build WhatsApp API message payload ────────────────────────────────────
function buildPayload(campaign, contact) {
  const {
    messageType,
    message,
    templateName,
    templateLanguage,
    templateVariables,
    mediaUrl,
    mediaType,
    mediaCaption,
  } = campaign;

  // ── Template ──────────────────────────────────────────────────────────
  if (messageType === 'template') {
    const components = [];

    // Header: image or video
    if (mediaUrl && mediaType && mediaType !== 'none') {
      const key = mediaType === 'video' ? 'video' : 'image';
      components.push({
        type: 'header',
        parameters: [{ type: key, [key]: { link: mediaUrl } }],
      });
    }

    // Body: variable substitution
    if (templateVariables?.length) {
      components.push({
        type: 'body',
        parameters: templateVariables.map(v => ({
          type: 'text',
          text: personalize(v, contact),
        })),
      });
    }

    return {
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLanguage || 'en' },
        ...(components.length ? { components } : {}),
      },
    };
  }

  // ── Image ─────────────────────────────────────────────────────────────
  if (messageType === 'image') {
    return {
      type: 'image',
      image: {
        link: mediaUrl,
        ...(mediaCaption ? { caption: personalize(mediaCaption, contact) } : {}),
      },
    };
  }

  // ── Video ─────────────────────────────────────────────────────────────
  if (messageType === 'video') {
    return {
      type: 'video',
      video: {
        link: mediaUrl,
        ...(mediaCaption ? { caption: personalize(mediaCaption, contact) } : {}),
      },
    };
  }

  // ── Text (default) ────────────────────────────────────────────────────
  return {
    type: 'text',
    text: { preview_url: false, body: personalize(message, contact) },
  };
}

// ── Send one WhatsApp message ─────────────────────────────────────────────
async function sendWhatsAppMessage(accessToken, phoneNumberId, toPhone, payload) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
        ...payload,
      }),
    }
  );
  return res.json();
}

// ── Human-readable summary for broadcast history ──────────────────────────
function displaySummary(campaign) {
  const { messageType, message, templateName, templateVariables, mediaUrl, mediaCaption } = campaign;
  if (messageType === 'template') {
    const vars = templateVariables?.length ? ` [${templateVariables.join(', ')}]` : '';
    return `[Template: ${templateName}]${vars}`;
  }
  if (messageType === 'image') return `[Image] ${mediaCaption || mediaUrl || ''}`;
  if (messageType === 'video') return `[Video] ${mediaCaption || mediaUrl || ''}`;
  return message || '';
}

// ── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  // ── GET: list broadcasts ───────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };

    const { data } = await supabase
      .from('broadcasts')
      .select('*')
      .eq('business_id', q.businessId)
      .order('created_at', { ascending: false })
      .limit(50);

    return { statusCode: 200, headers, body: JSON.stringify({ broadcasts: data || [] }) };
  }

  // ── POST: create and send broadcast ───────────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const {
        businessId,
        name,
        messageType = 'text',
        message,
        templateName,
        templateLanguage = 'en',
        templateVariables = [],
        mediaUrl,
        mediaType = 'none',
        mediaCaption,
        contactIds,
        tags,
      } = body;

      // Validation
      if (!businessId || !name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId and name required' }) };
      }
      if (messageType === 'text' && !message) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'message required for text campaigns' }) };
      }
      if (messageType === 'template' && !templateName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'templateName required for template campaigns' }) };
      }
      if ((messageType === 'image' || messageType === 'video') && !mediaUrl) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'mediaUrl required for image/video campaigns' }) };
      }

      // Fetch business
      const { data: biz } = await supabase.from('businesses').select('*').eq('id', businessId).single();
      if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };

      // Resolve recipients (opted-in only)
      let contactQuery = supabase
        .from('contacts')
        .select('*')
        .eq('business_id', businessId)
        .eq('opted_in', true);

      if (contactIds?.length) contactQuery = contactQuery.in('id', contactIds);
      else if (tags?.length) contactQuery = contactQuery.overlaps('tags', tags);

      const { data: contacts } = await contactQuery;
      if (!contacts?.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'No opted-in recipients found. Import contacts and ensure opted_in is true.' }) };
      }

      const campaign = { messageType, message, templateName, templateLanguage, templateVariables, mediaUrl, mediaType, mediaCaption };
      const displayMsg = displaySummary(campaign);

      // Create broadcast record
      const { data: broadcast } = await supabase
        .from('broadcasts')
        .insert({
          business_id: businessId,
          name,
          message: displayMsg,
          message_type: messageType,
          template_name: templateName || null,
          template_language: templateLanguage || 'en',
          template_variables: templateVariables.length ? templateVariables : null,
          media_url: mediaUrl || null,
          media_type: mediaType !== 'none' ? mediaType : null,
          media_caption: mediaCaption || null,
          recipient_count: contacts.length,
          status: 'sending',
          sent_at: new Date().toISOString(),
        })
        .select()
        .single();

      // Insert recipient rows
      await supabase.from('broadcast_recipients').insert(
        contacts.map(c => ({ broadcast_id: broadcast.id, contact_id: c.id, status: 'pending' }))
      );

      // Send messages
      let sentCount = 0;
      let failedCount = 0;

      for (const contact of contacts) {
        try {
          const payload = buildPayload(campaign, contact);
          const waRes = await sendWhatsAppMessage(biz.access_token, biz.phone_number_id, contact.phone, payload);
          const msgId = waRes.messages?.[0]?.id;
          const status = msgId ? 'sent' : 'failed';

          if (msgId) sentCount++;
          else failedCount++;

          // Update recipient status
          await supabase
            .from('broadcast_recipients')
            .update({ status, meta_message_id: msgId, sent_at: new Date().toISOString() })
            .eq('broadcast_id', broadcast.id)
            .eq('contact_id', contact.id);

          // Log in open conversation if exists
          const { data: conv } = await supabase
            .from('conversations')
            .select('id')
            .eq('contact_id', contact.id)
            .eq('business_id', businessId)
            .eq('status', 'open')
            .single();

          if (conv) {
            await supabase.from('messages').insert({
              conversation_id: conv.id,
              from_phone: biz.phone_number_id,
              to_phone: contact.phone,
              content: displayMsg,
              message_type: messageType === 'image' ? 'image' : messageType === 'video' ? 'video' : 'text',
              direction: 'outbound',
              sender_type: 'agent',
              status,
              meta_message_id: msgId,
              media_url: mediaUrl || null,
              timestamp: new Date().toISOString(),
            });
          }

          await delay(200); // Rate-limit protection
        } catch (err) {
          failedCount++;
          console.error(`Send failed for ${contact.phone}:`, err.message);
        }
      }

      // Finalize broadcast record
      await supabase
        .from('broadcasts')
        .update({ status: 'sent', sent_count: sentCount, failed_count: failedCount })
        .eq('id', broadcast.id);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          broadcastId: broadcast.id,
          sent: sentCount,
          failed: failedCount,
          total: contacts.length,
        }),
      };
    } catch (err) {
      console.error('Broadcast error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};

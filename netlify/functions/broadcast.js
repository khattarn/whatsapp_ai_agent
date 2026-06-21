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
    templateButtons,
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

    // Buttons: URL suffix, quick-reply payload, coupon code, or Flow token
    // Each button must already exist in the approved Meta template.
    // templateButtons = [{ index: 0, sub_type: 'url'|'quick_reply'|'copy_code'|'flow', value: '...' }, ...]
    if (templateButtons?.length) {
      templateButtons.forEach(btn => {
        if (!btn.value) return;
        const idx = String(btn.index ?? 0);

        if (btn.sub_type === 'url') {
          // Dynamic URL suffix — template button must use a variable at the end
          components.push({
            type: 'button', sub_type: 'url', index: idx,
            parameters: [{ type: 'text', text: personalize(btn.value, contact) }],
          });
        } else if (btn.sub_type === 'quick_reply') {
          // Payload sent back when customer taps this button
          components.push({
            type: 'button', sub_type: 'quick_reply', index: idx,
            parameters: [{ type: 'payload', payload: personalize(btn.value, contact) }],
          });
        } else if (btn.sub_type === 'copy_code') {
          // Coupon code button
          components.push({
            type: 'button', sub_type: 'COPY_CODE', index: idx,
            parameters: [{ type: 'coupon_code', coupon_code: btn.value }],
          });
        } else if (btn.sub_type === 'flow') {
          // WhatsApp Flow button — value = flow_token (Flow ID is in the template)
          components.push({
            type: 'button', sub_type: 'flow', index: idx,
            parameters: [{ type: 'action', action: { flow_token: btn.value } }],
          });
        }
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
    text: { preview_url: true, body: personalize(message, contact) },
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

  // ── GET: list broadcasts / per-broadcast detail ───────────────────────
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };

    // Detail view: per-recipient engagement for a specific broadcast
    if (q.broadcastId) {
      const { data: broadcast } = await supabase
        .from('broadcasts').select('*')
        .eq('id', q.broadcastId).eq('business_id', q.businessId).single();
      if (!broadcast) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Broadcast not found' }) };

      const { data: rows } = await supabase
        .from('broadcast_recipients')
        .select('contact_id, status, meta_message_id, sent_at, delivered_at, read_at, clicked_at, click_payload, error_message, contacts(id, name, phone)')
        .eq('broadcast_id', q.broadcastId)
        .order('status', { ascending: true });

      const recipients = (rows || []).map(r => ({
        contactId: r.contact_id,
        name: r.contacts?.name || r.contacts?.phone || '—',
        phone: r.contacts?.phone || '—',
        status: r.status,
        sentAt: r.sent_at,
        deliveredAt: r.delivered_at,
        readAt: r.read_at,
        clickedAt: r.clicked_at,
        clickPayload: r.click_payload,
        errorMessage: r.error_message,
      }));

      const summary = {
        total: recipients.length,
        pending: recipients.filter(r => r.status === 'pending').length,
        sent: recipients.filter(r => r.status === 'sent').length,
        failed: recipients.filter(r => r.status === 'failed').length,
        delivered: recipients.filter(r => r.deliveredAt).length,
        read: recipients.filter(r => r.readAt).length,
        clicked: recipients.filter(r => r.clickedAt).length,
      };

      return { statusCode: 200, headers, body: JSON.stringify({ broadcast, recipients, summary }) };
    }

    // List all broadcasts for this business
    const { data } = await supabase
      .from('broadcasts')
      .select('*')
      .eq('business_id', q.businessId)
      .order('created_at', { ascending: false })
      .limit(50);

    return { statusCode: 200, headers, body: JSON.stringify({ broadcasts: data || [] }) };
  }

  // ── PATCH: cancel or resend a broadcast ──────────────────────────────
  if (event.httpMethod === 'PATCH') {
    try {
      const { broadcastId, action, businessId } = JSON.parse(event.body || '{}');
      if (!broadcastId || !action) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'broadcastId and action required' }) };
      }

      // ── cancel ────────────────────────────────────────────────────────
      if (action === 'cancel') {
        const { data, error } = await supabase.from('broadcasts')
          .update({ status: 'cancelled' })
          .eq('id', broadcastId)
          .eq('status', 'scheduled')
          .select('id');
        if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        if (!data?.length) return { statusCode: 409, headers, body: JSON.stringify({ error: 'Broadcast not found or already past scheduled status' }) };
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      }

      // ── resend: return pending/failed contacts for client-side batching ──
      if (action === 'resend') {
        if (!businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required for resend' }) };

        const { data: broadcast } = await supabase.from('broadcasts').select('*')
          .eq('id', broadcastId).eq('business_id', businessId).single();
        if (!broadcast) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Broadcast not found' }) };

        const { data: rows } = await supabase
          .from('broadcast_recipients')
          .select('contact_id, contacts(id, name, phone)')
          .eq('broadcast_id', broadcastId)
          .in('status', ['pending', 'failed']);

        if (!rows?.length) {
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, contacts: [], total: 0, message: 'No pending recipients' }) };
        }

        const contacts = rows.map(r => ({
          id: r.contacts.id,
          phone: r.contacts.phone,
          name: r.contacts.name || r.contacts.phone,
        }));

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

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            broadcastId,
            contacts,
            campaign,
            displayMsg: broadcast.message,
            total: contacts.length,
            existingTotals: {
              sent: broadcast.sent_count || 0,
              failed: broadcast.failed_count || 0,
            },
          }),
        };
      }

      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
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
        templateButtons = [],
        mediaUrl,
        mediaType = 'none',
        mediaCaption,
        contactIds,
        tags,
        scheduledAt,
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

      const campaign = { messageType, message, templateName, templateLanguage, templateVariables, templateButtons, mediaUrl, mediaType, mediaCaption };
      const displayMsg = displaySummary(campaign);

      // Validate scheduled time is in the future
      if (scheduledAt && new Date(scheduledAt) <= new Date()) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Scheduled time must be in the future' }) };
      }

      const isScheduled = !!scheduledAt;

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
          template_buttons: templateButtons.length ? templateButtons : null,
          media_url: mediaUrl || null,
          media_type: mediaType !== 'none' ? mediaType : null,
          media_caption: mediaCaption || null,
          recipient_count: contacts.length,
          status: isScheduled ? 'scheduled' : 'sending',
          scheduled_at: isScheduled ? scheduledAt : null,
          sent_at: isScheduled ? null : new Date().toISOString(),
        })
        .select()
        .single();

      // Insert recipient rows
      await supabase.from('broadcast_recipients').insert(
        contacts.map(c => ({ broadcast_id: broadcast.id, contact_id: c.id, status: 'pending' }))
      );

      // Scheduled: cron will handle the send — return early
      if (isScheduled) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, scheduled: true, broadcastId: broadcast.id, scheduledAt, total: contacts.length }),
        };
      }

      // Send now: return contacts for client-side batching via /api/broadcast-send
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          broadcastId: broadcast.id,
          total: contacts.length,
          contacts: contacts.map(c => ({ id: c.id, phone: c.phone, name: c.name || c.phone })),
          campaign,
          displayMsg,
        }),
      };
    } catch (err) {
      console.error('Broadcast error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};

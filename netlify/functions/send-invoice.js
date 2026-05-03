// ================================================
// Invoice API
//
// POST /api/send-invoice        → save invoice record, upload PDF to
//                                 Supabase Storage, send via WhatsApp
// GET  /api/send-invoice?businessId=X           → list invoices
// GET  /api/send-invoice?businessId=X&id=Y      → single invoice
// PATCH /api/send-invoice                       → update invoice (e.g. mark paid)
// DELETE /api/send-invoice?id=X                 → delete invoice record
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helper: generate sequential invoice number ─────────────────────────────
async function generateInvoiceNo(businessId) {
  const year  = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');

  // Count existing invoices for this business this financial year
  const fyStart = new Date().getMonth() >= 3
    ? `${year}-04-01`
    : `${year - 1}-04-01`;

  const { count } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .gte('created_at', fyStart);

  const seq = String((count || 0) + 1).padStart(4, '0');
  return `INV-${year}${month}-${seq}`;
}

// ── Helper: upload PDF buffer to Supabase Storage ─────────────────────────
async function uploadPdf(businessId, invoiceNo, base64Pdf) {
  const buffer = Buffer.from(base64Pdf, 'base64');
  const path   = `${businessId}/${invoiceNo.replace(/\//g, '-')}_${Date.now()}.pdf`;

  const { error } = await supabase.storage
    .from('invoices')
    .upload(path, buffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (error) throw new Error('Storage upload failed: ' + error.message);

  const { data: urlData } = supabase.storage
    .from('invoices')
    .getPublicUrl(path);

  return urlData.publicUrl;
}

// ── Helper: send WhatsApp document message ─────────────────────────────────
async function sendWhatsAppDocument(accessToken, phoneNumberId, toPhone, pdfUrl, filename, caption) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                toPhone,
        type:              'document',
        document: {
          link:     pdfUrl,
          filename: filename,
          caption:  caption,
        },
      }),
    }
  );
  return res.json();
}

// ── Helper: send WhatsApp text message ────────────────────────────────────
async function sendWhatsAppText(accessToken, phoneNumberId, toPhone, text) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                toPhone,
        type:              'text',
        text: { preview_url: false, body: text },
      }),
    }
  );
  return res.json();
}

// ── Helper: format invoice summary text for WhatsApp ─────────────────────
function formatInvoiceSummary(invoice, businessName) {
  const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  let msg = `🧾 *Invoice ${invoice.invoice_no}*\n`;
  msg += `📅 Date: ${new Date(invoice.invoice_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}\n`;
  msg += `🏪 From: *${businessName}*\n\n`;

  if (invoice.customer_name) msg += `👤 To: *${invoice.customer_name}*\n`;
  if (invoice.customer_address) msg += `📍 ${invoice.customer_address}\n`;
  if (invoice.customer_gstin) msg += `🏷 GSTIN: ${invoice.customer_gstin}\n`;
  msg += '\n';

  // Line items summary (up to 8 items to keep message concise)
  const items = invoice.items || [];
  if (items.length) {
    msg += `*Items:*\n`;
    items.slice(0, 8).forEach(item => {
      const amount = fmt(item.total || item.amount);
      msg += `• ${item.description || item.name} (${item.qty} × ${fmt(item.rate)}) = *${amount}*\n`;
    });
    if (items.length > 8) msg += `  _...and ${items.length - 8} more item(s)_\n`;
    msg += '\n';
  }

  // Totals
  msg += `Subtotal: ${fmt(invoice.subtotal)}\n`;
  if (Number(invoice.cgst_total) > 0) msg += `CGST: ${fmt(invoice.cgst_total)}\n`;
  if (Number(invoice.sgst_total) > 0) msg += `SGST: ${fmt(invoice.sgst_total)}\n`;
  if (Number(invoice.igst_total) > 0) msg += `IGST: ${fmt(invoice.igst_total)}\n`;
  if (Number(invoice.discount)   > 0) msg += `Discount: -${fmt(invoice.discount)}\n`;
  msg += `\n💰 *Grand Total: ${fmt(invoice.grand_total)}*\n`;

  if (invoice.notes) msg += `\n📝 ${invoice.notes}`;

  msg += `\n\n_Please find the detailed invoice PDF attached. Thank you for your business! 🙏_`;
  return msg;
}

// ── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  // ── GET: list or fetch invoices ────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.businessId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };
    }

    try {
      if (q.id) {
        // Single invoice
        const { data, error } = await supabase
          .from('invoices')
          .select('*, contacts(name, phone)')
          .eq('id', q.id)
          .eq('business_id', q.businessId)
          .single();
        if (error) throw error;
        return { statusCode: 200, headers, body: JSON.stringify({ invoice: data }) };
      }

      // List invoices with optional filters
      let query = supabase
        .from('invoices')
        .select('id, invoice_no, invoice_date, customer_name, customer_phone, grand_total, status, pdf_url, sent_at, created_at, source')
        .eq('business_id', q.businessId)
        .order('created_at', { ascending: false })
        .limit(100);

      if (q.status)      query = query.eq('status', q.status);
      if (q.contactId)   query = query.eq('contact_id', q.contactId);
      if (q.search) {
        const term = q.search;
        query = query.or(`invoice_no.ilike.%${term}%,customer_name.ilike.%${term}%,customer_phone.ilike.%${term}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return { statusCode: 200, headers, body: JSON.stringify({ invoices: data || [] }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST: create invoice, upload PDF, send via WhatsApp ───────────────
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const {
        businessId,
        conversationId,
        contactId,

        // Invoice data
        invoiceNo,          // optional — auto-generated if omitted
        invoiceDate,
        dueDate,
        customerName,
        customerPhone,
        customerAddress,
        customerGstin,
        items = [],         // line item array
        subtotal,
        discount = 0,
        cgstTotal = 0,
        sgstTotal = 0,
        igstTotal = 0,
        grandTotal,
        notes,
        source = 'manual',

        // PDF delivery
        pdfBase64,          // base64-encoded PDF content
        sendToWhatsApp = true,
      } = body;

      if (!businessId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };
      }
      if (!items.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'At least one line item required' }) };
      }

      // Fetch business
      const { data: biz } = await supabase
        .from('businesses')
        .select('*')
        .eq('id', businessId)
        .single();
      if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };

      // Generate invoice number if not supplied
      const finalInvoiceNo = invoiceNo?.trim() || await generateInvoiceNo(businessId);

      // Upload PDF to Supabase Storage (if provided)
      let pdfUrl = null;
      if (pdfBase64) {
        pdfUrl = await uploadPdf(businessId, finalInvoiceNo, pdfBase64);
      }

      // Compute totals from items if not supplied
      const computedSubtotal  = subtotal  ?? items.reduce((s, i) => s + Number(i.amount || 0), 0);
      const computedCgst      = cgstTotal ?? items.reduce((s, i) => s + Number(i.cgst_amount || 0), 0);
      const computedSgst      = sgstTotal ?? items.reduce((s, i) => s + Number(i.sgst_amount || 0), 0);
      const computedIgst      = igstTotal ?? items.reduce((s, i) => s + Number(i.igst_amount || 0), 0);
      const computedGrandTotal = grandTotal ?? (computedSubtotal - Number(discount) + computedCgst + computedSgst + computedIgst);

      // Save invoice record
      const { data: invoiceRow, error: invErr } = await supabase
        .from('invoices')
        .insert({
          business_id:      businessId,
          conversation_id:  conversationId || null,
          contact_id:       contactId || null,
          invoice_no:       finalInvoiceNo,
          invoice_date:     invoiceDate || new Date().toISOString().split('T')[0],
          due_date:         dueDate || null,
          customer_name:    customerName?.trim() || null,
          customer_phone:   customerPhone?.trim() || null,
          customer_address: customerAddress?.trim() || null,
          customer_gstin:   customerGstin?.trim() || null,
          items,
          subtotal:         computedSubtotal,
          discount:         Number(discount),
          cgst_total:       computedCgst,
          sgst_total:       computedSgst,
          igst_total:       computedIgst,
          grand_total:      computedGrandTotal,
          notes:            notes?.trim() || null,
          source,
          pdf_url:          pdfUrl,
          status:           'draft',
        })
        .select()
        .single();

      if (invErr) throw invErr;

      // Send via WhatsApp
      let waSent = false;
      const targetPhone = customerPhone || (contactId ? null : null);

      if (sendToWhatsApp && targetPhone && biz.access_token && biz.phone_number_id && pdfUrl) {
        const caption  = formatInvoiceSummary(invoiceRow, biz.name);
        const filename = `Invoice_${finalInvoiceNo}.pdf`;

        const waRes = await sendWhatsAppDocument(
          biz.access_token,
          biz.phone_number_id,
          targetPhone,
          pdfUrl,
          filename,
          caption
        );

        waSent = !!waRes.messages?.[0]?.id;

        if (waSent) {
          // Update sent_at and status
          await supabase
            .from('invoices')
            .update({ sent_at: new Date().toISOString(), status: 'sent' })
            .eq('id', invoiceRow.id);

          invoiceRow.status  = 'sent';
          invoiceRow.sent_at = new Date().toISOString();

          // Log in conversation messages
          if (conversationId) {
            await supabase.from('messages').insert({
              conversation_id: conversationId,
              from_phone:      biz.phone_number_id,
              to_phone:        targetPhone,
              content:         `📄 Invoice ${finalInvoiceNo} sent (₹${computedGrandTotal.toLocaleString('en-IN')})`,
              direction:       'outbound',
              sender_type:     'agent',
              status:          'sent',
              media_url:       pdfUrl,
              message_type:    'document',
              timestamp:       new Date().toISOString(),
            });
          }
        }
      } else if (sendToWhatsApp && !pdfUrl && targetPhone && biz.access_token && biz.phone_number_id) {
        // No PDF — send text summary only
        const summaryText = formatInvoiceSummary(invoiceRow, biz.name);
        const waRes = await sendWhatsAppText(biz.access_token, biz.phone_number_id, targetPhone, summaryText);
        waSent = !!waRes.messages?.[0]?.id;

        if (waSent) {
          await supabase.from('invoices').update({ sent_at: new Date().toISOString(), status: 'sent' }).eq('id', invoiceRow.id);
          if (conversationId) {
            await supabase.from('messages').insert({
              conversation_id: conversationId,
              from_phone:      biz.phone_number_id,
              to_phone:        targetPhone,
              content:         `📄 Invoice ${finalInvoiceNo} sent (text summary)`,
              direction:       'outbound',
              sender_type:     'agent',
              status:          'sent',
              timestamp:       new Date().toISOString(),
            });
          }
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success:   true,
          invoiceId: invoiceRow.id,
          invoiceNo: finalInvoiceNo,
          pdfUrl,
          sent:      waSent,
          invoice:   invoiceRow,
        }),
      };
    } catch (err) {
      console.error('send-invoice error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── PATCH: update invoice ─────────────────────────────────────────────
  if (event.httpMethod === 'PATCH') {
    try {
      const body = JSON.parse(event.body || '{}');
      const { id, status, notes, paidAt } = body;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };

      const updates = {};
      if (status  !== undefined) updates.status   = status;
      if (notes   !== undefined) updates.notes    = notes;
      if (paidAt  !== undefined) updates.paid_at  = paidAt;
      if (status === 'paid' && !paidAt) updates.paid_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('invoices')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, invoice: data }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── DELETE: delete invoice ────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    const q = event.queryStringParameters || {};
    if (!q.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };
    try {
      const { error } = await supabase.from('invoices').delete().eq('id', q.id);
      if (error) throw error;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};

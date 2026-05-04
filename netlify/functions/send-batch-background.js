// netlify/functions/send-batch-background.js
// Scheduled outreach batch — sends personalised email invites to advocates.
// Triggered by Netlify schedule (10am IST = 04:30 UTC) or by Beta3 admin
// dashboard "Run Now" button via OUTREACH_AGENT_BATCH_URL.
// Auth: x-cron-secret header must match OUTREACH_CRON_SECRET env var.

const { createClient } = require('@supabase/supabase-js');
const https = require('https');

function getSupabase() {
  const url = process.env.OUTREACH_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.OUTREACH_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

function sendViaResend(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return Promise.resolve(null);
  return new Promise(resolve => {
    const payload = JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'nidhi@legalaidai.in',
      to: [to],
      subject,
      text,
      reply_to: 'info@legalaidai.in',
    });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        const ok = res.statusCode === 200 || res.statusCode === 201;
        try { resolve(ok ? JSON.parse(body) : null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

function buildEmail(advocate) {
  const firstName = (advocate.full_name || '').split(' ')[0] || 'Advocate';
  const area = advocate.practice_area ? ` in ${advocate.practice_area}` : '';
  const city = advocate.city ? `, ${advocate.city}` : '';

  const subject = `Nyaya Saathi Pro — AI legal tools for advocates${city}`;
  const text = [
    `Dear ${firstName},`,
    '',
    `I am writing to invite you to try Nyaya Saathi Pro — an AI-powered legal assistant built for practising advocates${area} in India.`,
    '',
    'What it offers:',
    '  • Instant legal research across Indian statutes and case law',
    '  • AI document drafting (bail applications, legal notices, vakalatnamas)',
    '  • eCourts case status by CNR number',
    '  • WhatsApp AI at +91 98714 22567 for on-the-go queries',
    '',
    'We are currently in beta and offering free access to a select group of advocates. No payment or commitment required.',
    '',
    'To get started: https://www.legalaidai.in/advocate',
    '',
    'Reach us anytime at info@legalaidai.in.',
    '',
    'Warm regards,',
    'Neeraj Khattar',
    'Nyaya Saathi | www.legalaidai.in',
  ].join('\n');

  return { subject, text };
}

exports.handler = async (event) => {
  const secret = process.env.OUTREACH_CRON_SECRET || '';

  // Scheduled invocations have httpMethod undefined; manual calls need the secret
  const isScheduled = !event.httpMethod || event.httpMethod === 'GET';
  if (!isScheduled && secret) {
    const incoming = (event.headers?.['x-cron-secret'] || event.headers?.['X-Cron-Secret'] || '');
    if (incoming !== secret) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }
  }

  let db;
  try { db = getSupabase(); } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  // Check enabled flag
  const { data: settingsRows } = await db.from('settings').select('key,value')
    .in('key', ['outreach_cron_enabled']);
  const enabled = (settingsRows || []).find(r => r.key === 'outreach_cron_enabled')?.value === 'true';
  if (!enabled) {
    return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Cron disabled', sent: 0, failed: 0 }) };
  }

  let reqBody = {};
  try { reqBody = JSON.parse(event.body || '{}'); } catch {}
  const batchSize = Math.min(reqBody.batchSize || 20, 50);

  const { data: advocates, error } = await db
    .from('advocates')
    .select('id,full_name,email,city,state,practice_area,status')
    .eq('status', 'ready_to_contact')
    .not('email', 'is', null)
    .neq('do_not_contact', true)
    .limit(batchSize);

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  let sent = 0, failed = 0;
  const now = new Date().toISOString();

  for (const advocate of advocates || []) {
    try {
      const { subject, text } = buildEmail(advocate);
      const result = await sendViaResend(advocate.email, subject, text);

      if (result?.id) {
        sent++;

        await db.from('advocates')
          .update({ status: 'contacted', last_contacted_at: now })
          .eq('id', advocate.id);

        // Ensure conversation row exists, then log the sent message
        let convId = null;
        const { data: existingConv } = await db.from('outreach_conversations')
          .select('id').eq('advocate_id', advocate.id).maybeSingle();

        if (existingConv) {
          convId = existingConv.id;
        } else {
          const { data: newConv, error: convErr } = await db.from('outreach_conversations')
            .insert({ advocate_id: advocate.id }).select('id').single();
          if (convErr) console.error('[send-batch-background] conv insert failed:', convErr.message);
          convId = newConv?.id;
        }

        if (convId) {
          const { error: msgErr } = await db.from('outreach_messages').insert({
            conversation_id: convId,
            subject,
            body: text,
            status: 'sent',
            classified_intent: 'outreach',
            needs_human_review: false,
            sent_at: now,
            provider_id: result.id,
          });
          if (msgErr) console.error('[send-batch-background] message log failed:', msgErr.message);
        }
      } else {
        failed++;
        console.error('[send-batch-background] Resend failed for', advocate.email);
      }
    } catch (e) {
      failed++;
      console.error('[send-batch-background] error for', advocate.email, e.message);
    }
  }

  const runResult = { sent, failed, total: advocates?.length || 0, runAt: now };

  const { error: settingsErr } = await db.from('settings').upsert([
    { key: 'outreach_last_run', value: now },
    { key: 'outreach_last_run_result', value: JSON.stringify(runResult) },
  ], { onConflict: 'key' });
  if (settingsErr) console.error('[send-batch-background] settings update failed:', settingsErr.message);

  console.log('[send-batch-background] done:', runResult);
  return { statusCode: 200, body: JSON.stringify({ success: true, ...runResult }) };
};

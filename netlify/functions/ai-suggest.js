// ================================================
// AI Suggestion for agent reply
// POST /api/ai-suggest
// Body: { conversationId }
// ================================================

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const { conversationId } = JSON.parse(event.body || '{}');
    if (!conversationId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'conversationId required' }) };

    // Fetch conversation with business details
    const { data: conv } = await supabase
      .from('conversations')
      .select('*, contacts(*), businesses(*)')
      .eq('id', conversationId)
      .single();

    if (!conv) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

    // Get last 10 messages
    const { data: msgs } = await supabase
      .from('messages')
      .select('content, direction, sender_type')
      .eq('conversation_id', conversationId)
      .in('sender_type', ['customer', 'ai', 'agent'])
      .order('timestamp', { ascending: true })
      .limit(10);

    const claudeMessages = (msgs || []).map(m => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content,
    }));

    if (!claudeMessages.length || claudeMessages[claudeMessages.length - 1].role !== 'user') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No customer message to respond to' }) };
    }

    const biz = conv.businesses;
    const aiRes = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 400,
      system: (biz.system_prompt || `You are a helpful customer service agent for ${biz.name}.`) +
        '\n\nYou are drafting a reply for a human agent to review before sending. Be concise and helpful.',
      messages: claudeMessages,
    });

    const suggestion = aiRes.content[0]?.text || '';
    return { statusCode: 200, headers, body: JSON.stringify({ suggestion }) };
  } catch (err) {
    console.error('ai-suggest error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

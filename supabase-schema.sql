-- ================================================
-- WhatsApp AI Agent - Supabase Schema
-- Run this in your Supabase SQL Editor
-- ================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ================================================
-- BUSINESSES
-- One row per WhatsApp number / business
-- ================================================
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  phone_number_id TEXT NOT NULL UNIQUE,   -- Meta WhatsApp Phone Number ID
  waba_id TEXT,                            -- WhatsApp Business Account ID
  access_token TEXT NOT NULL,              -- Meta System User Permanent Token
  system_prompt TEXT,                      -- Custom AI personality for this business
  ai_auto_threshold TEXT DEFAULT 'simple', -- 'simple' | 'all' | 'none'
  color TEXT DEFAULT '#25D366',            -- Accent color in dashboard
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ================================================
-- CONTACTS
-- Customers that have messaged any business
-- ================================================
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone TEXT NOT NULL,
  name TEXT,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  opted_in BOOLEAN DEFAULT TRUE,
  tags TEXT[] DEFAULT '{}',
  notes TEXT,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(phone, business_id)
);

-- ================================================
-- CONVERSATIONS
-- One active thread per contact per business
-- ================================================
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','resolved','archived')),
  ai_enabled BOOLEAN DEFAULT TRUE,
  needs_human BOOLEAN DEFAULT FALSE,
  unread_count INTEGER DEFAULT 0,
  last_message TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast inbox queries
CREATE INDEX IF NOT EXISTS idx_conversations_business_status
  ON conversations(business_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_needs_human
  ON conversations(business_id, needs_human) WHERE needs_human = TRUE;

-- ================================================
-- MESSAGES
-- Every inbound/outbound message
-- ================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text','image','document','audio','video','template')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer','ai','agent','ai_suggestion')),
  status TEXT DEFAULT 'delivered' CHECK (status IN ('pending','sent','delivered','read','failed','pending_review')),
  meta_message_id TEXT,
  media_url TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for conversation thread queries
CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp
  ON messages(conversation_id, timestamp ASC);

-- ================================================
-- BROADCASTS
-- Campaigns sent to multiple contacts
-- ================================================
CREATE TABLE IF NOT EXISTS broadcasts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  template_name TEXT,               -- If using Meta approved template
  recipient_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed')),
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  tags TEXT[] DEFAULT '{}',         -- Target contacts with these tags
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ================================================
-- BROADCAST RECIPIENTS
-- ================================================
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broadcast_id UUID REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','sent','delivered','read','failed')),
  meta_message_id TEXT,
  sent_at TIMESTAMPTZ,
  UNIQUE(broadcast_id, contact_id)
);

-- ================================================
-- SEED DATA - Your Two Businesses
-- Replace the placeholder values with your real Meta credentials
-- ================================================
INSERT INTO businesses (name, description, phone_number_id, waba_id, access_token, color, system_prompt) VALUES
(
  'Garment Retail',
  'Fashion and clothing retail store',
  'YOUR_GARMENT_PHONE_NUMBER_ID',
  'YOUR_GARMENT_WABA_ID',
  'YOUR_GARMENT_ACCESS_TOKEN',
  '#FF6B35',
  'You are a helpful customer service assistant for our garment retail store. You help customers with:
- Product inquiries (clothing, fabrics, sizes, styles)
- Pricing and offers
- Order status and delivery timelines
- Return and exchange policies
- Store hours and location

Be friendly, concise, and professional. Always offer to escalate to a human agent for complex issues like complaints or custom orders. Reply in the same language the customer uses (Hindi/English/Hinglish).'
),
(
  'LegalAid AI',
  'AI-powered legal assistance platform',
  'YOUR_LEGALAIDAI_PHONE_NUMBER_ID',
  'YOUR_LEGALAIDAI_WABA_ID',
  'YOUR_LEGALAIDAI_ACCESS_TOKEN',
  '#4A90D9',
  'You are a helpful customer service assistant for LegalAid AI (https://www.legalaidai.in/), an AI-powered legal assistance platform. You help users with:
- Understanding our subscription plans (Monthly and Yearly options)
- Platform features and capabilities
- Onboarding and getting started
- Technical support
- Billing and account questions

Important: You are NOT a lawyer and do NOT provide actual legal advice. You help users understand how to use the LegalAid AI platform. For actual legal questions, direct them to use the platform. Be professional, knowledgeable, and helpful. Escalate billing disputes or complex account issues to a human agent.'
);

-- ================================================
-- Row Level Security (Optional but recommended)
-- ================================================
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by Netlify Functions)
CREATE POLICY "Service role full access" ON businesses FOR ALL USING (TRUE);
CREATE POLICY "Service role full access" ON contacts FOR ALL USING (TRUE);
CREATE POLICY "Service role full access" ON conversations FOR ALL USING (TRUE);
CREATE POLICY "Service role full access" ON messages FOR ALL USING (TRUE);
CREATE POLICY "Service role full access" ON broadcasts FOR ALL USING (TRUE);
CREATE POLICY "Service role full access" ON broadcast_recipients FOR ALL USING (TRUE);

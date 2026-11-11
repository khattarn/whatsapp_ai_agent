// ================================================
// Global WhatsApp block list
//
// Numbers on this list are never messaged (dashboard replies, bot replies, broadcasts,
// scheduled broadcasts, invoices, payment links) and anything they send in is dropped
// by the webhook before it is stored or answered. It applies to every business.
//
// The numbers live in the BLOCKED_NUMBERS environment variable (Netlify → Site
// configuration → Environment variables), NOT in this file: this repo is public, and
// people's phone numbers must not be committed. Separate entries with commas, spaces
// or new lines, in any common format:
//   BLOCKED_NUMBERS=919876543210, +91 98765 43211, 09876543212
// Env var changes only take effect on the next deploy.
//
// Lives in a subfolder on purpose: Netlify turns every top-level file in
// netlify/functions into a function, but not files in a folder like this one.
// ================================================

// Reduce any phone format to bare digits with a country code, so that "+91 98765 43210",
// "09876543210", "9876543210" and "919876543210" all compare equal. Bare 10-digit numbers
// and numbers with a leading trunk "0" / "00" are assumed to be Indian (+91).
function normalizePhone(phone) {
  let digits = String(phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length === 10) digits = '91' + digits;
  return digits;
}

function blockedSet() {
  return new Set(
    (process.env.BLOCKED_NUMBERS || '')
      .split(/[\s,;]+/)
      .map(normalizePhone)
      .filter(Boolean)
  );
}

function isBlockedNumber(phone) {
  const n = normalizePhone(phone);
  return n !== '' && blockedSet().has(n);
}

// Shaped like a Meta API error so every existing sender treats it as a failed send
// (they all check `res.messages?.[0]?.id`) and records/logs it the way it would a real failure.
const BLOCKED_SEND_RESULT = Object.freeze({
  error: { code: 'BLOCKED', message: 'Number is on the block list — message not sent' },
});

module.exports = { normalizePhone, isBlockedNumber, BLOCKED_SEND_RESULT };

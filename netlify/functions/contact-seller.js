const ALLOWED_ORIGINS = new Set([
  'https://garagehoppers.com',
  'https://www.garagehoppers.com',
  'http://localhost:8000',
  'http://localhost:8888',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:8888'
]);
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_MESSAGES_PER_IP = 5;
const MAX_MESSAGES_PER_LISTING_EMAIL = 2;
const MIN_FORM_TIME_MS = 3000;
const MAX_FORM_AGE_MS = 60 * 60 * 1000;
const rateBuckets = new Map();

function getCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://garagehoppers.com',
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

function getOrigin(event) {
  return event.headers.origin || event.headers.Origin || '';
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.netlify.app');
  } catch (error) {
    return false;
  }
}

function pruneRateBuckets(now) {
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now - bucket.startedAt > RATE_LIMIT_WINDOW_MS) {
      rateBuckets.delete(key);
    }
  }
}

function checkRateLimit(key, limit, now) {
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { count: 1, startedAt: now });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= limit;
}

function getClientIp(event) {
  const forwarded = event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'] || '';
  return String(forwarded).split(',')[0].trim() || event.headers['client-ip'] || 'unknown';
}

function json(statusCode, body, origin = '') {
  return {
    statusCode,
    headers: { ...getCorsHeaders(origin), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

exports.handler = async (event) => {
  const origin = getOrigin(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: getCorsHeaders(origin), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' }, origin);
  }

  if (!isAllowedOrigin(origin)) {
    return json(403, { error: 'Request is not allowed.' }, origin);
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://mpgnkvpfgmqegljycedf.supabase.co';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || process.env.FROM_EMAIL;

  if (!supabaseUrl || !supabaseServiceKey || !resendApiKey || !fromEmail) {
    return json(500, { error: 'Email service is not configured.' }, origin);
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid request body.' }, origin);
  }

  const listingId = cleanText(payload.listingId, 80);
  const senderName = cleanText(payload.name, 80) || 'A shopper';
  const senderEmail = cleanText(payload.email, 160).toLowerCase();
  const message = cleanText(payload.message, 2000);
  const honeypot = cleanText(payload.website, 200);
  const startedAt = Number(payload.startedAt || 0);
  const now = Date.now();
  const formAge = now - startedAt;

  if (honeypot) return json(200, { ok: true }, origin);
  if (!startedAt || formAge < MIN_FORM_TIME_MS || formAge > MAX_FORM_AGE_MS) {
    return json(400, { error: 'Please try sending your message again.' }, origin);
  }
  if (!listingId) return json(400, { error: 'Listing is required.' }, origin);
  if (!isEmail(senderEmail)) return json(400, { error: 'A valid email is required.' }, origin);
  if (message.length < 10) return json(400, { error: 'Message must be at least 10 characters.' }, origin);

  pruneRateBuckets(now);
  const clientIp = getClientIp(event);
  const ipAllowed = checkRateLimit(`ip:${clientIp}`, MAX_MESSAGES_PER_IP, now);
  const listingEmailAllowed = checkRateLimit(`listing-email:${listingId}:${senderEmail}`, MAX_MESSAGES_PER_LISTING_EMAIL, now);
  if (!ipAllowed || !listingEmailAllowed) {
    return json(429, { error: 'Too many messages. Please wait a bit and try again.' }, origin);
  }

  const listingResponse = await fetch(
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/listings?id=eq.${encodeURIComponent(listingId)}&select=id,title,contact_email,contact_name,status`,
    {
      headers: {
        apikey: supabaseServiceKey,
        Authorization: `Bearer ${supabaseServiceKey}`,
        Accept: 'application/json'
      }
    }
  );

  if (!listingResponse.ok) {
    return json(502, { error: 'Could not load listing.' }, origin);
  }

  const listings = await listingResponse.json();
  const listing = listings?.[0];

  if (!listing || listing.status !== 'approved') {
    return json(404, { error: 'Listing is not available.' }, origin);
  }

  if (!isEmail(listing.contact_email)) {
    return json(400, { error: 'Seller contact email is not available.' }, origin);
  }

  const subject = `Question about your Garage Hoppers listing: ${listing.title}`;
  const safeSenderName = escapeHtml(senderName);
  const safeSenderEmail = escapeHtml(senderEmail);
  const safeTitle = escapeHtml(listing.title);
  const safeMessage = escapeHtml(message);
  const text = [
    `${senderName} sent you a message about "${listing.title}" on Garage Hoppers.`,
    '',
    `Reply to: ${senderEmail}`,
    '',
    'Message:',
    message,
    '',
    `Listing: https://garagehoppers.com/#listing/${listing.id}`
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">
      <p><strong>${safeSenderName}</strong> sent you a message about <strong>${safeTitle}</strong> on Garage Hoppers.</p>
      <p><strong>Reply to:</strong> <a href="mailto:${safeSenderEmail}">${safeSenderEmail}</a></p>
      <div style="padding:12px 16px;border-left:4px solid #E8161B;background:#f9fafb;margin:16px 0;white-space:pre-wrap">${safeMessage}</div>
      <p><a href="https://garagehoppers.com/#listing/${listing.id}">View your listing</a></p>
    </div>
  `;

  const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: listing.contact_email,
      reply_to: senderEmail,
      subject,
      text,
      html
    })
  });

  if (!emailResponse.ok) {
    return json(502, { error: 'Could not send message.' }, origin);
  }

  return json(200, { ok: true }, origin);
};

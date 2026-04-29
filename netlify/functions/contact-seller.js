const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://mpgnkvpfgmqegljycedf.supabase.co';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || process.env.FROM_EMAIL;

  if (!supabaseUrl || !supabaseServiceKey || !resendApiKey || !fromEmail) {
    return json(500, { error: 'Email service is not configured.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid request body.' });
  }

  const listingId = cleanText(payload.listingId, 80);
  const senderName = cleanText(payload.name, 80) || 'A shopper';
  const senderEmail = cleanText(payload.email, 160).toLowerCase();
  const message = cleanText(payload.message, 2000);

  if (!listingId) return json(400, { error: 'Listing is required.' });
  if (!isEmail(senderEmail)) return json(400, { error: 'A valid email is required.' });
  if (message.length < 10) return json(400, { error: 'Message must be at least 10 characters.' });

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
    return json(502, { error: 'Could not load listing.' });
  }

  const listings = await listingResponse.json();
  const listing = listings?.[0];

  if (!listing || listing.status !== 'approved') {
    return json(404, { error: 'Listing is not available.' });
  }

  if (!isEmail(listing.contact_email)) {
    return json(400, { error: 'Seller contact email is not available.' });
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
    return json(502, { error: 'Could not send message.' });
  }

  return json(200, { ok: true });
};

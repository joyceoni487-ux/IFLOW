/**
 * Twilio Status Callback — receives delivery status updates for outgoing WhatsApp messages.
 * Set this as the "Status Callback URL" in Twilio Sandbox settings:
 *   https://{your-vercel-domain}.vercel.app/api/status
 *
 * Twilio POSTs these fields (application/x-www-form-urlencoded):
 *   MessageSid, MessageStatus, To, From, ErrorCode, ErrorMessage
 *
 * MessageStatus values:  queued → sent → delivered → read
 *                        or:  failed / undelivered
 */
export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Method Not Allowed');
  }

  const {
    MessageSid     = '',
    MessageStatus  = '',
    To             = '',
    From           = '',
    ErrorCode      = '',
    ErrorMessage   = ''
  } = req.body || {};

  // Log to Vercel dashboard (Functions → Logs)
  console.log(JSON.stringify({
    event: 'twilio_status',
    sid:    MessageSid,
    status: MessageStatus,
    to:     To,
    from:   From,
    error:  ErrorCode || undefined,
    msg:    ErrorMessage || undefined,
    ts:     new Date().toISOString()
  }));

  // Twilio requires a 200 response; empty TwiML is fine for status callbacks
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');
}

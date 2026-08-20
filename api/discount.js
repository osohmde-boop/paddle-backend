export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, percentage, expiresAt, usageLimit } = req.body;
  const rawKey = process.env.PADDLE_API_KEY || '';
  const PADDLE_API_KEY = rawKey.replace(/['"]/g, '').replace(/^Bearer\s+/i, '').trim();

  if (!PADDLE_API_KEY) return res.status(400).json({ error: 'مفتاح Paddle غير موجود' });

  const createDiscount = async (baseUrl) => {
    let bodyData = {
      type: "percentage",
      amount: String(percentage),
      description: `Discount ${code}`,
      code: code
    };
    if (usageLimit) bodyData.usage_limit = parseInt(usageLimit);
    if (expiresAt) bodyData.expires_at = new Date(expiresAt).toISOString();

    const response = await fetch(`${baseUrl}/discounts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PADDLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyData)
    });
    return await response.json();
  };

  try {
    let data = await createDiscount('https://api.paddle.com');
    
    if (data.error && data.error.message && data.error.message.includes('formatted')) {
      data = await createDiscount('https://sandbox-api.paddle.com');
    }

    if (data.error) return res.status(400).json({ error: data.error.detail || data.error.message });

    return res.status(200).json({ success: true, code: data.data.code, discountId: data.data.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

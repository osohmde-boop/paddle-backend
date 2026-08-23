export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, percentage, expiresAt, usageLimit } = req.body || {};
  
  const LEMONSQUEEZY_API_KEY = process.env.LEMONSQUEEZY_API_KEY || '';
  const LEMONSQUEEZY_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID || '';

  if (!LEMONSQUEEZY_API_KEY || !LEMONSQUEEZY_STORE_ID) {
    return res.status(500).json({ error: 'مفتاح Lemon Squeezy غير معرف في Vercel.' });
  }

  if (!code || !percentage) {
    return res.status(400).json({ error: 'يرجى إدخال الكود والنسبة المئوية.' });
  }

  try {
    const discountPayload = {
      data: {
        type: "discounts",
        attributes: {
          name: `كود خصم ${code}`,
          code: String(code).toUpperCase(),
          amount: Math.round(Number(percentage)),
          amount_type: "percent",
          ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
          ...(usageLimit ? { max_redemptions: parseInt(usageLimit, 10) } : {})
        },
        relationships: {
          store: {
            data: {
              type: "stores",
              id: String(LEMONSQUEEZY_STORE_ID)
            }
          }
        }
      }
    };

    const response = await fetch('https://api.lemonsqueezy.com/v1/discounts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LEMONSQUEEZY_API_KEY}`,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json'
      },
      body: JSON.stringify(discountPayload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Lemon Squeezy Discount Error:', data);
      return res.status(400).json({ 
        error: data?.errors?.[0]?.detail || data?.errors?.[0]?.title || 'فشل إنشاء كود الخصم في Lemon Squeezy.' 
      });
    }

    return res.status(200).json({
      success: true,
      code: data?.data?.attributes?.code,
      discountId: data?.data?.id
    });

  } catch (error) {
    console.error('Discount Backend Error:', error);
    return res.status(500).json({ error: error?.message || 'حدث خطأ في الخادم أثناء إنشاء الكود.' });
  }
}

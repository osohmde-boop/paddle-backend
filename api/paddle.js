export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, description, priceInCents } = req.body;
  const PADDLE_API_URL = process.env.PADDLE_API_URL || 'https://api.paddle.com';

  // تنظيف المفتاح من أي مسافات، أقواس، أو كلمة Bearer زائدة
  const rawKey = process.env.PADDLE_API_KEY || '';
  const PADDLE_API_KEY = rawKey.replace(/['"]/g, '').replace(/^Bearer\s+/i, '').trim();

  if (!PADDLE_API_KEY) {
    return res.status(400).json({ error: 'مفتاح الدفع غير موجود في Vercel. يرجى التحقق من Environment Variables.' });
  }

  try {
    const productRes = await fetch(`${PADDLE_API_URL}/products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: name,
        tax_category: "standard",
        description: description || "Product from YZ Store"
      })
    });
    const product = await productRes.json();

    if (product.error) {
       return res.status(400).json({ error: `مشكلة من Paddle: ${product.error.detail || product.error.message || 'خطأ غير معروف'}` });
    }

    const priceRes = await fetch(`${PADDLE_API_URL}/prices`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        product_id: product.data.id,
        description: `${name} - Standard price`,
        unit_price: {
          amount: String(priceInCents),
          currency_code: "USD"
        }
      })
    });
    const price = await priceRes.json();

    if (price.error) {
       return res.status(400).json({ error: `مشكلة في تسعير Paddle: ${price.error.detail || price.error.message}` });
    }

    return res.status(200).json({
      success: true,
      paddleProductId: product.data.id,
      paddlePriceId: price.data.id
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

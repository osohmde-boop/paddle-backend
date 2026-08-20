export default async function handler(req, res) {
  // السماح لمتجر YZ Store بالاتصال بالسيرفر
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
  const PADDLE_API_URL = process.env.PADDLE_API_URL || 'https://sandbox-api.paddle.com';
  const PADDLE_API_KEY = process.env.PADDLE_API_KEY;

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

    return res.status(200).json({
      success: true,
      paddleProductId: product.data.id,
      paddlePriceId: price.data.id
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const LEMONSQUEEZY_API_KEY = process.env.LEMONSQUEEZY_API_KEY || '';
  const LEMONSQUEEZY_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID || '';
  const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://osman-70f42-default-rtdb.firebaseio.com';

  if (!LEMONSQUEEZY_API_KEY || !LEMONSQUEEZY_STORE_ID) {
    return res.status(500).json({ error: 'بيانات Lemon Squeezy غير معرفة في Vercel Environment Variables.' });
  }

  const { items, customerEmail, discountCode } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'السلة فارغة.' });
  }

  const email = typeof customerEmail === 'string' ? customerEmail.trim() : '';
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'البريد الإلكتروني غير صالح.' });
  }

  try {
    const customPriceList = [];
    let detectedVariantId = null;

    for (const cartItem of items) {
      const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
      if (!productId) return res.status(400).json({ error: 'معرف المنتج غير صالح.' });

      const firebaseUrl = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/products/${encodeURIComponent(productId)}.json`;
      const firebaseResponse = await fetch(firebaseUrl, { headers: { 'Accept': 'application/json' } });
      
      if (!firebaseResponse.ok) return res.status(500).json({ error: 'تعذر قراءة بيانات المنتج من Firebase.' });
      const product = await firebaseResponse.json();

      if (!product) return res.status(404).json({ error: 'المنتج غير موجود.' });

      const title = String(product.title || '').trim();
      const price = Number(product.price);

      if (!title || !Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: `بيانات المنتج "${title}" غير صالحة.` });
      }

      // القراءة من قواعد البيانات أو استخدام الرقم الافتراضي
      if (product.variantId || product.variant_id) {
        detectedVariantId = String(product.variantId || product.variant_id);
      }

      customPriceList.push({
        name: title,
        price: Math.round(price * 100)
      });
    }

    const totalCustomPrice = customPriceList.reduce((acc, curr) => acc + curr.price, 0);

    // استخدام الرقم المكتشف أو الرقم الافتراضي 2047899
    const finalVariantId = detectedVariantId || "2047899";

    const checkoutPayload = {
      data: {
        type: "checkouts",
        attributes: {
          custom_price: totalCustomPrice,
          product_options: {
            name: customPriceList.map(i => i.name).join(' + '),
            description: "منتجات رقمية من YZ STORE",
            receipt_button_text: "عرض الطلب",
            redirect_url: "https://yzstoreonline.com"
          },
          checkout_data: {
            email: email,
            discount_code: discountCode || undefined
          }
        },
        relationships: {
          store: {
            data: {
              type: "stores",
              id: String(LEMONSQUEEZY_STORE_ID)
            }
          },
          variant: {
            data: {
              type: "variants",
              id: String(finalVariantId)
            }
          }
        }
      }
    };

    const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LEMONSQUEEZY_API_KEY}`,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json'
      },
      body: JSON.stringify(checkoutPayload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Lemon Squeezy API Error:', data);
      return res.status(400).json({ error: data?.errors?.[0]?.detail || 'فشل إنشاء عملية الدفع.' });
    }

    const checkoutUrl = data?.data?.attributes?.url;
    return res.status(200).json({ success: true, checkoutUrl });

  } catch (error) {
    console.error('Backend Error:', error);
    return res.status(500).json({ error: error?.message || 'حدث خطأ في الخادم.' });
  }
}

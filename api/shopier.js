export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'يسمح بطلبات POST فقط' });
  }

  const PAT = process.env.SHOPIER_PAT;
  const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://osman-70f42-default-rtdb.firebaseio.com';

  if (!PAT) {
    return res.status(500).json({ error: 'مفتاح Shopier (PAT) غير معرّف بإعدادات السيرفر.' });
  }

  const { items, discountCode } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'السلة فارغة.' });
  }

  try {
    // ================================================================
    // 1) حساب السعر الحقيقي من Firebase مباشرة بالسيرفر
    //    (لا نثق إطلاقاً بأي مبلغ قادم من المتصفح — نقطة أمان حرجة)
    // ================================================================
    let totalUSD = 0;
    const productNames = [];

    for (const cartItem of items) {
      const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
      if (!productId) {
        return res.status(400).json({ error: 'معرف منتج غير صالح بالسلة.' });
      }

      const firebaseUrl = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/products/${encodeURIComponent(productId)}.json`;
      const firebaseResponse = await fetch(firebaseUrl, { headers: { 'Accept': 'application/json' } });

      if (!firebaseResponse.ok) {
        return res.status(500).json({ error: 'تعذر التحقق من بيانات المنتج.' });
      }

      const product = await firebaseResponse.json();
      if (!product) {
        return res.status(404).json({ error: 'أحد المنتجات بالسلة لم يعد متوفراً.' });
      }

      const title = String(product.title || '').trim();
      const price = Number(product.price);

      if (!title || !Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: `بيانات المنتج "${title || productId}" غير صالحة.` });
      }

      const quantity = Math.max(1, Number(cartItem.quantity) || 1);
      totalUSD += price * quantity;
      productNames.push(`${title} x${quantity}`);
    }

    // ================================================================
    // 2) تطبيق كود الخصم (إن وُجد) — من السيرفر أيضاً
    // ================================================================
    if (discountCode) {
      const discountUrl = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/store_settings/discountCodes.json`;
      const discountRes = await fetch(discountUrl);
      if (discountRes.ok) {
        const discounts = await discountRes.json();
        if (discounts) {
          const codeObj = Object.values(discounts).find(
            d => String(d.code || '').toUpperCase() === String(discountCode).toUpperCase()
          );
          if (codeObj) {
            const now = new Date();
            const notExpired = !codeObj.expiresAt || new Date(codeObj.expiresAt) >= now;
            const percentage = Number(codeObj.percentage);
            if (notExpired && percentage > 0 && percentage <= 100) {
              totalUSD = totalUSD - (totalUSD * (percentage / 100));
            }
          }
        }
      }
    }

    if (!Number.isFinite(totalUSD) || totalUSD <= 0) {
      return res.status(400).json({ error: 'مجموع الطلب غير صالح.' });
    }

    // ================================================================
    // 3) تحويل المبلغ لليرة التركية (Shopier PAT REST API يتطلب TRY)
    // ================================================================
    let exchangeRate = 48; // قيمة احتياطية فقط في حال تعذّر الاتصال بمصدر السعر
    try {
      const rateRes = await fetch('https://open.er-api.com/v6/latest/USD');
      const rateData = await rateRes.json();
      if (rateData?.rates?.TRY) exchangeRate = rateData.rates.TRY;
    } catch (e) {
      console.error('Exchange rate fetch error, using fallback:', e);
    }

    const priceInTRY = Math.round(totalUSD * exchangeRate * 100) / 100;
    const orderId = `YZ-${Date.now()}`;

    // ================================================================
    // 4) إنشاء "منتج" على Shopier عبر PAT للحصول على رابط دفع
    // ================================================================
    const response = await fetch('https://api.shopier.com/v1/products', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        title: `YZ Store - ${orderId}`,
        priceData: { price: priceInTRY, currency: 'TRY' },
        quantity: 1,
        type: 'digital',
        status: 'active',
        shippingPayer: 'sellerPays',
        media: [{ url: 'https://i.ibb.co/YT1RPZdx/image.png', placement: 1, type: 'image' }]
      })
    });

    const data = await response.json();

    if (response.ok && data?.id) {
      return res.status(200).json({
        url: `https://www.shopier.com/${data.id}`,
        orderId,
        total: `$${totalUSD.toFixed(2)}`
      });
    }

    console.error('Shopier API Error:', data);
    return res.status(500).json({ error: data?.message || 'تعذر توليد رابط الدفع من Shopier.' });

  } catch (error) {
    console.error('Server Error:', error);
    return res.status(500).json({ error: 'خطأ داخلي في السيرفر.' });
  }
}

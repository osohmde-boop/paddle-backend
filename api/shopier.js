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

  const fbBase = FIREBASE_DATABASE_URL.replace(/\/$/, '');

  try {
    // ================================================================
    // 1) حساب السعر الحقيقي من Firebase مباشرة بالسيرفر
    // ================================================================
    let totalUSD = 0;

    for (const cartItem of items) {
      const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
      if (!productId) {
        return res.status(400).json({ error: 'معرف منتج غير صالح بالسلة.' });
      }

      const firebaseUrl = `${fbBase}/products/${encodeURIComponent(productId)}.json`;
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
    }

    // ================================================================
    // 2) تطبيق كود الخصم (إن وُجد)
    // ================================================================
    if (discountCode) {
      const discountUrl = `${fbBase}/store_settings/discountCodes.json`;
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
    // 3) تحويل المبلغ لليرة التركية
    // ================================================================
    let exchangeRate = 48;
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
    // 4) الحصول على منتج "الدفع" الثابت — إنشاؤه مرة واحدة فقط إن لم يكن موجوداً
    // ================================================================
    let checkoutProductId = null;

    const savedIdRes = await fetch(`${fbBase}/store_settings/checkoutProductId.json`);
    if (savedIdRes.ok) {
      const savedId = await savedIdRes.json();
      if (savedId) checkoutProductId = String(savedId);
    }

    const productPayload = {
      title: 'YZ Store - Checkout',
      priceData: { price: priceInTRY, currency: 'TRY' },
      quantity: 5000,
      type: 'digital',
      status: 'active',
      shippingPayer: 'sellerPays',
      media: [{ url: 'https://i.ibb.co/YT1RPZdx/image.png', placement: 1, type: 'image' }]
    };

    let shopierData;

    if (checkoutProductId) {
      // منتج موجود مسبقاً — فقط نحدّث سعره ليطابق الطلب الحالي
      const updateRes = await fetch(`https://api.shopier.com/v1/products/${checkoutProductId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${PAT}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(productPayload)
      });
      shopierData = await updateRes.json();

      if (!updateRes.ok) {
        console.error('Shopier update error, will try creating a new one:', shopierData);
        checkoutProductId = null; // نتراجع وننشئ واحد جديد بالأسفل
      }
    }

    if (!checkoutProductId) {
      // أول مرة إطلاقاً — ننشئ المنتج الثابت مرة واحدة فقط
      const createRes = await fetch('https://api.shopier.com/v1/products', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PAT}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(productPayload)
      });
      shopierData = await createRes.json();

      if (!createRes.ok || !shopierData?.id) {
        console.error('Shopier create error:', shopierData);
        return res.status(500).json({ error: shopierData?.message || 'تعذر توليد رابط الدفع من Shopier.' });
      }

      checkoutProductId = String(shopierData.id);

      // نحفظ الرقم بقاعدة البيانات عشان كل عملية دفع قادمة تستخدم نفس المنتج
      await fetch(`${fbBase}/store_settings/checkoutProductId.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(checkoutProductId)
      });
    }

    return res.status(200).json({
      url: `https://www.shopier.com/${checkoutProductId}`,
      orderId,
      total: `$${totalUSD.toFixed(2)}`
    });

  } catch (error) {
    console.error('Server Error:', error);
    return res.status(500).json({ error: 'خطأ داخلي في السيرفر.' });
  }
}

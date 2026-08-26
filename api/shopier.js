import { ShopierApiClient, ShopierPaymentFlow } from '@nopeion/shopier';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'يسمح بطلبات POST فقط' });
  }

  // 🔴 مفتاح PAT الخاص بك تم إدراجه هنا مباشرة
  const PAT = process.env.SHOPIER_PAT || 'a546ad5b6351f8a39496c8ecbfa2edd44dfb08fa1fe25f38531662c9ecc086dd';
  const SHOP_SLUG = process.env.SHOPIER_SHOP_SLUG || 'yzstore0';
  const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://osman-70f42-default-rtdb.firebaseio.com';

  const { items, discountCode } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'السلة فارغة.' });
  }

  const fbBase = FIREBASE_DATABASE_URL.replace(/\/$/, '');

  try {
    // 1) البحث عن منتج موجود أو إنشاء منتج جديد لمرة واحدة
    let checkoutProductId = process.env.SHOPIER_CHECKOUT_PRODUCT_ID;

    if (!checkoutProductId) {
      try {
        const listRes = await fetch('https://api.shopier.com/v1/products?limit=1', {
          headers: { 'Authorization': `Bearer ${PAT}`, 'Accept': 'application/json' }
        });
        
        if (listRes.ok) {
          const productsList = await listRes.json();
          if (Array.isArray(productsList) && productsList.length > 0) {
            checkoutProductId = productsList[0].id;
          }
        }
      } catch (e) {}
    }

    if (!checkoutProductId) {
      const createDummyRes = await fetch('https://api.shopier.com/v1/products', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PAT}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          title: 'YZ Store Order',
          type: 'digital',
          priceData: { price: 10, currency: 'TRY' },
          stockQuantity: 999999
        })
      });

      if (createDummyRes.ok) {
        const dummyData = await createDummyRes.json();
        checkoutProductId = dummyData.id;
      } else {
        return res.status(500).json({ error: 'تعذر الاتصال بـ Shopier لإنشاء المنتج.' });
      }
    }

    // 2) حساب المجموع من Firebase
    let totalUSD = 0;
    for (const cartItem of items) {
      const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
      if (!productId) return res.status(400).json({ error: 'معرف منتج غير صالح.' });

      const r = await fetch(`${fbBase}/products/${encodeURIComponent(productId)}.json`);
      if (!r.ok) return res.status(502).json({ error: 'تعذر التحقق من بيانات المنتج.' });

      const product = await r.json().catch(() => null);
      if (!product) return res.status(404).json({ error: `المنتج لم يعد متوفراً.` });

      const price = Number(product.price);
      const quantity = Math.max(1, Math.floor(Number(cartItem.quantity)) || 1);
      totalUSD += price * quantity;
    }

    // 3) كود الخصم
    if (discountCode) {
      try {
        const dr = await fetch(`${fbBase}/store_settings/discountCodes.json`);
        if (dr.ok) {
          const discounts = await dr.json();
          if (discounts) {
            const codeObj = Object.values(discounts).find(
              d => String(d?.code || '').toUpperCase() === String(discountCode).toUpperCase()
            );
            if (codeObj) {
              const now = new Date();
              const notExpired = !codeObj.expiresAt || new Date(codeObj.expiresAt) >= now;
              const percentage = Number(codeObj.percentage);
              if (notExpired && percentage > 0 && percentage <= 100) {
                totalUSD -= totalUSD * (percentage / 100);
              }
            }
          }
        }
      } catch (e) {}
    }

    // 4) سعر الصرف
    let exchangeRate = 48;
    try {
      const rr = await fetch('https://open.er-api.com/v6/latest/USD');
      const rd = await rr.json();
      if (rd?.rates?.TRY) exchangeRate = rd.rates.TRY;
    } catch (e) {}

    const priceInTRY = Math.round(totalUSD * exchangeRate * 100) / 100;
    const orderId = `YZ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // 5) تحديث سعر المنتج الثابت
    await fetch(`https://api.shopier.com/v1/products/${checkoutProductId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        priceData: { price: priceInTRY, currency: 'TRY' }
      })
    });

    // 6) بناء صفحة الدفع
    const client = new ShopierApiClient({ pat: PAT });
    const payments = new ShopierPaymentFlow({ client });

    const checkoutHtml = payments.buildHostedCheckoutHtml({
      productId: checkoutProductId,
      shopSlug: SHOP_SLUG,
      orderId
    });

    return res.status(200).json({ checkoutHtml, orderId, total: `$${totalUSD.toFixed(2)}` });

  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Server Error' });
  }
}

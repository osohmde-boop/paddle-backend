import { ShopierApiClient, ShopierPaymentFlow } from '@nopeion/shopier';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'يسمح بطلبات POST فقط' });
  }

  const PAT = process.env.SHOPIER_PAT;
  const SHOP_SLUG = process.env.SHOPIER_SHOP_SLUG || 'yzstore0';
  const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://osman-70f42-default-rtdb.firebaseio.com';

  if (!PAT) return res.status(500).json({ error: 'مفتاح Shopier (PAT) غير معرّف.' });

  const { items, discountCode } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'السلة فارغة.' });
  }

  const fbBase = FIREBASE_DATABASE_URL.replace(/\/$/, '');

  try {
    // 1) حساب السعر الحقيقي من Firebase مباشرة بالسيرفر
    let totalUSD = 0;
    for (const cartItem of items) {
      const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
      if (!productId) return res.status(400).json({ error: 'معرف منتج غير صالح.' });

      const r = await fetch(`${fbBase}/products/${encodeURIComponent(productId)}.json`);
      if (!r.ok) return res.status(500).json({ error: 'تعذر التحقق من بيانات المنتج.' });
      const product = await r.json();
      if (!product) return res.status(404).json({ error: 'أحد المنتجات لم يعد متوفراً.' });

      const price = Number(product.price);
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: 'بيانات منتج غير صالحة.' });
      }
      const quantity = Math.max(1, Number(cartItem.quantity) || 1);
      totalUSD += price * quantity;
    }

    // 2) كود الخصم
    if (discountCode) {
      const dr = await fetch(`${fbBase}/store_settings/discountCodes.json`);
      if (dr.ok) {
        const discounts = await dr.json();
        if (discounts) {
          const codeObj = Object.values(discounts).find(
            d => String(d.code || '').toUpperCase() === String(discountCode).toUpperCase()
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
    }

    if (!Number.isFinite(totalUSD) || totalUSD <= 0) {
      return res.status(400).json({ error: 'مجموع الطلب غير صالح.' });
    }

    // 3) تحويل لليرة التركية
    let exchangeRate = 48;
    try {
      const rr = await fetch('https://open.er-api.com/v6/latest/USD');
      const rd = await rr.json();
      if (rd?.rates?.TRY) exchangeRate = rd.rates.TRY;
    } catch (e) {}

    const priceInTRY = (Math.round(totalUSD * exchangeRate * 100) / 100).toFixed(2);
    const orderId = `YZ-${Date.now()}`;

    // 4) إنشاء رابط دفع مباشر (Hosted Checkout) — يتخطى صفحة المنتج بالكامل
    const client = new ShopierApiClient({ pat: PAT });
    const payments = new ShopierPaymentFlow({ client });

    const payment = await payments.createPaymentLink({
      title: `YZ Store - ${orderId}`,
      amount: priceInTRY,
      currency: 'TRY',
      imageUrl: 'https://i.ibb.co/YT1RPZdx/image.png',
      orderId,
      hostedCheckout: true,
      shopSlug: SHOP_SLUG,
      quantity: 10
    });

    if (!payment?.checkoutHtml) {
      // نرجع الكائن كامل عشان نشوف الأسماء الحقيقية للحقول ونصلح فوراً
      return res.status(500).json({
        error: 'checkoutHtml غير موجود بالرد. البيانات الكاملة: ' + JSON.stringify(payment)
      });
    }

    return res.status(200).json({
      checkoutHtml: payment.checkoutHtml,
      orderId,
      total: `$${totalUSD.toFixed(2)}`
    });

  } catch (error) {
    console.error('Server Error:', error);
    return res.status(500).json({ error: (error?.message || 'unknown') + ' | ' + (error?.stack || '') });
  }
}

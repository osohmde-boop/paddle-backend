// ملف تشخيص مؤقت — لمعرفة الشكل الحقيقي لرد Shopier فقط
// احذفه بعد ما نخلص من التشخيص

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const PAT = process.env.SHOPIER_PAT;
  const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://osman-70f42-default-rtdb.firebaseio.com';

  if (!PAT) {
    return res.status(500).json({ error: 'مفتاح Shopier غير معرّف' });
  }

  try {
    // نجيب رقم المنتج الثابت المحفوظ عندنا
    const fbBase = FIREBASE_DATABASE_URL.replace(/\/$/, '');
    const savedIdRes = await fetch(`${fbBase}/store_settings/checkoutProductId.json`);
    const checkoutProductId = savedIdRes.ok ? await savedIdRes.json() : null;

    // نجرب نجيب تفاصيل هاد المنتج تحديداً من Shopier (GET)
    let productDetail = null;
    if (checkoutProductId) {
      const getRes = await fetch(`https://api.shopier.com/v1/products/${checkoutProductId}`, {
        headers: { 'Authorization': `Bearer ${PAT}`, 'Accept': 'application/json' }
      });
      productDetail = {
        status: getRes.status,
        ok: getRes.ok,
        body: await getRes.json().catch(() => null)
      };
    }

    // كمان نجرب نعمل تحديث تجريبي بسيط ونشوف شو بيرجع بالضبط
    let updateAttempt = null;
    if (checkoutProductId) {
      const testUpdateRes = await fetch(`https://api.shopier.com/v1/products/${checkoutProductId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${PAT}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          title: 'YZ Store - Checkout',
          priceData: { price: 50, currency: 'TRY' },
          quantity: 5000,
          type: 'digital',
          status: 'active',
          shippingPayer: 'sellerPays'
        })
      });
      updateAttempt = {
        status: testUpdateRes.status,
        ok: testUpdateRes.ok,
        body: await testUpdateRes.json().catch(() => null)
      };
    }

    return res.status(200).json({
      savedCheckoutProductId: checkoutProductId,
      currentProductDetail: productDetail,
      testUpdateAttempt: updateAttempt
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

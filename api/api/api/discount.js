import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SHOPIER_API_KEY = process.env.SHOPIER_API_KEY || '';
  const SHOPIER_API_SECRET = process.env.SHOPIER_API_SECRET || '';
  const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://osman-70f42-default-rtdb.firebaseio.com';

  if (!SHOPIER_API_KEY || !SHOPIER_API_SECRET) {
    return res.status(500).json({ error: 'مفاتيح Shopier غير معرفة.' });
  }

  const { items, customerEmail, customerName, customerPhone, discountCode } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'السلة فارغة.' });
  }

  const email = typeof customerEmail === 'string' ? customerEmail.trim() : 'customer@yzstoreonline.com';
  const name = customerName || 'YZ_Customer';
  const phone = customerPhone || '05000000000';

  try {
    let totalPrice = 0;
    const productNames = [];

    // 1. حساب السعر الأصلي للمنتجات من Firebase
    for (const cartItem of items) {
      const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
      if (!productId) return res.status(400).json({ error: 'معرف المنتج غير صالح.' });

      const firebaseUrl = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/products/${encodeURIComponent(productId)}.json`;
      const firebaseResponse = await fetch(firebaseUrl, { headers: { 'Accept': 'application/json' } });
      
      if (!firebaseResponse.ok) return res.status(500).json({ error: 'تعذر قراءة بيانات المنتج.' });
      const product = await firebaseResponse.json();

      if (!product) return res.status(404).json({ error: 'المنتج غير موجود.' });

      const title = String(product.title || '').trim();
      const price = Number(product.price);

      if (!title || !Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: `بيانات المنتج "${title}" غير صالحة.` });
      }

      const quantity = Number(cartItem.quantity) || 1;
      totalPrice += (price * quantity);
      productNames.push(`${title} (x${quantity})`);
    }

    // 2. تطبيق كود الخصم (إن وجد) عبر التحقق منه من Firebase
    let finalPrice = totalPrice;
    if (discountCode) {
      const discountUrl = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/store_settings/discountCodes.json`;
      const discountRes = await fetch(discountUrl);
      if (discountRes.ok) {
        const discounts = await discountRes.json();
        if (discounts) {
          // البحث عن الكود المطابق
          const codeObj = Object.values(discounts).find(d => d.code === discountCode.toUpperCase());
          if (codeObj) {
            // التحقق من تاريخ الصلاحية
            const now = new Date();
            if (!codeObj.expiresAt || new Date(codeObj.expiresAt) >= now) {
               const percentage = Number(codeObj.percentage);
               if (percentage > 0 && percentage <= 100) {
                 finalPrice = finalPrice - (finalPrice * (percentage / 100));
               }
            }
          }
        }
      }
    }

    // Shopier قد ترفض العمليات التي تقل عن 1 دولار، نضمن الحد الأدنى هنا
    if (finalPrice < 1) {
        finalPrice = 1; 
    }

    // 3. تجهيز بيانات الدفع وتشفيرها لـ Shopier
    const totalOrderValue = finalPrice.toFixed(2); // السعر النهائي بعد الخصم
    const currency = '1'; // 1 = USD (دولار)
    const randomNr = Math.floor(Math.random() * 900000) + 100000;
    const platformOrderId = `YZ-${Date.now()}`; 
    
    const dataString = randomNr.toString() + platformOrderId + totalOrderValue + currency;
    const signature = crypto.createHmac('sha256', SHOPIER_API_SECRET).update(dataString).digest('base64');

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head><title>Redirecting to Secure Payment...</title></head>
      <body style="background-color: #070709; color: #fff; text-align: center; padding-top: 50px; font-family: sans-serif;">
        <h3>جاري توجيهك لبوابة الدفع الآمنة...</h3>
        <form id="shopier_form" method="post" action="https://www.shopier.com/ShowProduct/api_pay4.php">
          <input type="hidden" name="API_key" value="${SHOPIER_API_KEY}">
          <input type="hidden" name="website_index" value="1">
          <input type="hidden" name="platform_order_id" value="${platformOrderId}">
          <input type="hidden" name="product_name" value="${productNames.join(' + ')}">
          <input type="hidden" name="product_type" value="1"> 
          <input type="hidden" name="buyer_name" value="${name}">
          <input type="hidden" name="buyer_surname" value="Customer">
          <input type="hidden" name="buyer_email" value="${email}">
          <input type="hidden" name="buyer_account_age" value="0">
          <input type="hidden" name="buyer_id_nr" value="0">
          <input type="hidden" name="buyer_phone" value="${phone}">
          
          <input type="hidden" name="billing_address" value="YZ Store Digital Delivery">
          <input type="hidden" name="billing_city" value="Istanbul">
          <input type="hidden" name="billing_country" value="Turkey">
          <input type="hidden" name="billing_postcode" value="34000">
          <input type="hidden" name="shipping_address" value="YZ Store Digital Delivery">
          <input type="hidden" name="shipping_city" value="Istanbul">
          <input type="hidden" name="shipping_country" value="Turkey">
          <input type="hidden" name="shipping_postcode" value="34000">
          
          <input type="hidden" name="total_order_value" value="${totalOrderValue}">
          <input type="hidden" name="currency" value="${currency}">
          <input type="hidden" name="platform" value="0">
          <input type="hidden" name="is_in_frame" value="0">
          <input type="hidden" name="current_language" value="1">
          <input type="hidden" name="modul_version" value="1.0.4">
          <input type="hidden" name="random_nr" value="${randomNr}">
          <input type="hidden" name="signature" value="${signature}">
        </form>
        <script>
          document.getElementById('shopier_form').submit();
        </script>
      </body>
      </html>
    `;

    return res.status(200).json({ htmlContent });

  } catch (error) {
    console.error('Shopier Backend Error:', error);
    return res.status(500).json({ error: error?.message || 'حدث خطأ في خادم الدفع.' });
  }
}

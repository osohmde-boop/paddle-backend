// نقطة الدفع الخلفية (Serverless Function) لـ Shopier.
// يجب نشر هذا المسار على منصة تدعم Serverless/Edge Functions (مثل Vercel أو Netlify) —
// GitHub Pages لا يستطيع تشغيل هذا الملف لأنه استضافة ثابتة (static hosting) فقط.
//
// المتغيرات البيئية المطلوبة (تُضبط من إعدادات المشروع بالمنصة، وليس هنا بالكود):
//   SHOPIER_PAT        - مفتاح Shopier السري (Personal Access Token)
//   SHOPIER_SHOP_SLUG   - معرف المتجر بشوبير
//   FIREBASE_DATABASE_URL - رابط Firebase Realtime Database (اختياري، له قيمة افتراضية أدناه)
//
// ⚠️ لا تضع أي مفتاح سري كقيمة افتراضية بالكود أبداً — المستودع عام (public)،
// وأي مفتاح يوضع هنا كنص ثابت يصبح مرئياً لأي شخص يفتح المستودع على GitHub.

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
    const SHOP_SLUG = process.env.SHOPIER_SHOP_SLUG;
    const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://osman-70f42-default-rtdb.firebaseio.com';

    if (!PAT || !SHOP_SLUG) {
        // فشل واضح بدل الرجوع لقيمة افتراضية غير آمنة
        console.error('SHOPIER_PAT أو SHOPIER_SHOP_SLUG غير مضبوطين في متغيرات البيئة.');
        return res.status(500).json({ error: 'إعداد الدفع غير مكتمل على السيرفر. تواصل مع الدعم.' });
    }

    const { items, discountCode } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'السلة فارغة.' });
    }

    const fbBase = FIREBASE_DATABASE_URL.replace(/\/$/, '');

    try {
        // 1) حساب المجموع من Firebase مباشرة (لا نثق بأي سعر يصل من المتصفح)
        let totalUSD = 0;
        for (const cartItem of items) {
            const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
            if (!productId) return res.status(400).json({ error: 'معرف منتج غير صالح.' });

            const r = await fetch(`${fbBase}/products/${encodeURIComponent(productId)}.json`);
            if (!r.ok) return res.status(502).json({ error: 'تعذر التحقق من بيانات المنتج.' });

            const product = await r.json().catch(() => null);
            if (!product) return res.status(404).json({ error: 'المنتج لم يعد متوفراً.' });

            const price = Number(product.price);
            if (!Number.isFinite(price) || price < 0) {
                return res.status(500).json({ error: 'بيانات سعر المنتج غير صالحة.' });
            }

            const quantity = Math.max(1, Math.floor(Number(cartItem.quantity)) || 1);
            totalUSD += price * quantity;
        }

        // 2) كود الخصم (اختياري)
        if (discountCode) {
            try {
                const dr = await fetch(`${fbBase}/store_settings/discountCodes.json`);
                if (dr.ok) {
                    const discounts = await dr.json();
                    if (discounts) {
                        const codeObj = Object.values(discounts).find(
                            (d) => String(d?.code || '').toUpperCase() === String(discountCode).toUpperCase()
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
            } catch (e) {
                console.error('discount code lookup failed:', e);
            }
        }

        if (totalUSD <= 0) {
            return res.status(400).json({ error: 'قيمة الطلب غير صالحة.' });
        }

        // 3) سعر الصرف USD -> TRY (شوبير يستقبل الدفع بالليرة التركية)
        let exchangeRate = 48; // قيمة احتياطية تقريبية إذا فشل جلب السعر الحي — يُستحسن مراجعتها دورياً
        try {
            const rr = await fetch('https://open.er-api.com/v6/latest/USD');
            if (rr.ok) {
                const rd = await rr.json();
                if (rd?.rates?.TRY) exchangeRate = rd.rates.TRY;
            }
        } catch (e) {
            console.error('exchange rate fetch failed, using fallback:', e);
        }

        const priceInTRY = Math.round(totalUSD * exchangeRate * 100) / 100;
        const orderId = `YZ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        // 4) إنشاء رابط/نموذج الدفع عبر Shopier
        const client = new ShopierApiClient({ pat: PAT });
        // شوبيير يطلب صورة (imageUrl أو media) إلزاميًا لأي رابط دفع منتج — نستخدم شعار المتجر كصورة افتراضية
        // بما إن الطلب الواحد ممكن يحتوي أكثر من منتج بصور مختلفة (فاتورة موحّدة وليست منتج واحد بعينه)
        const payments = new ShopierPaymentFlow({
            client,
            defaultImageUrl: 'https://i.ibb.co/YT1RPZdx/image.png',
        });

        const payment = await payments.createPaymentLink({
            title: `YZ Store Order ${orderId}`,
            amount: priceInTRY.toFixed(2),
            currency: 'TRY',
            orderId,
            hostedCheckout: true,
            shopSlug: SHOP_SLUG,
        });

        return res.status(200).json({
            checkoutHtml: payment.checkoutHtml,
            orderId,
            total: `$${totalUSD.toFixed(2)}`,
        });
    } catch (error) {
        console.error('shopier checkout error:', error);
        return res.status(500).json({ error: error?.message || 'خطأ غير متوقع بالسيرفر.' });
    }
}

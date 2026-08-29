// نقطة الدفع الخلفية لـ Whop عبر Vercel
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'يسمح بطلبات POST فقط' });
    }

    const WHOP_API_KEY = process.env.WHOP_API_KEY;
    const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://osman-70f42-default-rtdb.firebaseio.com';

    if (!WHOP_API_KEY) {
        console.error('WHOP_API_KEY مفقود في متغيرات البيئة.');
        return res.status(500).json({ error: 'إعداد المفتاح السري لـ Whop مفقود في السيرفر.' });
    }

    const { items, discountCode } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'السلة فارغة.' });
    }

    const fbBase = FIREBASE_DATABASE_URL.replace(/\/$/, '');

    try {
        // 1) حساب إجمالي السعر بالدولار من داتابيز Firebase بموقعك
        let totalUSD = 0;

        for (const cartItem of items) {
            const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
            if (!productId) continue;

            const r = await fetch(`${fbBase}/products/${encodeURIComponent(productId)}.json`);
            if (r.ok) {
                const product = await r.json().catch(() => null);
                if (product) {
                    const price = Number(product.price) || 0;
                    const quantity = Math.max(1, Math.floor(Number(cartItem.quantity)) || 1);
                    totalUSD += price * quantity;
                }
            }
        }

        // 2) تطبيق الخصم
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
                console.error('فشل كود الخصم:', e);
            }
        }

        if (totalUSD <= 0) {
            return res.status(400).json({ error: 'قيمة الطلب غير صالحة.' });
        }

        const orderId = `YZ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        // 3) إنشاء رابط الدفع الديناميكي من Whop API مباشرة
        const whopRes = await fetch('https://api.whop.com/api/v5/checkouts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHOP_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                plan_id: 'plan_54-e3', // الخطة الأساسية للمتجر
                custom_price: Math.round(totalUSD * 100), // السعر الإجمالي بالسنتمات Cents
                metadata: {
                    order_id: orderId
                }
            })
        });

        const whopData = await whopRes.json();

        if (!whopRes.ok || (!whopData.url && !whopData.purchase_url)) {
            console.error('Whop API Error:', whopData);
            // توجيه احتياطي للرابط الأساسي للمنتج في حال حدوث أي خطأ في API
            return res.status(200).json({
                checkoutUrl: 'https://whop.com/yzstoreonline/54-e3/',
                orderId: orderId,
                total: `$${totalUSD.toFixed(2)}`
            });
        }

        return res.status(200).json({
            checkoutUrl: whopData.url || whopData.purchase_url,
            orderId: orderId,
            total: `$${totalUSD.toFixed(2)}`
        });

    } catch (error) {
        console.error('Whop Processing Error:', error);
        return res.status(500).json({ error: error?.message || 'خطأ غير متوقع في السيرفر.' });
    }
}

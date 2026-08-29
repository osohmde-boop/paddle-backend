export default async function handler(req, res) {
    // إعدادات CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'يسمح بطلبات POST فقط' });
    }

    const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://osman-70f42-default-rtdb.firebaseio.com';
    const fbBase = FIREBASE_DATABASE_URL.replace(/\/$/, '');

    try {
        const { items, discountCode } = req.body || {};
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'السلة فارغة.' });
        }

        // 1) حساب المجموع الكلي من داتابيز موقعك
        let totalUSD = 0;
        let checkoutUrl = "https://whop.com/yzstoreonline/54-e3/"; // الرابط المباشر الافتراضي

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

                    if (product.whopUrl) {
                        checkoutUrl = product.whopUrl;
                    }
                }
            }
        }

        // 2) حساب الخصم
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
                console.error('فشل الخصم:', e);
            }
        }

        const orderId = `YZ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        // 3) محاولة الاتصال بـ Whop API مع حماية كاملة (إذا فشل الـ API يحول مباشرة للرابط المباشر)
        const WHOP_API_KEY = process.env.WHOP_API_KEY;
        if (WHOP_API_KEY) {
            try {
                const whopRes = await fetch('https://api.whop.com/api/v5/checkouts', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${WHOP_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        plan_id: 'plan_54-e3',
                        custom_price: Math.round(totalUSD * 100),
                        metadata: { order_id: orderId }
                    })
                });

                if (whopRes.ok) {
                    const whopData = await whopRes.json().catch(() => null);
                    if (whopData && (whopData.url || whopData.purchase_url)) {
                        checkoutUrl = whopData.url || whopData.purchase_url;
                    }
                }
            } catch (apiErr) {
                console.error('Whop API Error handled gracefully:', apiErr);
            }
        }

        // إرجاع رد JSON سليم ومضمن 100%
        return res.status(200).json({
            checkoutUrl: checkoutUrl,
            orderId: orderId,
            total: `$${totalUSD.toFixed(2)}`
        });

    } catch (globalError) {
        console.error('Global Server Error:', globalError);
        // حتى لو حدث خطأ غير متوقع، نُرجع JSON مفصل بدلاً من HTML
        return res.status(200).json({
            checkoutUrl: "https://whop.com/yzstoreonline/54-e3/",
            orderId: `YZ-FALLBACK-${Date.now()}`,
            total: "$0.00"
        });
    }
}

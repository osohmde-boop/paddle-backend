// نقطة الدفع الخلفية لـ Whop بأسعار أوتوماتيكية ومخصصة
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
        console.error('WHOP_API_KEY غير مضبوط في متغيرات البيئة في Vercel.');
        return res.status(500).json({ error: 'مفتاح Whop API مفقود في السيرفر.' });
    }

    const { items, discountCode } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'السلة فارغة.' });
    }

    const fbBase = FIREBASE_DATABASE_URL.replace(/\/$/, '');

    try {
        // 1) حساب المجموع النهائي بناءً على أسعار Firebase في موقعك
        let totalUSD = 0;
        let mainPlanId = null;

        for (const cartItem of items) {
            const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
            if (!productId) continue;

            const r = await fetch(`${fbBase}/products/${encodeURIComponent(productId)}.json`);
            if (r.ok) {
                const product = await r.json().catch(() => null);
                if (product) {
                    if (!mainPlanId && product.whopPlanId) {
                        mainPlanId = product.whopPlanId;
                    }

                    const price = Number(product.price);
                    if (Number.isFinite(price) && price >= 0) {
                        const quantity = Math.max(1, Math.floor(Number(cartItem.quantity)) || 1);
                        totalUSD += price * quantity;
                    }
                }
            }
        }

        // 2) تطبيق كود الخصم من داتابيز الموقع
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

        if (totalUSD <= 0) {
            return res.status(400).json({ error: 'قيمة الطلب غير صالحة.' });
        }

        const orderId = `YZ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        // 3) تجهيز طلب السعر المخصص وإرساله لـ Whop API
        // إذا كان هناك Plan ID سيستخدمه، وإلا سيتم تمرير الخطة السريعة plan_54-e3 التي أرسلتها
        const targetPlanId = mainPlanId || '54-e3';

        const whopPayload = {
            plan_id: targetPlanId.startsWith('plan_') ? targetPlanId : `plan_${targetPlanId}`,
            custom_amount: Math.round(totalUSD * 100) / 100, // السعر الدقيق المحسوب من الموقع بالـ $
            redirect_url: 'https://yzstoreonline.com/',
            metadata: {
                order_id: orderId
            }
        };

        const whopRes = await fetch('https://api.whop.com/api/v5/checkout_configurations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHOP_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(whopPayload)
        });

        const whopData = await whopRes.json();

        // 4) العودة بالرابط الديناميكي
        let checkoutUrl = whopData.purchase_url || whopData.url;

        if (!checkoutUrl && whopData.id) {
            checkoutUrl = `https://whop.com/checkout/${whopData.id}`;
        }

        // تحويل احتياطي مباشر في حال الرد البسيط
        if (!checkoutUrl) {
            checkoutUrl = `https://whop.com/yzstoreonline/54-e3/`;
        }

        return res.status(200).json({
            checkoutUrl: checkoutUrl,
            orderId: orderId,
            total: `$${totalUSD.toFixed(2)}`
        });

    } catch (error) {
        console.error('Whop Dynamic Checkout Error:', error);
        return res.status(500).json({ error: error?.message || 'خطأ غير متوقع بالسيرفر.' });
    }
}

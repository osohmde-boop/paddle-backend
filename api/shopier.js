// نقطة الدفع الخلفية (Serverless Function) لـ Whop عبر Vercel
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
        console.error('WHOP_API_KEY غير مضبوط في متغيرات البيئة.');
        return res.status(500).json({ error: 'إعداد الدفع غير مكتمل على السيرفر (مفتاح Whop مفقود).' });
    }

    const { items, discountCode } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'السلة فارغة.' });
    }

    const fbBase = FIREBASE_DATABASE_URL.replace(/\/$/, '');

    try {
        // 1) جلب بيانات المنتج وحساب الإجمالي من Firebase
        let totalUSD = 0;
        let mainPlanId = null;

        for (const cartItem of items) {
            const productId = typeof cartItem?.productId === 'string' ? cartItem.productId.trim() : '';
            if (!productId) return res.status(400).json({ error: 'معرف منتج غير صالح.' });

            const r = await fetch(`${fbBase}/products/${encodeURIComponent(productId)}.json`);
            if (!r.ok) return res.status(502).json({ error: 'تعذر التحقق من بيانات المنتج.' });

            const product = await r.json().catch(() => null);
            if (!product) return res.status(404).json({ error: 'المنتج لم يعد متوفراً.' });

            if (!mainPlanId && product.whopPlanId) {
                mainPlanId = product.whopPlanId;
            }

            const price = Number(product.price);
            if (!Number.isFinite(price) || price < 0) {
                return res.status(500).json({ error: 'بيانات سعر المنتج غير صالحة.' });
            }

            const quantity = Math.max(1, Math.floor(Number(cartItem.quantity)) || 1);
            totalUSD += price * quantity;
        }

        // 2) تطبيق كود الخصم (إن وجد)
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
                console.error('فشل التحقق من كود الخصم:', e);
            }
        }

        if (totalUSD <= 0) {
            return res.status(400).json({ error: 'قيمة الطلب غير صالحة.' });
        }

        const orderId = `YZ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        // 3) التواصل مع API الخاص بـ Whop لإنشاء إعداد الدفع (Checkout Configuration)
        const whopPayload = {
            plan: mainPlanId ? { id: mainPlanId } : {
                initial_price: totalUSD,
                plan_type: "one_time"
            },
            metadata: {
                order_id: orderId
            }
        };

        const whopRes = await fetch('https://api.whop.com/api/v1/checkout_configurations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHOP_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(whopPayload)
        });

        const whopData = await whopRes.json();

        if (!whopRes.ok) {
            console.error('Whop API Error:', whopData);
            return res.status(500).json({ error: whopData.message || 'فشل التنسيق مع بوابة Whop.' });
        }

        // رابط التوجه لصفحة دفع Whop
        const checkoutUrl = whopData.purchase_url || whopData.url || `https://whop.com/checkout/${whopData.id}`;

        return res.status(200).json({
            checkoutUrl,
            orderId,
            total: `$${totalUSD.toFixed(2)}`
        });

    } catch (error) {
        console.error('Whop Checkout Error:', error);
        return res.status(500).json({ error: error?.message || 'خطأ غير متوقع بالسيرفر.' });
    }
}

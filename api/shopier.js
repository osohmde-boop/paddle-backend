export default async function handler(req, res) {
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

        let totalUSD = 0;
        let checkoutUrl = "https://whop.com/yzstoreonline/54-e3/"; // رابط Whop المباشر الخاص بك

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

        // كود الخصم
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

        // إرجاع استجابة JSON سليمة دائماً
        return res.status(200).json({
            checkoutUrl: checkoutUrl,
            orderId: orderId,
            total: `$${totalUSD.toFixed(2)}`
        });

    } catch (error) {
        console.error('Server Error:', error);
        return res.status(500).json({ error: 'حدث خطأ في السيرفر' });
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { totalAmount, orderId } = req.body;
        const shopierPat = process.env.SHOPIER_PAT;

        if (!shopierPat) {
            return res.status(500).json({ error: 'Shopier PAT is not configured' });
        }

        // سعر الصرف أو قيمة المبلغ بالليرة التركية
        const exchangeRate = 36; 
        const totalTry = (totalAmount * exchangeRate).toFixed(2);

        // إرسال طلب إنشاء رابط دفع خاص بالمنتج/السعر المحدد عبر شوبير API
        const shopierRes = await fetch('https://www.shopier.com/api/v1/checkout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${shopierPat}`
            },
            body: JSON.stringify({
                order_id: orderId,
                total_order_value: totalTry,
                currency: 'TRY'
            })
        });

        const data = await shopierRes.json();

        if (shopierRes.ok && data.payment_url) {
            return res.status(200).json({ url: data.payment_url });
        } else {
            throw new Error(data.message || 'فشل توليد رابط الدفع من شوبير');
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}

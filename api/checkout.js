export default async function handler(req, res) {
    // السماح بطلب POST فقط
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    try {
        const { totalAmount, orderId } = req.body;
        const shopierPat = process.env.SHOPIER_PAT;

        if (!shopierPat) {
            return res.status(500).json({ error: 'Shopier PAT is not configured in environment variables' });
        }

        // سعر الصرف وحساب المبلغ بالليرة التركية
        const exchangeRate = 36;
        const totalTry = (Number(totalAmount) * exchangeRate).toFixed(2);

        // إرسال الطلب إلى شوبير لإنشاء رابط دفع خاص بالمنتج/السعر المحدد
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

        if (shopierRes.ok && (data.payment_url || data.url)) {
            return res.status(200).json({ url: data.payment_url || data.url });
        } else {
            throw new Error(data.message || data.error || 'فشل توليد رابط الدفع من شوبير');
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}

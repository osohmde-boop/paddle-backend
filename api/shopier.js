export default async function handler(req, res) {
  // ترويسات السماح بالاتصال من أي موقع (CORS) لحل مشكلة Failed to fetch
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // السماح بطلبات POST فقط
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'يسمح بطلبات POST فقط' });
  }

  // استلام إجمالي السلة ورقم الطلب من واجهة متجرك
  const { totalAmount, orderId } = req.body;
  const PAT = process.env.SHOPIER_PAT;

  try {
    // إرسال طلب لإنشاء منتج مجمع في Shopier
    const response = await fetch('https://api.shopier.com/v1/products', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        title: `YZ Store Siparişi - ${orderId}`,
        price: totalAmount,
        currency: 'TRY',
        stock: 1,
        type: 'digital'
      })
    });

    const data = await response.json();

    // إذا تم إنشاء المنتج بنجاح، سيقوم بإرجاع الـ ID الخاص به
    if (response.ok && data.id) {
      const checkoutUrl = `https://www.shopier.com/${data.id}`;
      return res.status(200).json({ url: checkoutUrl });
    } else {
      console.error("Shopier API Error:", data);
      return res.status(500).json({ error: data.message || 'حدث خطأ في توليد رابط الدفع' });
    }
  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: 'خطأ داخلي في السيرفر' });
  }
}

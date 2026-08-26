// ملف تشخيص/إصلاح مؤقت — يفحص إعداد "السلة" (cart) بمستوى المتجر بشوبيير.
// السبب المرجّح لتراكم المنتجات القديمة (اللي تم إلغاؤها) بصفحة الدفع: إعداد
// "cart" بمستوى المتجر مفعّل (true)، فكل عملية دفع جديدة تُضاف فوق المنتجات
// السابقة غير المكتملة بدل ما تبدأ سلة نظيفة من الصفر.
// احذف هذا الملف بعد ما نخلص من التشخيص/الإصلاح.
//
// طريقة الاستخدام (GET من المتصفح مباشرة):
//   /api/debug-cart            -> يعرض إعدادات المتجر الحالية فقط (بدون أي تعديل)
//   /api/debug-cart?fix=1      -> يعطّل إعداد "cart" (يجعله false) ويعرض الإعدادات بعد التعديل

import { ShopierApiClient } from '@nopeion/shopier';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const PAT = process.env.SHOPIER_PAT;
    if (!PAT) {
        return res.status(500).json({ error: 'SHOPIER_PAT غير معرّف' });
    }

    const client = new ShopierApiClient({ pat: PAT });

    try {
        if (req.query?.fix) {
            const updated = await client.shop.updateSettings({ cart: false });
            return res.status(200).json({ mode: 'fixed', settingsAfterFix: updated });
        }

        const settings = await client.shop.getSettings();
        return res.status(200).json({ mode: 'read-only', currentSettings: settings });
    } catch (error) {
        return res.status(500).json({
            error: error?.message || String(error),
            stack: error?.stack,
        });
    }
}

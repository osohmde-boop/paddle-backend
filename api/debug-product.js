// ملف تشخيص مؤقت — يستخدم مرة أو مرتين بس لمقارنة منتج ينشئه الكود تلقائيًا
// بمنتج تنشئه يدويًا من لوحة تحكم شوبيير، عشان نلقى الفرق اللي يسبب خطأ 500
// بصفحة الدفع (/s/shipping/...). احذف هذا الملف بعد ما نخلص من التشخيص.
//
// طريقة الاستخدام (GET، من المتصفح مباشرة):
//   1) بدون أي باراميتر: /api/debug-product
//      -> ينشئ منتج تجريبي بنفس طريقة shopier.js بالضبط، يجيب تفاصيله الكاملة من شوبيير، ويحذفه فورًا.
//   2) مع رقم منتج موجود: /api/debug-product?id=PRODUCT_ID
//      -> يجيب تفاصيل ذاك المنتج فقط (بدون إنشاء أو حذف أي شي) — استخدمها مع رقم منتجك اليدوي اللي اشتغل صح.
//   3) بدون أي إنشاء، بس قائمة أقسام (تصنيفات) المتجر:
//      /api/debug-product?categories=1

import { ShopierApiClient, ShopierPaymentFlow } from '@nopeion/shopier';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const PAT = process.env.SHOPIER_PAT;
    const SHOP_SLUG = process.env.SHOPIER_SHOP_SLUG;

    if (!PAT) {
        return res.status(500).json({ error: 'SHOPIER_PAT غير معرّف' });
    }

    const client = new ShopierApiClient({ pat: PAT });

    try {
        // وضع 3: قائمة التصنيفات المتاحة بالمتجر
        if (req.query?.categories) {
            const categories = await client.categories.list();
            return res.status(200).json({ categories });
        }

        // وضع 2: جيب تفاصيل منتج موجود بس (يدوي أو أي منتج تبي تفحصه)
        const existingId = req.query?.id;
        if (existingId) {
            const product = await client.products.get(String(existingId));
            return res.status(200).json({ mode: 'existing-product', product });
        }

        // وضع 1: أنشئ منتج تجريبي بنفس الطريقة تمامًا اللي يستخدمها shopier.js، جيب تفاصيله الكاملة، ثم احذفه
        if (!SHOP_SLUG) {
            return res.status(500).json({ error: 'SHOPIER_SHOP_SLUG غير معرّف' });
        }

        const payments = new ShopierPaymentFlow({
            client,
            defaultImageUrl: 'https://i.ibb.co/YT1RPZdx/image.png',
        });

        const testOrderId = `DEBUG-${Date.now()}`;
        const payment = await payments.createPaymentLink({
            title: `YZ Store DEBUG ${testOrderId}`,
            amount: '1.00',
            currency: 'TRY',
            orderId: testOrderId,
            hostedCheckout: true,
            shopSlug: SHOP_SLUG,
        });

        // جيب أحدث نسخة من المنتج مباشرة من شوبيير (مو بس اللي رجع من create)
        const fullProduct = await client.products.get(payment.productId).catch((e) => ({
            fetchError: e?.message || String(e),
        }));

        // نظف المنتج التجريبي فورًا
        await client.products.delete(payment.productId).catch(() => {});

        return res.status(200).json({
            mode: 'created-via-api',
            productIdUsed: payment.productId,
            shopSlugUsed: SHOP_SLUG,
            createResponse: payment.product,
            getResponse: fullProduct,
            productInputSent: payment.productInput,
            checkoutFormAction: `https://www.shopier.com/s/shipping/${encodeURIComponent(SHOP_SLUG)}`,
        });
    } catch (error) {
        return res.status(500).json({
            error: error?.message || String(error),
            stack: error?.stack,
        });
    }
}

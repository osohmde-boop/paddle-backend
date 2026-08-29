// api/whop.js — Vercel Serverless Function
const WHOP_API_BASE = "https://api.whop.com/api/v1";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const items = Array.isArray(body.items) ? body.items : [];
    const currency = (body.currency || "usd").toLowerCase();
    const redirectUrl = body.redirectUrl || undefined;

    if (items.length === 0) {
      return res.status(400).json({ error: "سلة التسوق فارغة." });
    }

    // 1) حساب المجموع من Firebase
    const total = await computeCartTotalFromFirebase(items);

    if (!(total > 0)) {
      return res.status(400).json({ error: "تعذّر حساب إجمالي صحيح للسلة من المنتجات." });
    }

    // 2) التأكد من وجود المتغيرات البيئية
    if (!process.env.WHOP_API_KEY || !process.env.WHOP_COMPANY_ID) {
      console.error("Missing WHOP_API_KEY or WHOP_COMPANY_ID in environment variables");
      return res.status(500).json({ error: "إعدادات بوابة الدفع غير مكتملة على السيرفر." });
    }

    // 3) إرسال الطلب لـ Whop API v1 لإنشاء Inline Plan الديناميكية
    const whopPayload = {
      mode: "payment",
      plan: {
        company_id: process.env.WHOP_COMPANY_ID,
        currency,
        initial_price: Math.round(total * 100) / 100,
        plan_type: "one_time",
        title: `Order total $${total.toFixed(2)}`,
        ...(process.env.WHOP_PRODUCT_ID ? { product_id: process.env.WHOP_PRODUCT_ID } : {}),
      },
      metadata: {
        source: "website-cart",
        items: JSON.stringify(items).slice(0, 500),
      },
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    };

    const whopRes = await fetch(`${WHOP_API_BASE}/checkout_configurations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHOP_API_KEY}`,
      },
      body: JSON.stringify(whopPayload),
    });

    const rawText = await whopRes.text();
    let whopData = {};
    if (rawText) {
      try {
        whopData = JSON.parse(rawText);
      } catch (parseErr) {
        console.error("Whop returned non-JSON body:", rawText);
        return res.status(502).json({ error: "استجابة غير متوقعة من بوابة Whop.", detail: rawText.slice(0, 200) });
      }
    }

    if (!whopRes.ok) {
      console.error("Whop API error status:", whopRes.status, "Body:", whopData);
      return res.status(whopRes.status).json({
        error: whopData.error || whopData.message || "فشل إنشاء جلسة الدفع في Whop.",
        details: whopData
      });
    }

    const checkoutUrl = whopData.purchase_url || (whopData.id ? `https://whop.com/checkout/${whopData.id}/` : null);

    if (!checkoutUrl) {
      return res.status(502).json({ error: "لم يتم استلام رابط الدفع من Whop.", whop_body: whopData });
    }

    return res.status(200).json({
      url: checkoutUrl,
      id: whopData.id,
      amount: Math.round(total * 100) / 100,
      currency,
    });

  } catch (err) {
    console.error("api/whop.js fatal error:", err);
    return res.status(500).json({ error: "خطأ داخلي في الخادم.", detail: String(err?.message || err) });
  }
}

async function computeCartTotalFromFirebase(items) {
  const dbUrl = process.env.FIREBASE_DB_URL || "https://osman-70f42-default-rtdb.firebaseio.com";
  let total = 0;

  for (const item of items) {
    const productId = item && (item.productId || item.key || item.id);
    const qty = Math.max(1, parseInt(item && (item.qty || item.quantity), 10) || 1);
    if (!productId) continue;

    const secretParam = process.env.FIREBASE_DB_SECRET ? `?auth=${process.env.FIREBASE_DB_SECRET}` : "";
    const url = `${dbUrl.replace(/\/$/, "")}/products/${encodeURIComponent(productId)}.json${secretParam}`;

    const r = await fetch(url);
    if (!r.ok) {
      console.warn(`Firebase lookup failed for product ${productId}: ${r.status}`);
      continue;
    }
    const product = await r.json();
    const price = product && Number(product.price);
    if (Number.isFinite(price)) {
      total += price * qty;
    }
  }

  return total;
}

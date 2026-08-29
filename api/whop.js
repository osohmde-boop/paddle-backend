// api/whop.js — Vercel Serverless Function
const WHOP_API_BASE = "https://api.whop.com/api/v1";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const items = Array.isArray(body.items) ? body.items : [];
    const currency = (body.currency || "usd").toLowerCase();
    const redirectUrl = body.redirectUrl || undefined;

    if (items.length === 0) {
      res.status(400).json({ error: "سلة التسوق فارغة." });
      return;
    }

    // 1) حساب المجموع الكلي برمجياً من Firebase بشكل آمن
    const total = await computeCartTotalFromFirebase(items);

    if (!(total > 0)) {
      res.status(400).json({ error: "تعذّر حساب إجمالي صحيح للسلة." });
      return;
    }

    // 2) إنشاء الخطة الديناميكية Inline Plan في Whop API v1
    const whopPayload = {
      mode: "payment",
      plan: {
        company_id: process.env.WHOP_COMPANY_ID,
        currency,
        initial_price: round2(total),
        plan_type: "one_time",
        title: `Order total ${round2(total)} ${currency.toUpperCase()}`,
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
        console.error("Whop returned non-JSON body:", rawText.slice(0, 500));
        res.status(502).json({
          error: "استجابة غير متوقعة من Whop.",
          detail: rawText.slice(0, 300),
        });
        return;
      }
    }

    if (!whopRes.ok) {
      console.error("Whop API error", whopRes.status, whopData);
      res.status(whopRes.status).json({
        error: whopData.error || whopData.message || "فشل إنشاء جلسة الدفع في Whop.",
        whop_status: whopRes.status,
        whop_body: whopData,
      });
      return;
    }

    const checkoutUrl =
      whopData.purchase_url ||
      (whopData.id ? `https://whop.com/checkout/${whopData.id}/` : null);

    if (!checkoutUrl) {
      res.status(502).json({ error: "لم يتم استلام رابط دفع من Whop.", whop_body: whopData });
      return;
    }

    res.status(200).json({
      url: checkoutUrl,
      id: whopData.id,
      amount: round2(total),
      currency,
    });
  } catch (err) {
    console.error("api/whop.js fatal error:", err);
    res.status(500).json({ error: "خطأ داخلي في الخادم.", detail: String(err && err.message || err) });
  }
};

async function computeCartTotalFromFirebase(items) {
  const dbUrl = process.env.FIREBASE_DB_URL || "https://osman-70f42-default-rtdb.firebaseio.com";

  let total = 0;

  for (const item of items) {
    // التتوافق المباشر مع مفاتيح عناصر السلة من موقعك
    const productId = item && (item.productId || item.key || item.id);
    const qty = Math.max(1, parseInt(item && (item.qty || item.quantity), 10) || 1);
    if (!productId) continue;

    const secretParam = process.env.FIREBASE_DB_SECRET
      ? `?auth=${process.env.FIREBASE_DB_SECRET}`
      : "";
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

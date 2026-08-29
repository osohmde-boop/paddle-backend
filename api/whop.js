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
    // هذه الحقول يرسلها index.html مع كل طلب (orderId, uid, customerEmail) —
    // نمررها كـ metadata مع جلسة Whop حتى يمكن مطابقة الدفعة بالطلب لاحقاً
    // (مثلاً من Webhook خاص بـ Whop يُحدّث الحالة إلى "active").
    const orderId = body.orderId || undefined;
    const uid = body.uid || undefined;
    const customerEmail = body.customerEmail || undefined;
    const couponCode = body.couponCode ? String(body.couponCode).trim().toUpperCase() : null;

    if (items.length === 0) {
      return res.status(400).json({ error: "سلة التسوق فارغة." });
    }

    // 1) حساب المجموع من Firebase (مصدر الحقيقة، وليس من قيمة يرسلها المتصفح)
    const subtotal = await computeCartTotalFromFirebase(items);
    if (!(subtotal > 0)) {
      return res.status(400).json({ error: "تعذّر حساب إجمالي صحيح للسلة من المنتجات." });
    }

    // 1b) تحقق من كود الخصم (إن وُجد) من Firebase مباشرة — لا نثق أبداً بأي مبلغ
    //     خصم يرسله المتصفح، حتى لو كان العميل قد تحقق من الكود بنفسه في الواجهة.
    let discount = 0;
    if (couponCode) {
      const couponResult = await validateCouponFromFirebase(couponCode, subtotal);
      if (!couponResult.valid) {
        return res.status(400).json({ error: couponResult.reason || "كود الخصم غير صالح." });
      }
      discount = couponResult.discount;
    }
    const total = Math.max(subtotal - discount, 0);
    if (!(total > 0)) {
      return res.status(400).json({ error: "قيمة الطلب بعد الخصم غير صالحة." });
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
        order_id: orderId,
        uid,
        customer_email: customerEmail,
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
        details: whopData,
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
      discount: Math.round(discount * 100) / 100,
      couponCode: couponCode || null,
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

// يتحقق من كود الخصم مباشرة من Firebase (مصدر الحقيقة) — لا نثق أبداً
// بأي قيمة خصم يرسلها المتصفح، حتى لو كان قد تحقق من الكود بنفسه مسبقاً
// عبر قراءة سريعة من الواجهة الأمامية. الشكل المتوقع في قاعدة البيانات:
//   coupons/<CODE> = {
//     type: "percent" | "fixed",   // نوع الخصم
//     value: number,               // 10 = 10% إذا percent، أو 10 = $10 إذا fixed
//     active: true|false,          // اختياري، افتراضي true
//     expiresAt: "2026-12-31" | timestamp (ms) | ISO string,  // اختياري
//     minTotal: number             // اختياري: أقل مجموع فرعي مطلوب لتفعيل الكود
//   }
async function validateCouponFromFirebase(couponCode, subtotal) {
  const dbUrl = process.env.FIREBASE_DB_URL || "https://osman-70f42-default-rtdb.firebaseio.com";
  const secretParam = process.env.FIREBASE_DB_SECRET ? `?auth=${process.env.FIREBASE_DB_SECRET}` : "";
  const url = `${dbUrl.replace(/\/$/, "")}/coupons/${encodeURIComponent(couponCode)}.json${secretParam}`;

  let data = null;
  try {
    const r = await fetch(url);
    if (r.ok) {
      data = await r.json();
    }
  } catch (err) {
    console.error("validateCouponFromFirebase fetch error:", err);
  }

  if (!data || typeof data !== "object") {
    return { valid: false, discount: 0, reason: "كود الخصم غير موجود." };
  }

  if (data.active === false) {
    return { valid: false, discount: 0, reason: "كود الخصم لم يعد فعالاً." };
  }

  if (data.expiresAt) {
    const expiryTime = new Date(data.expiresAt).getTime();
    if (Number.isFinite(expiryTime) && Date.now() > expiryTime) {
      return { valid: false, discount: 0, reason: "انتهت صلاحية كود الخصم." };
    }
  }

  const minTotal = Number(data.minTotal);
  if (Number.isFinite(minTotal) && minTotal > 0 && subtotal < minTotal) {
    return {
      valid: false,
      discount: 0,
      reason: `هذا الكود يتطلب حداً أدنى للطلب قدره $${minTotal.toFixed(2)}.`,
    };
  }

  const type = data.type === "fixed" ? "fixed" : "percent";
  const value = Number(data.value);
  if (!Number.isFinite(value) || value <= 0) {
    return { valid: false, discount: 0, reason: "كود الخصم غير صالح." };
  }

  let discount = type === "percent" ? (subtotal * value) / 100 : value;
  discount = Math.max(0, Math.min(discount, subtotal));

  if (!(discount > 0)) {
    return { valid: false, discount: 0, reason: "كود الخصم غير صالح." };
  }

  return { valid: true, discount };
}

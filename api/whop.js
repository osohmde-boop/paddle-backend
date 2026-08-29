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
    let couponKey = null;
    let couponUsedCount = 0;
    if (couponCode) {
      const couponResult = await validateCouponFromFirebase(couponCode, subtotal);
      if (!couponResult.valid) {
        return res.status(400).json({ error: couponResult.reason || "كود الخصم غير صالح." });
      }
      discount = couponResult.discount;
      couponKey = couponResult.key;
      couponUsedCount = couponResult.usedCount;
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

    if (couponCode && couponKey) {
      // best-effort فقط — لا يوقف أو يبطئ الاستجابة بشكل ملحوظ، ولا يفشل الطلب لو تعذّر
      await bumpCouponUsage(couponKey, couponUsedCount);
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
// عبر قراءة سريعة من الواجهة الأمامية.
//
// ملاحظة مهمة: أكواد الخصم تُدار من لوحة التحكم (admin.html → "أكواد الخصم")
// وتُخزَّن في store_settings/discountCodes (بمفاتيح عشوائية من push())، وكل عنصر
// فيها بهذا الشكل: { code: "YZ10", percentage: 20, expiresAt: "2026-08-31"|null,
// usageLimit: number|null, usedCount?: number }. نستخدم هذا المسار بالذات (وليس
// مساراً منفصلاً) حتى تبقى الأكواد التي ينشئها الأدمن متوافقة تماماً مع السيرفر.
async function validateCouponFromFirebase(couponCode, subtotal) {
  const dbUrl = process.env.FIREBASE_DB_URL || "https://osman-70f42-default-rtdb.firebaseio.com";
  const secretParam = process.env.FIREBASE_DB_SECRET ? `?auth=${process.env.FIREBASE_DB_SECRET}` : "";
  const url = `${dbUrl.replace(/\/$/, "")}/store_settings/discountCodes.json${secretParam}`;

  let all = null;
  try {
    const r = await fetch(url);
    if (r.ok) {
      all = await r.json();
    }
  } catch (err) {
    console.error("validateCouponFromFirebase fetch error:", err);
  }

  if (!all || typeof all !== "object") {
    return { valid: false, discount: 0, reason: "كود الخصم غير موجود." };
  }

  let matchKey = null;
  let matchData = null;
  for (const [key, entry] of Object.entries(all)) {
    if (entry && typeof entry === "object" && String(entry.code || "").toUpperCase() === couponCode) {
      matchKey = key;
      matchData = entry;
      break;
    }
  }

  if (!matchData) {
    return { valid: false, discount: 0, reason: "كود الخصم غير موجود." };
  }

  if (matchData.expiresAt) {
    const expiryTime = new Date(`${matchData.expiresAt}T23:59:59`).getTime();
    if (Number.isFinite(expiryTime) && Date.now() > expiryTime) {
      return { valid: false, discount: 0, reason: "انتهت صلاحية كود الخصم." };
    }
  }

  const usageLimit = matchData.usageLimit != null ? Number(matchData.usageLimit) : null;
  const usedCount = Number(matchData.usedCount) || 0;
  if (Number.isFinite(usageLimit) && usageLimit > 0 && usedCount >= usageLimit) {
    return { valid: false, discount: 0, reason: "تم استنفاد الحد الأقصى لاستخدام هذا الكود." };
  }

  const percentage = Number(matchData.percentage);
  if (!Number.isFinite(percentage) || percentage <= 0) {
    return { valid: false, discount: 0, reason: "كود الخصم غير صالح." };
  }

  let discount = (subtotal * percentage) / 100;
  discount = Math.max(0, Math.min(discount, subtotal));

  if (!(discount > 0)) {
    return { valid: false, discount: 0, reason: "كود الخصم غير صالح." };
  }

  return { valid: true, discount, key: matchKey, usedCount };
}

// تحديث best-effort لعدّاد الاستخدام بعد إنشاء جلسة دفع ناجحة — يعمل فقط إذا كان
// FIREBASE_DB_SECRET (Legacy Database Secret) معرّفاً، لأنه يحتاج صلاحية كتابة
// تتجاوز قواعد الأمان (store_settings.write محصورة بحساب الأدمن). إذا لم يكن
// السر معرّفاً، تُتجاهل هذه الخطوة بصمت ولا تؤثر إطلاقاً على إتمام الدفع.
async function bumpCouponUsage(key, usedCount) {
  if (!key || !process.env.FIREBASE_DB_SECRET) return;
  const dbUrl = process.env.FIREBASE_DB_URL || "https://osman-70f42-default-rtdb.firebaseio.com";
  const url = `${dbUrl.replace(/\/$/, "")}/store_settings/discountCodes/${encodeURIComponent(key)}/usedCount.json?auth=${process.env.FIREBASE_DB_SECRET}`;
  try {
    await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify((usedCount || 0) + 1),
    });
  } catch (err) {
    console.warn("bumpCouponUsage failed (non-fatal):", err);
  }
}

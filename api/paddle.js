export default async function handler(req, res) {
  // ------------------------------------------------------------
  // CORS
  // ------------------------------------------------------------
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,OPTIONS,POST'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  // ------------------------------------------------------------
  // Environment variables
  // ------------------------------------------------------------
  const PADDLE_API_URL =
    process.env.PADDLE_API_URL || 'https://api.paddle.com';

  const FIREBASE_DATABASE_URL =
    process.env.FIREBASE_DATABASE_URL ||
    'https://osman-70f42-default-rtdb.firebaseio.com';

  const rawKey =
    process.env.PADDLE_API_KEY || '';

  const PADDLE_API_KEY =
    rawKey
      .replace(/['"]/g, '')
      .replace(/^Bearer\s+/i, '')
      .trim();

  if (!PADDLE_API_KEY) {
    return res.status(500).json({
      error: 'PADDLE_API_KEY غير موجود في Vercel Environment Variables.'
    });
  }

  // ------------------------------------------------------------
  // Read request
  //
  // IMPORTANT:
  // The browser is only allowed to send:
  // productId + quantity
  //
  // The browser MUST NOT control the price.
  // ------------------------------------------------------------
  const {
    items,
    customerEmail
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      error: 'السلة فارغة.'
    });
  }

  if (items.length > 100) {
    return res.status(400).json({
      error: 'عدد المنتجات في السلة كبير جداً.'
    });
  }

  // ------------------------------------------------------------
  // Validate customer email
  // ------------------------------------------------------------
  const email =
    typeof customerEmail === 'string'
      ? customerEmail.trim()
      : '';

  if (!email || !email.includes('@')) {
    return res.status(400).json({
      error: 'البريد الإلكتروني غير صالح.'
    });
  }

  try {
    const paddleItems = [];
    const customItems = [];

    // ----------------------------------------------------------
    // Read every product FROM FIREBASE
    // ----------------------------------------------------------
    for (const cartItem of items) {
      const productId =
        typeof cartItem?.productId === 'string'
          ? cartItem.productId.trim()
          : '';

      const quantity =
        Number(cartItem?.quantity);

      if (!productId) {
        return res.status(400).json({
          error: 'معرف المنتج غير صالح.'
        });
      }

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 100
      ) {
        return res.status(400).json({
          error: 'كمية المنتج غير صالحة.'
        });
      }

      // --------------------------------------------------------
      // Firebase Realtime Database REST
      // --------------------------------------------------------
      const firebaseUrl =
        `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/products/${encodeURIComponent(productId)}.json`;

      const firebaseResponse =
        await fetch(firebaseUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          }
        });

      if (!firebaseResponse.ok) {
        console.error(
          'Firebase response:',
          firebaseResponse.status,
          firebaseResponse.statusText
        );

        return res.status(500).json({
          error: 'تعذر قراءة بيانات المنتج من Firebase.'
        });
      }

      const product =
        await firebaseResponse.json();

      if (!product) {
        return res.status(404).json({
          error: 'المنتج غير موجود.'
        });
      }

      // --------------------------------------------------------
      // Product data from Firebase
      // --------------------------------------------------------
      const title =
        String(product.title || '').trim();

      const image =
        typeof product.image === 'string'
          ? product.image.trim()
          : '';

      const price =
        Number(product.price);

      if (!title) {
        return res.status(400).json({
          error: 'المنتج لا يحتوي على اسم صالح.'
        });
      }

      // --------------------------------------------------------
      // THIS is the important part:
      //
      // The price comes from Firebase.
      // The browser does NOT control it.
      // --------------------------------------------------------
      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return res.status(400).json({
          error: `سعر المنتج "${title}" غير صالح.`
        });
      }

      // Paddle uses the smallest currency denomination.
      //
      // $10.00 -> 1000
      // $7.50  -> 750
      // $15.99 -> 1599
      //
      const amountInCents =
        Math.round(price * 100);

      if (
        !Number.isInteger(amountInCents) ||
        amountInCents < 1
      ) {
        return res.status(400).json({
          error: `سعر المنتج "${title}" غير صالح.`
        });
      }

      // --------------------------------------------------------
      // Create NON-CATALOG Paddle item
      //
      // This means:
      // We don't need a pre-created Paddle Price ID.
      //
      // The exact Firebase price is used for this transaction.
      // --------------------------------------------------------
      const paddleItem = {
        quantity,

        price: {
          description:
            `YZ STORE - ${title}`.slice(0, 500),

          name:
            'One-time',

          billing_cycle:
            null,

          tax_mode:
            'account_setting',

          unit_price: {
            amount:
              String(amountInCents),

            currency_code:
              'USD'
          },

          product: {
            name:
              title.slice(0, 200),

            description:
              `Digital product from YZ STORE: ${title}`
                .slice(0, 2048),

            tax_category:
              'digital-goods',

            ...(image &&
            /^https?:\/\//i.test(image)
              ? { image_url: image }
              : {})
          }
        }
      };

      paddleItems.push(paddleItem);

      customItems.push({
        firebaseProductId: productId,
        title,
        price,
        quantity
      });
    }

    // ------------------------------------------------------------
    // Create Paddle Transaction
    // ------------------------------------------------------------
    const transactionPayload = {
      items: paddleItems,

      currency_code: 'USD',

      collection_mode: 'automatic',

      custom_data: {
        source: 'YZ_STORE',

        customer_email:
          email,

        items:
          customItems
      }
    };

    const paddleResponse =
      await fetch(
        `${PADDLE_API_URL.replace(/\/$/, '')}/transactions`,
        {
          method: 'POST',

          headers: {
            'Authorization':
              `Bearer ${PADDLE_API_KEY}`,

            'Content-Type':
              'application/json',

            'Paddle-Version':
              '1'
          },

          body:
            JSON.stringify(
              transactionPayload
            )
        }
      );

    const paddleData =
      await paddleResponse.json();

    // ------------------------------------------------------------
    // Paddle API error
    // ------------------------------------------------------------
    if (!paddleResponse.ok) {
      console.error(
        'Paddle API error:',
        JSON.stringify(
          paddleData,
          null,
          2
        )
      );

      return res.status(
        paddleResponse.status >= 400 &&
        paddleResponse.status < 500
          ? 400
          : 500
      ).json({
        error:
          paddleData?.error?.detail ||
          paddleData?.error?.message ||
          'Paddle رفض إنشاء عملية الدفع.'
      });
    }

    // ------------------------------------------------------------
    // Transaction ID
    // ------------------------------------------------------------
    const transactionId =
      paddleData?.data?.id;

    if (!transactionId) {
      console.error(
        'Paddle response without transaction ID:',
        paddleData
      );

      return res.status(500).json({
        error:
          'Paddle لم يرجع Transaction ID صالح.'
      });
    }

    // ------------------------------------------------------------
    // Return transaction to index.html
    // ------------------------------------------------------------
    return res.status(200).json({
      success: true,

      transactionId,

      // مفيد للتشخيص فقط
      currency: 'USD',

      items: customItems
    });

  } catch (error) {
    console.error(
      'Backend error:',
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        'حدث خطأ غير متوقع في خادم الدفع.'
    });
  }
}

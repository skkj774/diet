const SUPABASE_URL = 'https://kraaysvrttncbcljcwsu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vQGd1kEZUk8KpPtZxIRUxQ_1pUEDjF6';
const REGISTRATIONS_ENDPOINT = `${SUPABASE_URL}/rest/v1/registrations`;

function text(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ ok: false, message: 'POST送信のみ受け付けています。' });
  }

  const body = request.body || {};
  const email = text(body.email, 320);
  const weight = Number(body.weight);
  const plan = text(body.plan, 500);
  const summary = text(body.summary, 20000);
  const tags = text(body.tags, 2000);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ ok: false, message: '有効なメールアドレスを入力してください。' });
  }
  if (!Number.isFinite(weight) || weight <= 0 || weight > 9999) {
    return response.status(400).json({ ok: false, message: '現在の体重を正しく入力してください。' });
  }
  if (!plan || !summary) {
    return response.status(400).json({ ok: false, message: '診断結果が不足しています。もう一度診断してください。' });
  }

  try {
    const supabaseResponse = await fetch(REGISTRATIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ email, weight, plan, summary, tags })
    });

    if (!supabaseResponse.ok) {
      const error = await supabaseResponse.json().catch(() => ({}));
      throw new Error(error.message || `Supabase HTTP ${supabaseResponse.status}`);
    }

    return response.status(201).json({ ok: true, message: '登録と送信が完了しました。' });
  } catch (error) {
    console.error('Registration failed:', error);
    return response.status(502).json({ ok: false, message: '送信に失敗しました。時間をおいて再度お試しください。' });
  }
};

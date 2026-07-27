const SUPABASE_URL = 'https://kraaysvrttncbcljcwsu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vQGd1kEZUk8KpPtZxIRUxQ_1pUEDjF6';

function jsonText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

async function callRpc(name, body) {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await result.json().catch(() => null);
  if (!result.ok) {
    const error = new Error(data?.message || `Supabase HTTP ${result.status}`);
    error.status = result.status;
    throw error;
  }
  return data;
}

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ ok: false, message: 'POST送信のみ受け付けています。' });
  }

  const action = jsonText(request.body?.action, 20);
  const token = jsonText(request.body?.token, 128);
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
    return response.status(401).json({ ok: false, message: '専用リンクが無効です。' });
  }

  try {
    if (action === 'list') {
      const entries = await callRpc('get_diet_weight_history', { access_token: token });
      if (!Array.isArray(entries) || entries.length === 0) {
        return response.status(404).json({ ok: false, message: '記録が見つかりません。' });
      }
      return response.status(200).json({ ok: true, entries });
    }

    if (action === 'add') {
      const weight = Number(request.body?.weight);
      if (!Number.isFinite(weight) || weight <= 0 || weight > 999.9) {
        return response.status(400).json({ ok: false, message: '体重を正しく入力してください。' });
      }
      const entries = await callRpc('add_diet_weight_entry', {
        access_token: token,
        new_weight: Math.round(weight * 10) / 10
      });
      return response.status(201).json({ ok: true, entry: entries?.[0] || null });
    }

    return response.status(400).json({ ok: false, message: '操作が正しくありません。' });
  } catch (error) {
    console.error('Weight progress request failed:', error);
    const status = error.status === 404 ? 404 : 502;
    return response.status(status).json({
      ok: false,
      message: status === 404 ? '専用リンクが無効です。' : 'データを取得できませんでした。時間をおいて再度お試しください。'
    });
  }
};

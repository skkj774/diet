const crypto = require('crypto');

const SUPABASE_URL = 'https://kraaysvrttncbcljcwsu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vQGd1kEZUk8KpPtZxIRUxQ_1pUEDjF6';
const REGISTRATIONS_ENDPOINT = `${SUPABASE_URL}/rest/v1/registrations`;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REGISTRATION_SUBJECT = 'TAZパーソナルダイエットプログラム登録完了';
const PROGRAM_URL = 'https://taz-x.tokyo/';

function text(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

async function sendRegistrationEmail(email, progressUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REGISTRATION_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error('Email environment variables are not configured');
  }

  const resendResponse = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: REGISTRATION_SUBJECT,
      text: `ありがとうございます。\n\n以下の専用ページから、体重の記録と変化の確認ができます。\n${progressUrl}\n\n診断ページ\n${PROGRAM_URL}`,
      html: `<p>ありがとうございます。</p><p>以下の専用ページから、体重の記録と変化の確認ができます。</p><p><a href="${progressUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#3557d4;color:#ffffff;text-decoration:none;font-weight:700">体重記録ページを開く</a></p><p style="font-size:13px;color:#5f6675">このリンクはご本人専用です。第三者へ共有しないでください。</p><p><a href="${PROGRAM_URL}">診断ページへ戻る</a></p>`
    })
  });

  if (!resendResponse.ok) {
    const error = await resendResponse.json().catch(() => ({}));
    throw new Error(error.message || `Resend HTTP ${resendResponse.status}`);
  }
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
    const accessToken = crypto.randomBytes(32).toString('base64url');
    const accessTokenHash = crypto.createHash('sha256').update(accessToken, 'utf8').digest('hex');
    const progressUrl = `${PROGRAM_URL}progress.html#token=${accessToken}`;
    const supabaseResponse = await fetch(REGISTRATIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        email,
        weight,
        plan,
        summary,
        tags,
        access_token_hash: accessTokenHash
      })
    });

    if (!supabaseResponse.ok) {
      const error = await supabaseResponse.json().catch(() => ({}));
      throw new Error(error.message || `Supabase HTTP ${supabaseResponse.status}`);
    }

    try {
      await sendRegistrationEmail(email, progressUrl);
    } catch (emailError) {
      console.error('Registration email failed:', emailError);
      return response.status(201).json({
        ok: true,
        emailSent: false,
        message: '登録は完了しましたが、完了メールを送信できませんでした。'
      });
    }

    return response.status(201).json({
      ok: true,
      emailSent: true,
      message: '登録が完了し、確認メールを送信しました。'
    });
  } catch (error) {
    console.error('Registration failed:', error);
    return response.status(502).json({ ok: false, message: '送信に失敗しました。時間をおいて再度お試しください。' });
  }
};

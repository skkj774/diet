const crypto = require('crypto');
const {
  MILESTONES,
  buildContinuationEmail,
  buildFeedbackEmail,
  buildMilestoneEmail,
  cancelEmail,
  sendEmail
} = require('./_program-mail');

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

function tokenKey(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32);
}

async function scheduleProgramEmail({ token, profile, milestone, delayMinutes }) {
  const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  const content = milestone.startsWith('continue_')
    ? buildContinuationEmail(token, Boolean(profile.maintenance), milestone)
    : buildMilestoneEmail(token, milestone);
  const result = await sendEmail({
    to: profile.recipient_email,
    ...content,
    scheduledAt,
    idempotencyKey: `diet-${milestone}-${tokenKey(token)}`
  });
  await callRpc('save_diet_scheduled_email', {
    access_token: token,
    email_milestone: milestone,
    resend_id: result.id,
    send_at: scheduledAt
  });
  return { milestone, scheduledAt };
}

async function startProgram(token) {
  const rows = await callRpc('start_diet_program', { access_token: token });
  const profile = rows?.[0];
  if (!profile) throw new Error('専用リンクが無効です。');
  const existing = new Set(profile.scheduled_milestones || []);
  const definitions = profile.test_mode
    ? Object.entries(MILESTONES).map(([milestone, item]) => ({ milestone, delayMinutes: item.minutes }))
    : [
        { milestone: 'week1', delayMinutes: 7 * 24 * 60 },
        { milestone: 'month1', delayMinutes: 29 * 24 * 60 }
      ];
  const scheduled = [];
  for (const definition of definitions) {
    if (!existing.has(definition.milestone)) {
      scheduled.push(await scheduleProgramEmail({ token, profile, ...definition }));
    }
  }
  return { profile, scheduled };
}

async function scheduleNextCheckin(token, entry, checkin) {
  if (entry.test_mode) return null;
  const next = checkin === 'month1' ? 'month2' : checkin === 'month2' ? 'month3' : '';
  if (!next) return null;
  return scheduleProgramEmail({
    token,
    profile: entry,
    milestone: next,
    delayMinutes: 29 * 24 * 60
  });
}

async function addWeight(token, weight, checkin) {
  const rows = await callRpc('add_diet_weight_entry', {
    access_token: token,
    new_weight: Math.round(weight * 10) / 10,
    entry_checkin: checkin || null
  });
  const entry = rows?.[0];
  if (!entry) throw new Error('体重を記録できませんでした。');
  let emailSent = null;

  if (checkin && checkin !== 'week1' && !entry.feedback_sent_at) {
    const emailContent = buildFeedbackEmail({ ...entry, access_token: token }, checkin);
    await sendEmail({
      to: entry.recipient_email,
      ...emailContent,
      idempotencyKey: `diet-feedback-${checkin}-${tokenKey(token)}`
    });
    await callRpc('mark_diet_feedback_sent', {
      access_token: token,
      entry_checkin: checkin
    });
    emailSent = true;
    await scheduleNextCheckin(token, entry, checkin);

    if (checkin.startsWith('continue_')) {
      const number = Number(checkin.slice('continue_'.length)) || 1;
      const nextMilestone = `continue_${number + 1}`;
      await scheduleProgramEmail({
        token,
        profile: {
          recipient_email: entry.recipient_email,
          maintenance: Number(entry.current_weight) <= Number(entry.target_weight)
        },
        milestone: nextMilestone,
        delayMinutes: entry.test_mode ? 3 : 29 * 24 * 60
      });
    }
  }
  return { entry, emailSent };
}

async function stopProgram(token) {
  const pending = await callRpc('stop_diet_program', { access_token: token });
  const canceled = [];
  for (const item of pending || []) {
    if (!item.resend_email_id) continue;
    try {
      await cancelEmail(item.resend_email_id);
      canceled.push(item.milestone);
    } catch (error) {
      console.error(`Failed to cancel ${item.milestone}:`, error);
    }
  }
  if (canceled.length) {
    await callRpc('mark_diet_emails_canceled', {
      access_token: token,
      email_milestones: canceled
    });
  }
  return canceled;
}

async function continueProgram(token) {
  const rows = await callRpc('continue_diet_program', { access_token: token });
  const profile = rows?.[0];
  if (!profile) throw new Error('専用リンクが無効です。');
  if (!(profile.scheduled_milestones || []).includes('continue_1')) {
    await scheduleProgramEmail({
      token,
      profile,
      milestone: 'continue_1',
      delayMinutes: profile.test_mode ? 3 : 29 * 24 * 60
    });
  }
  return profile;
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
    if (action === 'start') {
      const result = await startProgram(token);
      return response.status(200).json({
        ok: true,
        started: true,
        testMode: result.profile.test_mode,
        message: result.profile.test_mode
          ? 'プログラムを開始しました。テストメールを1・3・6・9分後に送信します。'
          : 'プログラムを開始しました。'
      });
    }

    if (action === 'list') {
      const [entries, profiles] = await Promise.all([
        callRpc('get_diet_weight_history', { access_token: token }),
        callRpc('get_diet_program_profile', { access_token: token })
      ]);
      if (!Array.isArray(entries) || entries.length === 0 || !profiles?.[0]) {
        return response.status(404).json({ ok: false, message: '記録が見つかりません。' });
      }
      return response.status(200).json({ ok: true, entries, profile: profiles[0] });
    }

    if (action === 'add') {
      const weight = Number(request.body?.weight);
      const checkin = jsonText(request.body?.checkin, 40);
      if (!Number.isFinite(weight) || weight <= 0 || weight > 999.9) {
        return response.status(400).json({ ok: false, message: '体重を正しく入力してください。' });
      }
      if (checkin && !/^(week1|month1|month2|month3|continue_[0-9]+)$/.test(checkin)) {
        return response.status(400).json({ ok: false, message: 'チェックイン情報が正しくありません。' });
      }
      const result = await addWeight(token, weight, checkin);
      return response.status(201).json({
        ok: true,
        entry: {
          weight: result.entry.weight,
          recorded_at: result.entry.recorded_at,
          checkin_type: checkin || null
        },
        emailSent: result.emailSent,
        showContinuation: checkin === 'month3'
      });
    }

    if (action === 'continue') {
      const profile = await continueProgram(token);
      return response.status(200).json({
        ok: true,
        maintenance: profile.maintenance,
        message: profile.maintenance
          ? '体重メンテナンスコースを継続します。'
          : '目標達成まで減量コースを継続します。'
      });
    }

    if (action === 'stop') {
      await stopProgram(token);
      return response.status(200).json({ ok: true, message: 'プログラムを終了しました。今後の予約メールは停止しました。' });
    }

    return response.status(400).json({ ok: false, message: '操作が正しくありません。' });
  } catch (error) {
    console.error('Diet program request failed:', error);
    return response.status(502).json({
      ok: false,
      message: '処理を完了できませんでした。時間をおいて再度お試しください。'
    });
  }
};

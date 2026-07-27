const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const PROGRAM_URL = 'https://taz-x.tokyo/';

const MILESTONES = {
  week1: {
    minutes: 1,
    label: '開始1週間後',
    subject: '【TAZ】ダイエット開始後の継続確認',
    heading: 'まずは、続けられているか確認しましょう',
    body: '完璧にできていなくても問題ありません。専用ページで現在の体重を記録し、できたことを一つ確認してください。'
  },
  month1: {
    minutes: 3,
    label: '開始1か月後',
    subject: '【TAZ】1か月目の体重を記録しましょう',
    heading: '1か月目のチェックインです',
    body: '現在の体重を入力すると、目標への到達度と診断結果に合わせたコメントをメールでお送りします。'
  },
  month2: {
    minutes: 6,
    label: '開始2か月後',
    subject: '【TAZ】2か月目の体重を記録しましょう',
    heading: '2か月目のチェックインです',
    body: '短期の増減だけで判断せず、開始時からの流れを確認しましょう。入力後、今月のコメントをお送りします。'
  },
  month3: {
    minutes: 9,
    label: '開始3か月後',
    subject: '【TAZ】3か月プログラムの振り返り',
    heading: '3か月目の最終チェックインです',
    body: '体重を入力して3か月間を振り返りましょう。入力後、目標達成度に応じたコメントと今後の選択肢をご案内します。'
  }
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function progressUrl(token, milestone = '') {
  const params = new URLSearchParams({ token });
  if (milestone) params.set('checkin', milestone);
  return `${PROGRAM_URL}progress.html#${params.toString()}`;
}

function emailFrame(heading, paragraphs, buttonLabel, buttonUrl, footer = '') {
  const paragraphHtml = paragraphs.map(text => `<p style="margin:0 0 16px;line-height:1.8">${escapeHtml(text)}</p>`).join('');
  return `<div style="background:#f4f6fb;padding:28px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans JP',sans-serif;color:#202533"><div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e1e5ef;border-radius:18px;padding:28px"><div style="font-size:12px;font-weight:800;color:#3557d4;letter-spacing:.06em;margin-bottom:12px">TAZ PERSONAL DIET</div><h1 style="font-size:22px;line-height:1.5;margin:0 0 18px">${escapeHtml(heading)}</h1>${paragraphHtml}<p style="margin:24px 0"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;padding:13px 20px;border-radius:11px;background:#3557d4;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(buttonLabel)}</a></p><p style="font-size:12px;line-height:1.7;color:#687084;margin:20px 0 0">このリンクはご本人専用です。第三者へ共有しないでください。<br>${escapeHtml(footer)}</p></div></div>`;
}

async function sendEmail({ to, subject, text, html, scheduledAt, idempotencyKey }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REGISTRATION_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error('Email environment variables are not configured');
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const payload = { from, to: [to], subject, text, html };
  if (scheduledAt) payload.scheduled_at = scheduledAt;
  const result = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(data.message || `Resend HTTP ${result.status}`);
  return data;
}

async function cancelEmail(emailId) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Email environment variables are not configured');
  const result = await fetch(`${RESEND_ENDPOINT}/${encodeURIComponent(emailId)}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!result.ok && result.status !== 404) {
    const data = await result.json().catch(() => ({}));
    throw new Error(data.message || `Resend HTTP ${result.status}`);
  }
}

function buildInitialEmail(token) {
  const url = `${PROGRAM_URL}progress.html#${new URLSearchParams({ token, start: '1' }).toString()}`;
  const paragraphs = [
    'ダイエットプログラムへの仮登録が完了しました。',
    '下のボタンを押すとプログラムが開始され、体重管理ページが作成されます。開始後もいつでも解約できます。'
  ];
  return {
    subject: '【TAZ】ダイエットプログラム仮登録完了',
    text: `${paragraphs.join('\n\n')}\n\nプログラムを開始する\n${url}`,
    html: emailFrame('仮登録が完了しました', paragraphs, 'プログラムを開始する', url, '開始ボタンを押すまでは定期メールは送信されません。')
  };
}

function buildMilestoneEmail(token, milestone) {
  const definition = MILESTONES[milestone];
  const url = progressUrl(token, milestone);
  return {
    subject: definition.subject,
    text: `${definition.heading}\n\n${definition.body}\n\n体重管理ページ\n${url}`,
    html: emailFrame(definition.heading, [definition.body], '体重を記録する', url, '専用ページからいつでもプログラムを解約できます。')
  };
}

function planAdvice(plan) {
  if (plan.includes('食べる時間')) return '食事時間の枠を守れなかった日より、守れた日の条件を一つ再現してみましょう。夜遅い食事を一回減らすだけでも再スタートになります。';
  if (plan.includes('筋肉')) return '体重だけでなく、たんぱく質と週2回の筋力運動を優先してください。急な減量より、筋肉を守りながら進むことがこのプランの狙いです。';
  if (plan.includes('地中海')) return '魚・豆・野菜・ナッツのうち、取り入れやすいものを一つ増やし、早歩きなどの活動を続けましょう。';
  if (plan.includes('短時間')) return 'まとまった時間を待たず、10分の運動か1日2,000歩の上乗せのどちらか一つを選んでください。';
  return 'ルールを増やさず、決めた一つだけを続けてください。できなかった日は記録を止めず、次の食事から戻れば十分です。';
}

function questionnaireAdvice(tags) {
  const values = new Set(String(tags || '').split(',').filter(Boolean));
  if (values.has('sleep_strong')) return 'アンケートでは睡眠不足が課題でした。まず就寝を30分早める日を増やし、食欲が強くなる時間帯に変化があるか見てください。';
  if (values.has('sleep_mild')) return 'アンケートでは睡眠がやや短めでした。運動や食事制限を増やす前に、睡眠時間を30分広げてみましょう。';
  if (values.has('drink')) return 'アンケートで甘い飲み物の習慣がありました。今月は一日一回だけ水か無糖飲料へ置き換えてください。';
  if (values.has('order')) return 'アンケート内容から、野菜やたんぱく質を先に、主食を最後にする食べ方を今月の重点にします。';
  if (values.has('steps')) return 'アンケート内容から、運動時間を増やすより普段の歩数を一日2,000歩上乗せする方法が向いています。';
  return 'アンケートで選んだプランの中から、今月も実行する行動を一つだけ決めてください。';
}

function progressComment(startWeight, targetWeight, currentWeight) {
  const requiredLoss = startWeight - targetWeight;
  const actualLoss = startWeight - currentWeight;
  if (requiredLoss <= 0 || currentWeight <= targetWeight) {
    return {
      key: 'achieved',
      heading: '目標体重に到達しました',
      body: 'おめでとうございます。ここからは減らし続けるより、現在の体重を大きく動かさないメンテナンスへ切り替えましょう。'
    };
  }
  const ratio = actualLoss / requiredLoss;
  if (ratio >= 0.75) return { key: 'near', heading: '目標まであと少しです', body: '開始時から十分な変化が出ています。ここで極端に制限を強めず、今できている行動を維持してください。' };
  if (ratio >= 0.25) return { key: 'progress', heading: '目標に向かって進んでいます', body: '体重は正しい方向へ動いています。短期の停滞に反応して方法を次々変えず、続けられている行動を残しましょう。' };
  if (actualLoss > 0) return { key: 'small', heading: '小さな変化を積み上げましょう', body: '減少幅はまだ小さいものの、開始時より前進しています。今月は行動目標を一つだけ具体化しましょう。' };
  return { key: 'reset', heading: 'ここから立て直せます', body: '体重が減っていなくても失敗ではありません。記録を再開したことが立て直しの第一歩です。実行しやすい行動を一つに絞りましょう。' };
}

function buildFeedbackEmail(profile, milestone) {
  const start = Number(profile.starting_weight);
  const target = Number(profile.target_weight);
  const current = Number(profile.current_weight);
  const comment = progressComment(start, target, current);
  const advice = planAdvice(profile.plan || '');
  const change = current - start;
  const changeText = `${change > 0 ? '+' : ''}${change.toFixed(1)} kg`;
  const goalDistance = Math.max(current - target, 0).toFixed(1);
  const milestoneLabel = MILESTONES[milestone]?.label || '継続チェック';
  const paragraphs = [
    `${milestoneLabel}の記録を受け付けました。現在 ${current.toFixed(1)} kg、開始時から ${changeText} です。`,
    comment.body,
    advice,
    questionnaireAdvice(profile.tags),
    current <= target ? '今後は週1回程度の記録を続け、急な増減がないか確認しましょう。' : `目標の ${target.toFixed(1)} kg まで、あと ${goalDistance} kg です。`
  ];
  const url = progressUrl(profile.access_token);
  return {
    subject: `【TAZ】${comment.heading}`,
    text: `${comment.heading}\n\n${paragraphs.join('\n\n')}\n\n体重管理ページ\n${url}`,
    html: emailFrame(comment.heading, paragraphs, '体重の推移を確認する', url, '体調不良や急激な体重変化がある場合は、医療機関へご相談ください。')
  };
}

function buildContinuationEmail(token, maintenance, milestone = 'continue_1') {
  const url = progressUrl(token, milestone);
  const heading = maintenance ? '体重メンテナンスの確認です' : '継続プログラムの体重確認です';
  const body = maintenance
    ? '目標達成後の体重を安定させる期間です。現在の体重を記録し、大きな変化がないか確認しましょう。'
    : '目標達成までプログラムを継続します。現在の体重を記録して、無理なく続けられる行動を確認しましょう。';
  return {
    subject: `【TAZ】${heading}`,
    text: `${heading}\n\n${body}\n\n${url}`,
    html: emailFrame(heading, [body], '体重を記録する', url, '専用ページからいつでもプログラムを終了できます。')
  };
}

module.exports = {
  MILESTONES,
  PROGRAM_URL,
  buildFeedbackEmail,
  buildContinuationEmail,
  buildInitialEmail,
  buildMilestoneEmail,
  cancelEmail,
  progressUrl,
  sendEmail
};

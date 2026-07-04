// Webhook Asaas do Clube da Escova
// Recebe eventos de pagamento das assinaturas, mantém clube_assinantes/clube_creditos
// no Supabase do salão (SuaVez) e envia o e-mail de boas-vindas no primeiro pagamento.

const PLANOS = {
  '197': { plano: '4x_curto_medio', teto: 4, rotulo: '4 escovas por mês · cabelo curto/médio', valor: 'R$ 197/mês' },
  '247': { plano: '4x_longo', teto: 4, rotulo: '4 escovas por mês · cabelo longo', valor: 'R$ 247/mês' },
  '347': { plano: '8x_curto_medio', teto: 8, rotulo: '8 escovas por mês · cabelo curto/médio', valor: 'R$ 347/mês' },
  '447': { plano: '8x_longo', teto: 8, rotulo: '8 escovas por mês · cabelo longo', valor: 'R$ 447/mês' },
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const token = request.headers.get('asaas-access-token');
  if (!env.ASAAS_WEBHOOK_TOKEN || token !== env.ASAAS_WEBHOOK_TOKEN) {
    return new Response('unauthorized', { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch { return new Response('bad request', { status: 400 }); }

  const event = body.event || '';
  const payment = body.payment || {};
  // Só interessa cobrança de assinatura
  if (!payment.subscription) return json({ ok: true, skip: 'nao-assinatura' });

  const chave = String(Math.round(payment.value || 0));
  const def = PLANOS[chave];
  if (!def) return json({ ok: true, skip: 'valor-fora-dos-planos', valor: payment.value });

  const sb = {
    url: env.SUAVEZ_URL,
    headers: {
      apikey: env.SUAVEZ_SERVICE_KEY,
      Authorization: `Bearer ${env.SUAVEZ_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  if (event === 'PAYMENT_OVERDUE') {
    await fetch(`${sb.url}/rest/v1/clube_assinantes?asaas_customer_id=eq.${payment.customer}`, {
      method: 'PATCH', headers: sb.headers,
      body: JSON.stringify({ status: 'inadimplente', updated_at: new Date().toISOString() }),
    });
    return json({ ok: true, acao: 'inadimplente' });
  }

  if (event !== 'PAYMENT_CONFIRMED' && event !== 'PAYMENT_RECEIVED') {
    return json({ ok: true, skip: event });
  }

  // Dados do cliente no Asaas
  const cliRes = await fetch(`https://api.asaas.com/v3/customers/${payment.customer}`, {
    headers: { access_token: env.ASAAS_KEY },
  });
  const cli = cliRes.ok ? await cliRes.json() : {};

  // Upsert do assinante
  const assinante = {
    asaas_customer_id: payment.customer,
    asaas_subscription_id: payment.subscription,
    nome: cli.name || null,
    cpf: cli.cpfCnpj || null,
    celular: cli.mobilePhone || cli.phone || null,
    email: cli.email || null,
    plano: def.plano,
    teto_mensal: def.teto,
    status: 'ativo',
    updated_at: new Date().toISOString(),
  };
  const upsertRes = await fetch(`${sb.url}/rest/v1/clube_assinantes?on_conflict=asaas_customer_id`, {
    method: 'POST',
    headers: { ...sb.headers, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(assinante),
  });
  const rows = await upsertRes.json();
  const reg = Array.isArray(rows) ? rows[0] : rows;
  if (!reg || !reg.id) return json({ ok: false, erro: 'upsert-falhou', detalhe: rows }, 500);

  // Créditos do mês da cobrança (não acumula: uma linha por competência)
  const competencia = (payment.paymentDate || payment.dueDate || new Date().toISOString()).slice(0, 7);
  await fetch(`${sb.url}/rest/v1/clube_creditos?on_conflict=assinante_id,competencia`, {
    method: 'POST',
    headers: { ...sb.headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ assinante_id: reg.id, competencia, creditos_total: def.teto }),
  });

  // E-mail de boas-vindas (só no primeiro pagamento)
  let emailEnviado = false;
  if (!reg.welcome_email_enviado && reg.email) {
    const primeiroNome = (reg.nome || 'Bem-vinda').split(' ')[0];
    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Clube da Escova · NP Hair Express <clube@nphairexpress.com.br>',
        to: [reg.email],
        subject: `${primeiroNome}, sua vaga no Clube da Escova está confirmada 🧡`,
        html: emailBoasVindas(primeiroNome, def),
      }),
    });
    if (mail.ok) {
      emailEnviado = true;
      await fetch(`${sb.url}/rest/v1/clube_assinantes?id=eq.${reg.id}`, {
        method: 'PATCH', headers: sb.headers,
        body: JSON.stringify({ welcome_email_enviado: true }),
      });
    }
  }

  return json({ ok: true, assinante: reg.id, competencia, emailEnviado });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function emailBoasVindas(nome, def) {
  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:0;background:#f5f2ec;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ec;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;">

  <tr><td style="background:#111111;padding:32px 40px;text-align:center;">
    <div style="font-size:26px;font-weight:bold;color:#ffffff;letter-spacing:1px;">NP HAIR <span style="color:#F7A100;">EXPRESS</span></div>
    <div style="color:#F7A100;font-size:13px;letter-spacing:3px;margin-top:6px;">CLUBE DA ESCOVA</div>
  </td></tr>

  <tr><td style="padding:40px 40px 8px;">
    <h1 style="margin:0;font-size:26px;color:#111111;">${nome}, sua vaga é sua. 🧡</h1>
    <p style="font-size:16px;line-height:1.6;color:#444444;margin:16px 0 0;">
      Assinatura confirmada! A partir de agora sua escova da semana já está paga —
      é só chegar e fazer. Sem marcar horário, sem abrir a carteira no balcão.
    </p>
  </td></tr>

  <tr><td style="padding:24px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff8e6;border:1px solid #ffdd85;border-radius:12px;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:12px;letter-spacing:2px;color:#b37300;font-weight:bold;">SEU PLANO</div>
        <div style="font-size:19px;color:#111111;font-weight:bold;margin-top:6px;">${def.rotulo}</div>
        <div style="font-size:15px;color:#b37300;margin-top:4px;font-weight:bold;">${def.valor} · renova automático no cartão</div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:8px 40px 8px;">
    <h2 style="font-size:17px;color:#111111;margin:0 0 12px;">Como usar (mais fácil impossível)</h2>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr><td style="padding:8px 0;font-size:15px;color:#444444;line-height:1.5;"><b style="color:#F7A100;">1.</b>&nbsp; Venha quando quiser, dentro do seu mês — não precisa agendar nada.</td></tr>
      <tr><td style="padding:8px 0;font-size:15px;color:#444444;line-height:1.5;"><b style="color:#F7A100;">2.</b>&nbsp; Na chegada, diga na recepção: <b>“sou do Clube”</b>. Pronto, você entra na fila digital e acompanha sua vez pelo celular.</td></tr>
      <tr><td style="padding:8px 0;font-size:15px;color:#444444;line-height:1.5;"><b style="color:#F7A100;">3.</b>&nbsp; Sente na cadeira e saia pronta em cerca de 40 minutos.</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:16px 40px 8px;">
    <h2 style="font-size:17px;color:#111111;margin:0 0 12px;">Combinados rápidos</h2>
    <p style="font-size:14px;line-height:1.7;color:#555555;margin:0;">
      • Suas escovas valem dentro do mês (não acumulam pro seguinte).<br>
      • O plano cobre a escova lisa — quer modelada? Só somar R$ 10 na comanda do dia.<br>
      • Pode usar duas no mesmo dia: compromisso de manhã, festa à noite.<br>
      • Sem fidelidade: cancela quando quiser.
    </p>
  </td></tr>

  <tr><td style="padding:28px 40px;" align="center">
    <a href="https://www.nphairexpress.com.br/clube/" style="display:inline-block;background:#F7A100;color:#111111;font-weight:bold;font-size:16px;text-decoration:none;padding:15px 36px;border-radius:99px;">Ver tudo sobre o Clube</a>
  </td></tr>

  <tr><td style="background:#111111;padding:24px 40px;text-align:center;">
    <div style="color:#ffffff;font-size:14px;font-weight:bold;">NP Hair Express</div>
    <div style="color:#999999;font-size:13px;margin-top:6px;line-height:1.6;">
      R. Sete de Setembro, 374 — Vila Henrique, Salto/SP<br>
      WhatsApp: (11) 98820-8754 · nphairexpress.com.br
    </div>
    <div style="color:#666666;font-size:11px;margin-top:12px;">NP Hair Express · julho/2026</div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

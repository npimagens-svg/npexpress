/**
 * Checkout transparente — Clube da Escova (NP Hair Express)
 * Cloudflare Pages Function: POST /api/assinar
 * Cria cliente + assinatura mensal (SÓ cartão de crédito) no Asaas.
 * Requer env ASAAS_KEY (chave de API do Asaas) no projeto Pages.
 * Nunca logar dados de cartão.
 */

const ASAAS_BASE = "https://api.asaas.com/v3";

export const PLANOS = {
  "4cm":   { valor: 197.0, descricao: "Clube da Escova — 4 escovas/mês (curto/médio)" },
  "4long": { valor: 247.0, descricao: "Clube da Escova — 4 escovas/mês (longo)" },
  "8cm":   { valor: 347.0, descricao: "Clube da Escova — 8 escovas/mês (curto/médio)" },
  "8long": { valor: 447.0, descricao: "Clube da Escova — 8 escovas/mês (longo)" }
};

export class ErroValidacao extends Error {}

// Serviço presencial: o Asaas exige CEP + número no cartão, mas a cliente não
// precisa digitar — cobrança referenciada no endereço do salão.
export const CEP_SALAO = "13320040"; // R. 7 de Setembro, 374 — Centro, Salto/SP
export const NUMERO_SALAO = "374";

const soDigitos = (v) => String(v == null ? "" : v).replace(/\D/g, "");

/** Data de hoje (YYYY-MM-DD) no fuso America/Sao_Paulo. */
export function hojeSaoPaulo(agora) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(agora || new Date());
}

/**
 * Função pura: valida a entrada e monta os payloads pro Asaas.
 * Retorna { plano, valor, cpf, customer, subscription }.
 * `subscription` vem SEM `customer` e SEM `remoteIp` — são adicionados na hora da chamada.
 * Lança ErroValidacao com mensagem em pt-BR se algo estiver errado.
 */
export function montarPayloads(input) {
  if (!input || typeof input !== "object") {
    throw new ErroValidacao("Dados do formulário não recebidos.");
  }

  const plano = PLANOS[input.plano];
  if (!plano) throw new ErroValidacao("Plano inválido.");

  const nome = String(input.nome || "").trim();
  if (nome.length < 5 || !nome.includes(" ")) {
    throw new ErroValidacao("Informe seu nome completo.");
  }

  const cpf = soDigitos(input.cpf);
  if (cpf.length !== 11) throw new ErroValidacao("CPF inválido — confira os 11 dígitos.");

  const email = String(input.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroValidacao("E-mail inválido.");

  const celular = soDigitos(input.celular);
  if (celular.length < 10 || celular.length > 11) {
    throw new ErroValidacao("Celular inválido — use o número com DDD.");
  }

  // CEP/número são opcionais no form — caem no endereço do salão
  let cep = soDigitos(input.cep);
  if (cep.length !== 8) cep = CEP_SALAO;
  const numeroEndereco = String(input.numeroEndereco || "").trim() || NUMERO_SALAO;

  const cartao = input.cartao || {};
  const numeroCartao = soDigitos(cartao.numero);
  if (numeroCartao.length < 13 || numeroCartao.length > 19) {
    throw new ErroValidacao("Número do cartão inválido.");
  }

  const nomeTitular = String(cartao.nomeTitular || "").trim();
  if (nomeTitular.length < 2) throw new ErroValidacao("Informe o nome impresso no cartão.");

  const mes = soDigitos(cartao.mesValidade);
  const mesNum = parseInt(mes, 10);
  if (!mesNum || mesNum < 1 || mesNum > 12) {
    throw new ErroValidacao("Mês de validade do cartão inválido.");
  }
  const mesValidade = String(mesNum).padStart(2, "0");

  let anoValidade = soDigitos(cartao.anoValidade);
  if (anoValidade.length === 2) anoValidade = "20" + anoValidade;
  if (anoValidade.length !== 4) throw new ErroValidacao("Ano de validade do cartão inválido.");

  const ccv = soDigitos(cartao.ccv);
  if (ccv.length < 3 || ccv.length > 4) throw new ErroValidacao("Código de segurança (CVV) inválido.");

  return {
    plano: input.plano,
    valor: plano.valor,
    cpf: cpf,
    customer: {
      name: nome,
      cpfCnpj: cpf,
      email: email,
      mobilePhone: celular
    },
    subscription: {
      billingType: "CREDIT_CARD",
      value: plano.valor,
      nextDueDate: hojeSaoPaulo(),
      cycle: "MONTHLY",
      description: plano.descricao,
      creditCard: {
        holderName: nomeTitular,
        number: numeroCartao,
        expiryMonth: mesValidade,
        expiryYear: anoValidade,
        ccv: ccv
      },
      creditCardHolderInfo: {
        name: nome,
        email: email,
        cpfCnpj: cpf,
        postalCode: cep,
        addressNumber: numeroEndereco,
        mobilePhone: celular
      }
    }
  };
}

/* Mensagens amigáveis pra códigos de erro conhecidos do Asaas. */
const ERROS_ASAAS = {
  invalid_creditCard:
    "Cartão recusado. Confira o número, a validade e o CVV — ou tente outro cartão.",
  invalid_billingType: "Forma de pagamento não aceita. O Clube funciona só com cartão de crédito.",
  invalid_cpfCnpj: "CPF inválido — confira os números e tente de novo.",
  invalid_value: "Valor do plano inválido. Recarregue a página e tente de novo.",
  invalid_dueDate: "Não foi possível iniciar a assinatura hoje. Tente de novo em instantes.",
  invalid_customer: "Não foi possível validar seus dados. Confira nome, CPF e e-mail."
};

function mensagemErroAsaas(corpo) {
  const erros = corpo && Array.isArray(corpo.errors) ? corpo.errors : [];
  for (const e of erros) {
    if (e && e.code && ERROS_ASAAS[e.code]) return ERROS_ASAAS[e.code];
  }
  const desc = erros.length && erros[0] && erros[0].description;
  if (desc) return String(desc);
  return "Não conseguimos concluir sua assinatura agora. Tente de novo ou chame a gente no WhatsApp.";
}

function json(status, corpo) {
  return new Response(JSON.stringify(corpo), {
    status: status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function asaas(env, metodo, caminho, corpo) {
  const res = await fetch(ASAAS_BASE + caminho, {
    method: metodo,
    headers: {
      "Content-Type": "application/json",
      "access_token": env.ASAAS_KEY,
      "User-Agent": "npexpress-clube"
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  let dados = null;
  try {
    dados = await res.json();
  } catch (_) {
    dados = null;
  }
  return { ok: res.ok, status: res.status, dados: dados };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ASAAS_KEY) {
    return json(500, { ok: false, erro: "Pagamento temporariamente indisponível. Tente de novo mais tarde." });
  }

  let entrada;
  try {
    entrada = await request.json();
  } catch (_) {
    return json(400, { ok: false, erro: "Requisição inválida." });
  }

  let payloads;
  try {
    payloads = montarPayloads(entrada);
  } catch (e) {
    if (e instanceof ErroValidacao) return json(400, { ok: false, erro: e.message });
    return json(400, { ok: false, erro: "Dados inválidos. Confira o formulário e tente de novo." });
  }

  try {
    // (a) procura cliente existente pelo CPF
    let customerId = null;
    const busca = await asaas(env, "GET", "/customers?cpfCnpj=" + encodeURIComponent(payloads.cpf));
    if (busca.ok && busca.dados && Array.isArray(busca.dados.data) && busca.dados.data.length > 0) {
      customerId = busca.dados.data[0].id;
    }

    // (b) cria cliente se não existir
    if (!customerId) {
      const criacao = await asaas(env, "POST", "/customers", payloads.customer);
      if (!criacao.ok || !criacao.dados || !criacao.dados.id) {
        return json(422, { ok: false, erro: mensagemErroAsaas(criacao.dados) });
      }
      customerId = criacao.dados.id;
    } else {
      // Cliente já existia no Asaas (fila online, cobrança avulsa antiga...) e pode
      // estar com telefone velho. O webhook copia o mobilePhone do Asaas pro
      // clube_assinantes, e é por esse número que a fila "Sou do Clube" e o
      // trigger da comanda reconhecem a assinante — telefone errado = assinatura
      // que não funciona no salão (aconteceu em 05/09: veio um fixo).
      // Atualiza com o que ela acabou de digitar. Best-effort: não bloqueia a venda.
      await asaas(env, "POST", "/customers/" + customerId, payloads.customer);
    }

    // (c) cria a assinatura com cartão
    const assinatura = await asaas(env, "POST", "/subscriptions", {
      ...payloads.subscription,
      customer: customerId,
      remoteIp: request.headers.get("CF-Connecting-IP") || ""
    });

    if (!assinatura.ok || !assinatura.dados || !assinatura.dados.id) {
      return json(422, { ok: false, erro: mensagemErroAsaas(assinatura.dados) });
    }

    return json(200, { ok: true, id: assinatura.dados.id });
  } catch (_) {
    // nunca logar payloads (contêm dados de cartão)
    return json(502, {
      ok: false,
      erro: "Falha de comunicação com o meio de pagamento. Tente de novo em instantes."
    });
  }
}

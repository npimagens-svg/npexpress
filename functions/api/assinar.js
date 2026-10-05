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

/* ------------------------------------------------------------------------
 * Proteção contra assinatura duplicada (05/10/2026, caso de 30/09 + 01/10:
 * mesma cliente assinou 2x com CPF e cartão diferentes, mesmo celular e
 * mesmo e-mail, e ficou com 2 cobranças mensais).
 *
 * Antes de criar qualquer coisa no Asaas, procura assinatura ATIVA do Clube
 * da mesma pessoa por CPF, e-mail e telefone (8 últimos dígitos, igual ao
 * motor do salão). Achou: não cria nada e devolve `ja_tem_assinatura` com um
 * token opaco. Só cria se o front reenviar com `confirmar_segundo_pacote`
 * igual a esse token (a cliente escolheu "Sim, quero mais um pacote").
 *
 * A resposta NÃO diz plano, data, nome nem qual dado bateu: o endpoint é
 * público e não pode virar consulta de dados de terceiros por telefone.
 * Inadimplente no salão = assinatura ACTIVE no Asaas com cobrança vencida,
 * então também conta. Cancelada = INACTIVE/removida, não conta.
 * ---------------------------------------------------------------------- */

const VALORES_CLUBE = new Set(Object.values(PLANOS).map((p) => p.valor));
const MAX_CLIENTES_CONFERIDOS = 10; // teto de chamadas (Pages: 50 subrequests por request)

export class ErroConsulta extends Error {}

/** Telefone BR -> { oito, onze, dez } ou null. Aceita máscara, +55/55 e com/sem nono dígito. */
export function normalizarTelefone(valor) {
  let d = soDigitos(valor);
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1); // 0 + DDD + fixo
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = d.slice(0, 2);
  const numero = d.slice(2);
  let onze = null;
  let dez = null;
  if (numero.length === 9) {
    onze = d;
    dez = ddd + numero.slice(1);
  } else if (/^[6-9]/.test(numero)) {
    onze = ddd + "9" + numero; // celular antigo sem o nono dígito
    dez = d;
  } else {
    dez = d; // fixo
  }
  return { oito: d.slice(-8), onze: onze, dez: dez };
}

function ehAssinaturaDoClube(s) {
  if (!s || s.status !== "ACTIVE" || s.deleted) return false;
  if (String(s.description || "").indexOf("Clube da Escova") === 0) return true;
  return VALORES_CLUBE.has(Number(s.value));
}

async function listaAsaas(env, caminho) {
  const r = await asaas(env, "GET", caminho);
  if (!r.ok || !r.dados || !Array.isArray(r.dados.data)) {
    throw new ErroConsulta("consulta " + r.status);
  }
  return r.dados.data;
}

async function tokenConfirmacao(env, ids) {
  const enc = new TextEncoder();
  const chave = await crypto.subtle.importKey(
    "raw", enc.encode(String(env.ASAAS_KEY)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const assinatura = await crypto.subtle.sign("HMAC", chave, enc.encode("segundo-pacote|" + ids.join(",")));
  return Array.from(new Uint8Array(assinatura).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Procura assinatura ativa do Clube da mesma pessoa. Só faz GET.
 * Retorna { ids: [ids das assinaturas achadas], customerIdPorCpf }.
 * Lança ErroConsulta se o Asaas não responder direito (quem chama decide).
 */
export async function procurarAssinaturaExistente(env, payloads) {
  const cpf = payloads.cpf;
  const email = String(payloads.customer.email || "").trim().toLowerCase();
  const tel = normalizarTelefone(payloads.customer.mobilePhone);

  const consultas = [listaAsaas(env, "/customers?limit=10&cpfCnpj=" + encodeURIComponent(cpf))];
  consultas.push(listaAsaas(env, "/customers?limit=20&email=" + encodeURIComponent(email)));
  const formas = tel ? [tel.onze, tel.dez].filter(Boolean) : [];
  for (const f of formas) {
    consultas.push(listaAsaas(env, "/customers?limit=20&mobilePhone=" + encodeURIComponent(f)));
  }
  const [porCpf, porEmail, ...porTelefone] = await Promise.all(consultas);

  // Conferência local: o filtro do Asaas é só o primeiro corte.
  const candidatos = new Map();
  const add = (c) => { if (c && c.id && !candidatos.has(c.id)) candidatos.set(c.id, c); };
  porCpf.filter((c) => soDigitos(c.cpfCnpj) === cpf).forEach(add);
  porEmail.filter((c) => String(c.email || "").trim().toLowerCase() === email).forEach(add);
  if (tel) {
    porTelefone.flat().filter((c) =>
      soDigitos(c.mobilePhone).slice(-8) === tel.oito || soDigitos(c.phone).slice(-8) === tel.oito
    ).forEach(add);
  }

  const customerIdPorCpf = porCpf.length > 0 ? porCpf[0].id : null;
  const ids = Array.from(candidatos.keys()).slice(0, MAX_CLIENTES_CONFERIDOS);
  const listas = await Promise.all(
    ids.map((id) => listaAsaas(env, "/subscriptions?status=ACTIVE&limit=50&customer=" + encodeURIComponent(id)))
  );
  const achadas = listas.flat().filter(ehAssinaturaDoClube).map((s) => s.id).sort();
  return { ids: Array.from(new Set(achadas)), customerIdPorCpf: customerIdPorCpf };
}

/* Duplo envio (duplo clique, reenvio): trava por pessoa+plano+cartão enquanto
 * a criação está em andamento e por 2 minutos depois de criada. Vale dentro da
 * mesma instância; entre instâncias, o token de confirmação acima já barra a
 * segunda (a primeira criada muda o conjunto de assinaturas e o token). */
const TRAVA_MS = 2 * 60 * 1000;
const travas = new Map();
export function _limparTravas() { travas.clear(); }

function chaveTrava(payloads) {
  const tel = normalizarTelefone(payloads.customer.mobilePhone);
  return [payloads.cpf, tel ? tel.oito : "", payloads.plano,
    payloads.subscription.creditCard.number.slice(-4)].join("|");
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

  const trava = chaveTrava(payloads);
  const agora = Date.now();
  const travada = travas.get(trava);
  if (travada && (travada.emAndamento || agora - travada.em < TRAVA_MS)) {
    return json(409, {
      ok: false,
      erro: "Já recebemos seu pedido e ele está sendo processado. Aguarde um instante antes de tentar de novo."
    });
  }
  travas.set(trava, { emAndamento: true, em: agora });
  let criou = false;

  try {
    // (0) já existe assinatura ativa do Clube dessa pessoa?
    let existente;
    try {
      existente = await procurarAssinaturaExistente(env, payloads);
    } catch (_) {
      // Falha fechada: sem conseguir conferir, não cobra. Venda perdida se
      // recupera (o lead do passo 1 já chegou por e-mail); cobrança dupla vira
      // estorno, chargeback e cliente brava.
      return json(503, {
        ok: false,
        erro: "Não conseguimos conferir seus dados agora. Tente de novo em instantes ou chame a gente no WhatsApp."
      });
    }

    if (existente.ids.length > 0) {
      const token = await tokenConfirmacao(env, existente.ids);
      if (entrada.confirmar_segundo_pacote !== token) {
        return json(409, { ok: false, ja_tem_assinatura: true, confirmacao: token });
      }
    }

    // (a) cliente existente pelo CPF (mesma regra de antes)
    let customerId = existente.customerIdPorCpf;

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

    criou = true;
    return json(200, { ok: true, id: assinatura.dados.id });
  } catch (_) {
    // nunca logar payloads (contêm dados de cartão)
    return json(502, {
      ok: false,
      erro: "Falha de comunicação com o meio de pagamento. Tente de novo em instantes."
    });
  } finally {
    // Criou: segura 2 min. Não criou (recusa, aviso, erro): libera na hora.
    if (criou) travas.set(trava, { emAndamento: false, em: Date.now() });
    else travas.delete(trava);
  }
}

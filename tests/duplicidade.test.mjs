/**
 * Proteção contra assinatura duplicada no /api/assinar (sem chamar o Asaas de verdade).
 * O fetch é trocado por um Asaas falso em memória que imita o que foi medido na
 * conta real em 05/10/2026: filtro `mobilePhone` acha com 11 e com 10 dígitos,
 * não acha com 55 na frente nem só com 8 dígitos.
 * Rodar: node tests/duplicidade.test.mjs
 */
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "assinar-dup-"));
copyFileSync(join(raiz, "functions/api/assinar.js"), join(tmp, "assinar.mjs"));
const mod = await import(pathToFileURL(join(tmp, "assinar.mjs")).href);
const { onRequestPost, normalizarTelefone, _limparTravas } = mod;

const env = { ASAAS_KEY: "chave-de-teste" };
const dig = (v) => String(v || "").replace(/\D/g, "");

/* ---------------- Asaas falso ---------------- */
function asaasFalso(estado, opcoes = {}) {
  const chamadas = [];
  let seq = 0;
  const lento = opcoes.lento || 0;
  const responder = (status, corpo) =>
    new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
  const fone10 = (d) => (d.length === 11 ? d.slice(0, 2) + d.slice(3) : d);

  globalThis.fetch = async (url, init = {}) => {
    const metodo = (init.method || "GET").toUpperCase();
    const u = new URL(url);
    const caminho = u.pathname.replace(/^\/v3/, "");
    chamadas.push({ metodo, caminho, busca: u.search });
    if (opcoes.falhaRede) throw new TypeError("fetch failed");
    if (metodo === "GET" && opcoes.statusGet) return responder(opcoes.statusGet, { errors: [{ code: "x" }] });
    if (lento) await new Promise((r) => setTimeout(r, lento));

    if (metodo === "GET" && caminho === "/customers") {
      const q = u.searchParams;
      let lista = estado.customers;
      if (q.get("cpfCnpj")) lista = lista.filter((c) => dig(c.cpfCnpj) === q.get("cpfCnpj"));
      if (q.get("email")) lista = lista.filter((c) => (c.email || "").toLowerCase() === q.get("email").toLowerCase());
      if (q.get("mobilePhone")) {
        const f = dig(q.get("mobilePhone"));
        lista = lista.filter((c) => {
          const m = dig(c.mobilePhone);
          return m === f || fone10(m) === f;
        });
      }
      return responder(200, { totalCount: lista.length, data: lista });
    }
    if (metodo === "GET" && caminho === "/subscriptions") {
      const q = u.searchParams;
      let lista = estado.subscriptions.filter((s) => !s.deleted);
      if (q.get("customer")) lista = lista.filter((s) => s.customer === q.get("customer"));
      if (q.get("status")) lista = lista.filter((s) => s.status === q.get("status"));
      return responder(200, { totalCount: lista.length, data: lista });
    }
    if (metodo === "POST" && caminho === "/customers") {
      const corpo = JSON.parse(init.body);
      const c = { id: "cus_" + ++seq, ...corpo };
      estado.customers.push(c);
      return responder(200, c);
    }
    if (metodo === "POST" && caminho.startsWith("/customers/")) {
      return responder(200, { id: caminho.split("/")[2] });
    }
    if (metodo === "POST" && caminho === "/subscriptions") {
      const corpo = JSON.parse(init.body);
      const s = { id: "sub_" + ++seq, status: "ACTIVE", customer: corpo.customer, value: corpo.value, description: corpo.description };
      estado.subscriptions.push(s);
      return responder(200, s);
    }
    return responder(404, { errors: [{ code: "not_found" }] });
  };
  return chamadas;
}

const criacoes = (chamadas) => chamadas.filter((c) => c.metodo !== "GET");
const criouAssinatura = (chamadas) => chamadas.filter((c) => c.metodo === "POST" && c.caminho === "/subscriptions").length;

function req(corpo) {
  return {
    request: new Request("https://www.nphairexpress.com.br/api/assinar", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "200.1.2.3" },
      body: JSON.stringify(corpo)
    }),
    env
  };
}

async function chamar(corpo) {
  const r = await onRequestPost(req(corpo));
  return { status: r.status, corpo: await r.json() };
}

// Entrada típica do checkout (dados fictícios)
const entrada = (extra = {}) => ({
  plano: "4cm",
  nome: "Cliente Teste Silva",
  cpf: "390.533.447-05",
  email: "cliente.nova@exemplo.com",
  celular: "(11) 91111-2222",
  cartao: { numero: "4111 1111 1111 1111", nomeTitular: "CLIENTE T SILVA", mesValidade: "12", anoValidade: "30", ccv: "123" },
  ...extra
});

// Assinante que já existe: celular gravado no Asaas com 11 dígitos
const estadoComAssinante = (statusSub = "ACTIVE", extraSub = {}) => ({
  customers: [{ id: "cus_ex", name: "Assinante Antiga", cpfCnpj: "11144477735", email: "assinante@exemplo.com", mobilePhone: "11987654321" }],
  subscriptions: [{ id: "sub_ex", customer: "cus_ex", status: statusSub, value: 197, description: "Clube da Escova — 4 escovas/mês (curto/médio)", ...extraSub }]
});

let n = 0;
const ok = (nome) => console.log("ok " + ++n + " — " + nome);

/* ---------------- casos ---------------- */

// normalização
assert.deepEqual(normalizarTelefone("(11) 98765-4321"), { oito: "87654321", onze: "11987654321", dez: "1187654321" });
assert.deepEqual(normalizarTelefone("+55 11 98765-4321"), { oito: "87654321", onze: "11987654321", dez: "1187654321" });
assert.deepEqual(normalizarTelefone("1187654321"), { oito: "87654321", onze: "11987654321", dez: "1187654321" });
assert.equal(normalizarTelefone("123"), null);
ok("normalização de telefone (máscara, +55, sem nono dígito)");

// 1. telefone novo segue normal
_limparTravas();
{
  const estado = estadoComAssinante();
  const ch = asaasFalso(estado);
  const r = await chamar(entrada());
  assert.equal(r.status, 200);
  assert.equal(r.corpo.ok, true);
  assert.equal(criouAssinatura(ch), 1);
  assert.ok(ch.filter((c) => c.metodo === "GET").length <= 8, "consultas demais");
  ok("telefone novo: cria normalmente (1 assinatura)");
}

// 2. mesmo telefone em vários formatos, com CPF e e-mail diferentes: aviso e nada criado
// (com 55 na frente o montarPayloads já recusa antes, por isso o 55 está só no teste de normalização)
for (const fmt of ["(11) 98765-4321", "11987654321", "11 98765 4321", "1187654321", "(11) 8765-4321", "11-98765-4321"]) {
  _limparTravas();
  const ch = asaasFalso(estadoComAssinante());
  const r = await chamar(entrada({ celular: fmt }));
  assert.equal(r.status, 409, fmt);
  assert.equal(r.corpo.ja_tem_assinatura, true, fmt);
  assert.match(r.corpo.confirmacao, /^[0-9a-f]{32}$/);
  assert.equal(criacoes(ch).length, 0, "não pode haver POST no Asaas: " + fmt);
}
ok("mesmo telefone em 6 formatos: devolve aviso e zero POST no Asaas");

// 3. a resposta do aviso não vaza dado nenhum
{
  _limparTravas();
  asaasFalso(estadoComAssinante());
  const r = await chamar(entrada({ celular: "11987654321" }));
  assert.deepEqual(Object.keys(r.corpo).sort(), ["confirmacao", "ja_tem_assinatura", "ok"]);
  const texto = JSON.stringify(r.corpo);
  for (const proibido of ["Assinante", "11144477735", "assinante@", "87654321", "197", "Clube", "cus_ex", "sub_ex"]) {
    assert.ok(!texto.includes(proibido), "vazou: " + proibido);
  }
  ok("resposta do aviso só tem ok/ja_tem_assinatura/confirmacao (sem nome, CPF, e-mail, telefone, plano, ids)");
}

// 4. mesmo telefone + confirmação explícita: cria
{
  _limparTravas();
  const estado = estadoComAssinante();
  asaasFalso(estado);
  const aviso = await chamar(entrada({ celular: "11987654321" }));
  const ch = asaasFalso(estado);
  const r = await chamar(entrada({ celular: "11987654321", confirmar_segundo_pacote: aviso.corpo.confirmacao }));
  assert.equal(r.status, 200);
  assert.equal(criouAssinatura(ch), 1);
  assert.equal(estado.subscriptions.filter((s) => s.status === "ACTIVE").length, 2);
  ok("mesmo telefone + 'Sim, quero mais um pacote' (token): cria a segunda");
}

// 5. sinal forjado (true, token errado) não cria
for (const forjado of [true, "true", "0".repeat(32)]) {
  _limparTravas();
  const ch = asaasFalso(estadoComAssinante());
  const r = await chamar(entrada({ celular: "11987654321", confirmar_segundo_pacote: forjado }));
  assert.equal(r.status, 409);
  assert.equal(criacoes(ch).length, 0);
}
ok("confirmação forjada (true / token errado): não cria");

// 6. mesmo CPF sem assinatura ativa: comportamento antigo (reaproveita customer, atualiza telefone)
{
  _limparTravas();
  const estado = estadoComAssinante("INACTIVE");
  const ch = asaasFalso(estado);
  const r = await chamar(entrada({ cpf: "111.444.777-35" }));
  assert.equal(r.status, 200);
  assert.equal(ch.filter((c) => c.metodo === "POST" && c.caminho === "/customers").length, 0, "não cria customer novo");
  assert.equal(ch.filter((c) => c.metodo === "POST" && c.caminho === "/customers/cus_ex").length, 1, "atualiza o customer do CPF");
  assert.equal(estado.subscriptions.at(-1).customer, "cus_ex");
  ok("mesmo CPF sem assinatura ativa: reaproveita o customer como antes");
}

// 7. mesmo CPF com assinatura ativa: aviso
{
  _limparTravas();
  const ch = asaasFalso(estadoComAssinante());
  const r = await chamar(entrada({ cpf: "111.444.777-35" }));
  assert.equal(r.status, 409);
  assert.equal(criacoes(ch).length, 0);
  ok("mesmo CPF com assinatura ativa: aviso");
}

// 8. mesmo e-mail (telefone e CPF diferentes): aviso
{
  _limparTravas();
  const ch = asaasFalso(estadoComAssinante());
  const r = await chamar(entrada({ email: "ASSINANTE@exemplo.com" }));
  assert.equal(r.status, 409);
  assert.equal(criacoes(ch).length, 0);
  ok("mesmo e-mail (maiúsculas diferentes): aviso");
}

// 9. cancelada não dispara aviso (INACTIVE, EXPIRED, removida)
for (const [status, extra] of [["INACTIVE", {}], ["EXPIRED", {}], ["ACTIVE", { deleted: true }]]) {
  _limparTravas();
  const ch = asaasFalso(estadoComAssinante(status, extra));
  const r = await chamar(entrada({ celular: "11987654321" }));
  assert.equal(r.status, 200, status);
  assert.equal(criouAssinatura(ch), 1);
}
ok("assinatura cancelada/expirada/removida: segue normal");

// 10. inadimplente (no Asaas continua ACTIVE com cobrança vencida): aviso
{
  _limparTravas();
  const ch = asaasFalso(estadoComAssinante("ACTIVE"));
  const r = await chamar(entrada({ celular: "11987654321" }));
  assert.equal(r.status, 409);
  assert.equal(criacoes(ch).length, 0);
  ok("inadimplente (ACTIVE com cobrança vencida): aviso");
}

// 11. pacote de unha/esmaltação no mesmo telefone não é Clube: segue normal
for (const [valor, desc] of [[237, "ASSINATURA DE UNHA MENSAL - NÃO ACUMULATIVO"], [148, "ASSINATURA DE ESMALTAÇÃO MENSAL - 4 esmaltações/mês"]]) {
  _limparTravas();
  const ch = asaasFalso(estadoComAssinante("ACTIVE", { value: valor, description: desc }));
  const r = await chamar(entrada({ celular: "11987654321" }));
  assert.equal(r.status, 200, desc);
  assert.equal(criouAssinatura(ch), 1);
}
ok("assinatura ativa de unha (237) ou esmaltação (148): não conta como Clube");

// 12. duplo envio simultâneo (cliente nova): só 1 assinatura
{
  _limparTravas();
  const estado = { customers: [], subscriptions: [] };
  const ch = asaasFalso(estado, { lento: 30 });
  const [a, b] = await Promise.all([chamar(entrada()), chamar(entrada())]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(criouAssinatura(ch), 1);
  ok("duplo clique simultâneo: 1 criada, a outra recebe 409");
}

// 13. reenvio logo depois de criar (recarregar e mandar de novo): não cria segunda
{
  _limparTravas();
  const estado = { customers: [], subscriptions: [] };
  const ch = asaasFalso(estado);
  const a = await chamar(entrada());
  const b = await chamar(entrada());
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal(criouAssinatura(ch), 1);
  // e em outra instância (sem a trava em memória): cai no aviso de assinatura existente
  _limparTravas();
  const c = await chamar(entrada());
  assert.equal(c.status, 409);
  assert.equal(c.corpo.ja_tem_assinatura, true);
  assert.equal(criouAssinatura(ch), 1);
  ok("reenvio logo após criar: barrado pela trava e, em outra instância, pelo aviso");
}

// 14. duplo clique no "Sim, quero mais um pacote": só 1 a mais
{
  _limparTravas();
  const estado = estadoComAssinante();
  asaasFalso(estado);
  const aviso = await chamar(entrada({ celular: "11987654321" }));
  const ch = asaasFalso(estado, { lento: 30 });
  const conf = entrada({ celular: "11987654321", confirmar_segundo_pacote: aviso.corpo.confirmacao });
  const [a, b] = await Promise.all([chamar(conf), chamar(conf)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(criouAssinatura(ch), 1);
  // mesmo token reaproveitado em outra instância depois: o conjunto mudou, token não vale mais
  _limparTravas();
  const c = await chamar(conf);
  assert.equal(c.status, 409);
  assert.equal(c.corpo.ja_tem_assinatura, true);
  assert.equal(criouAssinatura(ch), 1);
  ok("duplo clique na confirmação: 1 a mais só; token velho não cria terceira");
}

// 15. falha na consulta (Asaas fora / 500 / 429): barra, sem POST
for (const op of [{ statusGet: 500 }, { statusGet: 429 }, { statusGet: 401 }, { falhaRede: true }]) {
  _limparTravas();
  const ch = asaasFalso({ customers: [], subscriptions: [] }, op);
  const r = await chamar(entrada());
  assert.equal(r.status, 503, JSON.stringify(op));
  assert.equal(r.corpo.ok, false);
  assert.match(r.corpo.erro, /conferir seus dados/);
  assert.equal(criacoes(ch).length, 0);
}
// e depois da falha a trava é liberada: nova tentativa passa
{
  const ch = asaasFalso({ customers: [], subscriptions: [] });
  const r = await chamar(entrada());
  assert.equal(r.status, 200);
  assert.equal(criouAssinatura(ch), 1);
}
ok("falha na consulta (500, 429, 401, rede): 503 sem POST; nova tentativa depois passa");

// 16. recusa do cartão libera a trava (cliente pode corrigir e tentar de novo)
{
  _limparTravas();
  const estado = { customers: [], subscriptions: [] };
  asaasFalso(estado);
  const original = globalThis.fetch;
  let recusou = false;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || "GET") === "POST" && String(url).endsWith("/subscriptions") && !recusou) {
      recusou = true;
      return new Response(JSON.stringify({ errors: [{ code: "invalid_creditCard" }] }), { status: 400 });
    }
    return original(url, init);
  };
  const a = await chamar(entrada());
  const b = await chamar(entrada());
  assert.equal(a.status, 422);
  assert.equal(b.status, 200);
  ok("cartão recusado libera a trava: segunda tentativa cria");
}

console.log("\nTODOS OS TESTES DE DUPLICIDADE PASSARAM (" + n + " grupos)");

/**
 * Teste da lógica pura de montagem de payloads do checkout (sem chamar o Asaas).
 * Rodar: node tests/montar-payloads.test.mjs
 */
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// assinar.js é ESM (Pages Functions); copia como .mjs pra importar sem package.json
const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "assinar-"));
copyFileSync(join(raiz, "functions/api/assinar.js"), join(tmp, "assinar.mjs"));
const { montarPayloads, PLANOS, hojeSaoPaulo, ErroValidacao } = await import(
  pathToFileURL(join(tmp, "assinar.mjs")).href
);

const base = {
  nome: "Maria da Silva",
  cpf: "123.456.789-09",
  email: "maria@email.com",
  celular: "(11) 99999-8888",
  cep: "13320-000",
  numeroEndereco: "374",
  cartao: {
    numero: "5162 3062 1937 8829",
    nomeTitular: "MARIA D SILVA",
    mesValidade: "05",
    anoValidade: "28",
    ccv: "318"
  }
};

let ok = 0;

// Caso 1 — payload correto por plano (valores e descrições)
const esperado = {
  "4cm": [197.0, "Clube da Escova — 4 escovas/mês (curto/médio)"],
  "4long": [247.0, "Clube da Escova — 4 escovas/mês (longo)"],
  "8cm": [347.0, "Clube da Escova — 8 escovas/mês (curto/médio)"],
  "8long": [447.0, "Clube da Escova — 8 escovas/mês (longo)"]
};
for (const [plano, [valor, descricao]] of Object.entries(esperado)) {
  const p = montarPayloads({ ...base, plano });
  assert.equal(p.valor, valor, plano + ": valor");
  assert.equal(p.subscription.value, valor, plano + ": subscription.value");
  assert.equal(p.subscription.description, descricao, plano + ": descricao");
  assert.equal(p.subscription.billingType, "CREDIT_CARD", plano + ": billingType");
  assert.equal(p.subscription.cycle, "MONTHLY", plano + ": cycle");
  assert.equal(p.customer.name, "Maria da Silva");
  assert.equal(p.subscription.creditCard.holderName, "MARIA D SILVA");
  assert.equal(p.subscription.creditCard.expiryMonth, "05");
  assert.equal(p.subscription.creditCard.expiryYear, "2028", plano + ": ano 2 dígitos vira 20xx");
  assert.equal(p.subscription.creditCard.number, "5162306219378829", plano + ": cartão sem espaços");
  assert.equal(p.subscription.creditCardHolderInfo.postalCode, "13320000");
  assert.equal(p.subscription.creditCardHolderInfo.addressNumber, "374");
  assert.equal(PLANOS[plano].valor, valor);
}
ok++;
console.log("ok 1 — payloads corretos pros 4 planos (valor, descrição, cartão, holderInfo)");

// Caso 2 — CPF/celular limpos de máscara
const p2 = montarPayloads({ ...base, plano: "4cm" });
assert.equal(p2.cpf, "12345678909");
assert.equal(p2.customer.cpfCnpj, "12345678909");
assert.equal(p2.customer.mobilePhone, "11999998888");
assert.equal(p2.subscription.creditCardHolderInfo.cpfCnpj, "12345678909");
ok++;
console.log("ok 2 — CPF e celular limpos de máscara em customer e holderInfo");

// Caso 3 — nextDueDate = hoje em America/Sao_Paulo, formato YYYY-MM-DD
const p3 = montarPayloads({ ...base, plano: "8long" });
assert.match(p3.subscription.nextDueDate, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(p3.subscription.nextDueDate, hojeSaoPaulo());
// fuso: meia-noite UTC de 2026-01-02 ainda é 2026-01-01 em São Paulo
assert.equal(hojeSaoPaulo(new Date("2026-01-02T01:00:00Z")), "2026-01-01");
ok++;
console.log("ok 3 — nextDueDate YYYY-MM-DD no fuso America/Sao_Paulo");

// Extra — validações rejeitam entrada ruim
assert.throws(() => montarPayloads({ ...base, plano: "9x" }), ErroValidacao);
assert.throws(() => montarPayloads({ ...base, plano: "4cm", cpf: "123" }), ErroValidacao);
assert.throws(
  () => montarPayloads({ ...base, plano: "4cm", cartao: { ...base.cartao, mesValidade: "13" } }),
  ErroValidacao
);
console.log("ok extra — validações (plano, cpf, mês) lançam ErroValidacao");

console.log("\nTODOS OS TESTES PASSARAM (" + ok + " casos + validações)");

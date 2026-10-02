import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLead, validateLead, phoneToE164 } from '../site/lead-validation.mjs';
import { integrationReady, buildSubmissionPayload, interpretSubmissionResponse, submitLead, SubmissionError, createSubmissionClient } from '../site/evo-integration.mjs';

// Offline unit fixtures only. No fixture is transmitted to the CRM.
const valid = { name: 'Pessoa de teste', email: 'example@example.com', phone: '(94) 99999-9999', company: '' };

test('required fields reject whitespace and optional company can be blank', () => {
  assert.deepEqual(Object.keys(validateLead({}).errors), ['name', 'email', 'phone']);
  assert.equal(validateLead({ ...valid, name: '  ', email: ' ', phone: ' ' }).valid, false);
  assert.equal(validateLead(valid).valid, true);
});

test('name supports Portuguese diacritics, hyphens and apostrophes', () => {
  assert.equal(validateLead({ ...valid, name: " João D’Ávila-Silva " }).valid, true);
  assert.equal(normalizeLead({ ...valid, name: '  João   Silva  ' }).name, 'João Silva');
  assert.ok(validateLead({ ...valid, name: 'A' }).errors.name);
  assert.ok(validateLead({ ...valid, name: 'x'.repeat(101) }).errors.name);
});

test('email is trimmed but not altered, with invalid formats rejected', () => {
  assert.equal(normalizeLead({ ...valid, email: ' Example+oficina@example.com ' }).email, 'Example+oficina@example.com');
  for (const email of ['name', 'name@', '@example.com', 'name@@example.com', 'n ame@example.com', 'name@example', 'name@example..com']) {
    assert.ok(validateLead({ ...valid, email }).errors.email, email);
  }
});

test('Brazilian phone numbers map to E.164 without duplicating country code', () => {
  assert.equal(phoneToE164('(94) 99999-9999'), '+5594999999999');
  assert.equal(phoneToE164('(94) 3333-4444'), '+559433334444');
  assert.equal(phoneToE164('55 94 99999 9999'), '+5594999999999');
  assert.equal(phoneToE164('+55 (94) 99999-9999'), '+5594999999999');
  assert.equal(phoneToE164('(55) 99999-9999'), '+5555999999999');
  assert.equal(phoneToE164('+1 202 555 0101'), '+12025550101');
});

test('phone rejects short, alphabetic, repetitive and ambiguous long input', () => {
  for (const phone of ['99999-9999', 'telefone', '99999999999', '+5594abc999999', '123456789012', '+1234567890123456', '94<999>999999']) {
    assert.equal(phoneToE164(phone), null, phone);
    assert.ok(validateLead({ ...valid, phone }).errors.phone, phone);
  }
});

test('company is optional and length-limited', () => {
  assert.equal(validateLead({ ...valid, company: 'Oficina São João & Filhos' }).valid, true);
  assert.ok(validateLead({ ...valid, company: 'x'.repeat(151) }).errors.company);
});

test('payload only permits four visitor fields and no configuration overrides', () => {
  assert.deepEqual(buildSubmissionPayload({ ...valid, city: 'must not be sent', token: 'not a credential' }), {
    name: 'Pessoa de teste', email: 'example@example.com', phone: '(94) 99999-9999', company: '',
  });
  assert.throws(() => buildSubmissionPayload({ ...valid, email: 'invalid' }), SubmissionError);
});

test('browser success requires HTTP 201 and explicit server confirmation', () => {
  assert.deepEqual(interpretSubmissionResponse(201, { confirmed: true }), { confirmed: true });
  for (const [status, body] of [
    [200, { confirmed: true }],
    [201, { success: false, lead_id: 12, deal_id: 13 }],
    [201, { success: true, lead_id: null, deal_id: null }],
    [201, { success: true }], [201, null],
  ]) {
    assert.throws(() => interpretSubmissionResponse(status, body), error => error instanceof SubmissionError && error.uncertain === true);
  }
});

test('provider validation details and private information never reach UI', () => {
  for (const status of [400, 403, 405, 413, 415, 422, 429, 503]) {
    assert.throws(() => interpretSubmissionResponse(status, { confirmed: false, uncertain: false, error: 'PRIVATE@example.test', details: 'internal trace' }), error => {
      assert.equal(error.uncertain, false);
      assert.equal(error.message.includes('PRIVATE'), false);
      assert.equal(error.message.includes('internal'), false);
      return true;
    });
  }
});

test('unknown upstream response remains uncertain to prevent automatic retries', () => {
  assert.throws(() => interpretSubmissionResponse(500, {}), error => error.uncertain === true);
  assert.throws(() => interpretSubmissionResponse(201, { success: true, lead_id: 1, deal_id: '' }), error => error.uncertain === true);
});

test('only safe server error enums are retained for read-only troubleshooting', () => {
  assert.throws(() => interpretSubmissionResponse(503, { confirmed: false, uncertain: false, code: 'destination_unavailable' }), error => error.code === 'destination_unavailable');
  assert.throws(() => interpretSubmissionResponse(503, { confirmed: false, uncertain: false, code: 'private@example.test' }), error => error.code === 'unavailable');
  assert.throws(() => interpretSubmissionResponse(502, { confirmed: false, uncertain: true, code: 'unknown_crm_rejection' }), error => error.code === 'unknown_crm_rejection' && error.uncertain === true);
});

test('phone conflict has helpful copy without revealing the other contact', () => {
  assert.throws(() => interpretSubmissionResponse(422, { confirmed: false, uncertain: false, code: 'phone_conflict', message: 'private@example.test' }), error => {
    assert.equal(error.code, 'phone_conflict');
    assert.equal(error.message.includes('já está cadastrado'), true);
    assert.equal(error.message.includes('WhatsApp'), true);
    assert.equal(error.message.includes('private@'), false);
    return true;
  });
});

test('disabled integration cannot perform fetch even when called directly', async () => {
  let calls = 0;
  const disabledSubmit = createSubmissionClient({ enabled: false, request: () => { calls += 1; throw new Error('No network allowed during test'); } });
  await assert.rejects(disabledSubmit(valid), SubmissionError);
  assert.equal(calls, 0);
});

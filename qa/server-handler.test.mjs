import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { createHandler, config, crmConfirmed, upstreamUrl, pipelineUrl, selectDestination, classifyCRMValidation } from '../netlify/functions/eixo-lead.mjs';

// Strictly offline test fixtures. This is not a real CRM key, contact or send.
const origin = 'https://bright-melomakarona-0510ff.netlify.app';
const values = { name: 'Pessoa de teste', email: 'example@example.com', phone: '(94) 99999-9999', company: 'Oficina de exemplo' };
const pipelineId = '11111111-1111-4111-8111-111111111111';
const stageId = '22222222-2222-4222-8222-222222222222';
const destinationEnvelope = () => ({ success: true, data: [{ id: pipelineId, name: 'Vendas EixoWeb', is_active: true, stages: [{ id: stageId, name: 'Novo Lead', pipeline_id: pipelineId }] }], meta: { timestamp: new Date().toISOString() } });
const env = { EIXO_LEADS_ENABLED: 'true', EVO_API_ACCESS_TOKEN: 'offline-test-fixture', EVO_PIPELINE_NAME: 'Vendas EixoWeb', EVO_STAGE_NAME: 'Novo Lead', EIXO_ALLOWED_ORIGINS: origin };
const request = (body = values, headers = {}) => new Request(`${origin}/api/eixo-lead`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
function harness(override = {}) {
  const calls = [];
  const diagnostics = [];
  const run = createHandler({
    environment: () => ({ ...env, ...override.env }),
    reportDestinationFailure: code => diagnostics.push(code),
    requestUpstream: async (url, options) => {
      calls.push({ url, options });
      if (url === pipelineUrl) return new Response(JSON.stringify(override.lookupBody ?? destinationEnvelope()), { status: override.lookupStatus ?? 200 });
      if (override.throw) throw new Error('Uncertain network failure with sensitive details');
      return new Response(JSON.stringify(override.body ?? { success: true, lead_id: 123, deal_id: 456 }), { status: override.status ?? 201 });
    },
  });
  return { run, calls, diagnostics };
}

test('handler stays disabled with default or incomplete configuration', async () => {
  const off = harness({ env: { EIXO_LEADS_ENABLED: 'false' } });
  assert.equal((await off.run(request())).status, 503);
  assert.equal(off.calls.length, 0);
  for (const [key, value] of [['EVO_API_ACCESS_TOKEN', ''], ['EVO_PIPELINE_NAME', ''], ['EVO_STAGE_NAME', ''], ['EVO_PIPELINE_NAME', 'x'.repeat(151)], ['EIXO_ALLOWED_ORIGINS', '*']]) {
    const h = harness({ env: { [key]: value } });
    assert.equal((await h.run(request())).status, 503, key);
    assert.equal(h.calls.length, 0);
  }
});

test('only POST is accepted and no API data is exposed on GET', async () => {
  const h = harness();
  const response = await h.run(new Request(`${origin}/api/eixo-lead`));
  assert.equal(response.status, 405);
  assert.equal(h.calls.length, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('default function URL cannot bypass the rate-limited custom path', async () => {
  const h = harness();
  const response = await h.run(new Request(`${origin}/.netlify/functions/eixo-lead`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(values) }));
  assert.equal(response.status, 404);
  assert.equal(h.calls.length, 0);
});

test('cross-origin and missing-origin requests do not reach CRM', async () => {
  for (const Origin of ['https://untrusted.example', '', 'null']) {
    const h = harness();
    const response = await h.run(request(values, { Origin }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.has('access-control-allow-origin'), false);
    assert.equal(h.calls.length, 0);
  }
});

test('rejects invalid content type, malformed JSON and overlarge body', async () => {
  const h = harness();
  assert.equal((await h.run(request(values, { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await h.run(request('{broken'))).status, 400);
  assert.equal((await h.run(request('x'.repeat(5000)))).status, 413);
  assert.equal((await h.run(request(values, { 'Content-Length': '5000' }))).status, 413);
  assert.equal(h.calls.length, 0);
});

test('visitor cannot override destination, token, URL or server object shape', async () => {
  const h = harness();
  for (const key of ['pipeline_id', 'stage_id', 'api_access_token', 'upstreamUrl', 'deal', '__proto__']) {
    const response = await h.run(request(JSON.stringify(values).replace(/}$/, `,"${key}":"not-allowed"}`)));
    assert.equal(response.status, 400, key);
  }
  assert.equal((await h.run(request({ ...values, email: {} }))).status, 400);
  assert.equal(h.calls.length, 0);
});

test('server independently validates form fields', async () => {
  const h = harness();
  for (const value of [{ ...values, name: '' }, { ...values, email: 'invalid' }, { ...values, phone: '123' }, { ...values, company: 'x'.repeat(151) }]) {
    assert.equal((await h.run(request(value))).status, 422);
  }
  assert.equal(h.calls.length, 0);
});

test('payload uses fixed authenticated endpoint, configured destination and E.164', async () => {
  const h = harness();
  const response = await h.run(request());
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { confirmed: true });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, pipelineUrl);
  assert.equal(h.calls[0].options.method, 'GET');
  const { url, options } = h.calls[1];
  assert.equal(url, upstreamUrl);
  assert.equal(url, 'https://chat.slsistemas.com.br/public/api/v1/leads');
  assert.equal(options.headers.api_access_token, env.EVO_API_ACCESS_TOKEN);
  assert.equal(options.redirect, 'error');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {
    contact: { name: values.name, email: values.email, phone_number: '+5594999999999', company: values.company },
    deal: { title: `Demonstração Eixo Web · ${values.name}`, pipeline_id: pipelineId, stage_id: stageId },
    custom_fields: {}, metadata: {},
  });
});

test('both documented success shapes require persistent lead and deal IDs', () => {
  assert.equal(crmConfirmed(201, { success: true, lead_id: 1, deal_id: 2 }), true);
  assert.equal(crmConfirmed(200, { success: true, data: { lead_id: 1, deal_id: 2 } }), true);
  for (const [status, body] of [[201, { success: true, lead_id: null, deal_id: null }], [201, { success: true }], [201, { success: false, lead_id: 1, deal_id: 2 }], [202, { success: true, lead_id: 1, deal_id: 2 }], [500, { success: true, lead_id: 1, deal_id: 2 }]]) {
    assert.equal(crmConfirmed(status, body), false);
  }
});

test('provider errors do not leak contact data, IDs or credentials', async () => {
  for (const status of [401, 403, 404, 422, 429, 500]) {
    const h = harness({ status, body: { error: 'private@example.test', token: env.EVO_API_ACCESS_TOKEN, lead_id: 123 } });
    const response = await h.run(request());
    const text = await response.text();
    assert.equal(text.includes('private@'), false);
    assert.equal(text.includes(env.EVO_API_ACCESS_TOKEN), false);
    assert.equal(text.includes('123'), false);
    assert.equal(h.calls.filter(call => call.url === upstreamUrl).length, 1);
  }
});

test('network errors and unconfirmed responses stay uncertain with no retry', async () => {
  for (const override of [{ throw: true }, { body: { success: true } }, { status: 500 }]) {
    const h = harness(override);
    const response = await h.run(request());
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.confirmed, false);
    assert.equal(body.uncertain, true);
    assert.equal(h.calls.filter(call => call.url === upstreamUrl).length, 1);
  }
});

test('platform rate limit is explicitly scoped to the handler path', () => {
  assert.equal(config.path, '/api/eixo-lead');
  assert.deepEqual(config.rateLimit, { action: 'rate_limit', windowLimit: 5, windowSize: 180, aggregateBy: ['ip', 'domain'] });
});


test('destination lookup requires unique active exact names and UUID ownership', () => {
  assert.deepEqual(selectDestination(destinationEnvelope(), env.EVO_PIPELINE_NAME, env.EVO_STAGE_NAME), { pipelineId, stageId });
  for (const mutate of [
    b => b.data.push(structuredClone(b.data[0])),
    b => { b.data[0].is_active = false; },
    b => { b.data[0].name = 'vendas eixo web'; },
    b => { b.data[0].id = '1'; },
    b => b.data[0].stages.push(structuredClone(b.data[0].stages[0])),
    b => { b.data[0].stages[0].name = 'Outro estágio'; },
    b => { b.data[0].stages[0].pipeline_id = '33333333-3333-4333-8333-333333333333'; },
    b => { b.data[0].stages[0].id = 'invalid'; },
    b => { b.meta.pagination = { next_page: 2 }; },
    b => { b.next_cursor = 'next'; },
  ]) {
    const body = destinationEnvelope(); mutate(body);
    assert.throws(() => selectDestination(body, env.EVO_PIPELINE_NAME, env.EVO_STAGE_NAME));
  }
});

test('failed or ambiguous read-only lookup never creates a lead or leaks names', async () => {
  const duplicate = destinationEnvelope(); duplicate.data.push(structuredClone(duplicate.data[0]));
  for (const override of [{ lookupStatus: 401 }, { lookupBody: duplicate }, { lookupBody: { success: true, data: [], meta: {} } }]) {
    const h = harness(override);
    const response = await h.run(request());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.uncertain, false);
    assert.equal(JSON.stringify(body).includes('Vendas'), false);
    assert.equal(h.calls.filter(call => call.url === upstreamUrl).length, 0);
  }
});

test('destination diagnostics distinguish failures without recording secrets or creating leads', async () => {
  for (const [override, expected] of [
    [{ lookupStatus: 401 }, 'lookup_unauthorized'],
    [{ lookupStatus: 403 }, 'lookup_forbidden'],
    [{ lookupStatus: 429 }, 'lookup_rate_limited'],
    [{ lookupStatus: 500 }, 'lookup_http_error'],
    [{ lookupBody: { success: false, error: env.EVO_API_ACCESS_TOKEN, email: values.email } }, 'unexpected_schema'],
    [{ lookupBody: { success: true, data: [], meta: {} } }, 'pipeline_missing_or_ambiguous'],
  ]) {
    const h = harness(override);
    const response = await h.run(request());
    assert.equal(response.status, 503);
    assert.deepEqual(h.diagnostics, [expected]);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.method, 'GET');
    const output = JSON.stringify(h.diagnostics) + await response.text();
    for (const secret of [env.EVO_API_ACCESS_TOKEN, values.email, values.phone, env.EVO_PIPELINE_NAME]) {
      assert.equal(output.includes(secret), false);
    }
  }
  const confirmed = harness();
  await confirmed.run(request());
  assert.deepEqual(confirmed.diagnostics, []);
  const uncertain = harness({ throw: true });
  await uncertain.run(request());
  assert.deepEqual(uncertain.diagnostics, []);
});

test('cache retains only resolved destinations for at most five minutes', async () => {
  const calls = [];
  let time = 1000;
  const run = createHandler({ environment: () => env, now: () => time, requestUpstream: async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(url === pipelineUrl ? destinationEnvelope() : { success: true, lead_id: 'lead', deal_id: 'deal' }), { status: url === pipelineUrl ? 200 : 201 });
  } });
  await run(request()); await run(request());
  assert.equal(calls.filter(url => url === pipelineUrl).length, 1);
  time += 300001;
  await run(request());
  assert.equal(calls.filter(url => url === pipelineUrl).length, 2);
});

test('configuration changes invalidate cached destination', async () => {
  let current = { ...env }; let reads = 0;
  const run = createHandler({ environment: () => current, requestUpstream: async (url) => {
    if (url === pipelineUrl) reads += 1;
    return new Response(JSON.stringify(url === pipelineUrl ? destinationEnvelope() : { success: true, lead_id: 'lead', deal_id: 'deal' }), { status: url === pipelineUrl ? 200 : 201 });
  } });
  await run(request());
  current = { ...env, EVO_API_ACCESS_TOKEN: 'second-offline-fixture' };
  await run(request());
  assert.equal(reads, 2);
});

test('known pre-commit validation failures map to safe enums without PII', () => {
  assert.equal(classifyCRMValidation({ success: false, error: 'Phone number +5594999999999 is already registered to another contact (private@example.test)' }), 'phone_conflict');
  assert.equal(classifyCRMValidation({ success: false, details: ['contact.email must be a valid email address'] }), 'email_invalid');
  assert.equal(classifyCRMValidation({ success: false, error: 'Stage not found or does not belong to this pipeline' }), 'destination_invalid');
  assert.equal(classifyCRMValidation({ success: false, error: 'Contact already has an active journey in this pipeline' }), 'active_card_exists');
  assert.equal(classifyCRMValidation({ success: false, details: ['contact.name is required', 'contact.email is required'] }), 'crm_validation_rejected');
});

test('unknown422 is receipt-uncertain, including a possible after-commit callback error', async () => {
  const h = harness({ status: 422, body: { success: false, error: 'A post-commit callback failed' } });
  const response = await h.run(request());
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.uncertain, true); assert.equal(body.code, 'unknown_crm_rejection');
  assert.equal(JSON.stringify(body).includes('post-commit'), false);
  assert.equal(h.calls.filter(call => call.url === upstreamUrl).length, 1);
});

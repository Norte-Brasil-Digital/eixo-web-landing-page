import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { validateLead } from '../site/lead-validation.mjs';
import { SubmissionError } from '../site/evo-integration.mjs';

// Offline controller tests with minimal DOM doubles. These establish state
// transitions, not browser rendering, accessibility tooling or CRM receipt.
const source = (await readFile(new URL('../site/lead-form.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
function element() {
  return { value: '', textContent: '', hidden: false, disabled: false, attrs: {}, listeners: {}, dataset: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    focus() { this.focused = true; },
  };
}
function setup({ ready = true, submit = async () => ({ confirmed: true }) } = {}) {
  const inputs = Object.fromEntries(['name', 'email', 'phone', 'company'].map(name => [name, element()]));
  Object.assign(inputs.name, { value: 'Pessoa de teste' });
  Object.assign(inputs.email, { value: 'example@example.com' });
  Object.assign(inputs.phone, { value: '(94) 99999-9999' });
  const selectors = Object.fromEntries(['fieldset', '#lead-submit', '#lead-submit-label', '#form-status', '#form-error', ...Object.keys(inputs).map(name => `#lead-${name}-error`)].map(name => [name, element()]));
  const form = element();
  form.elements = { namedItem: name => inputs[name] };
  form.querySelector = selector => selectors[selector];
  form.reset = () => Object.values(inputs).forEach(input => { input.value = ''; });
  const privacy = element(); const link = element(); const privacyLink = element();
  const document = { querySelector: selector => selector === '#demo-form' ? form : privacy, querySelectorAll: selector => selector === '[data-demo]' ? [link] : [privacyLink] };
  vm.runInNewContext(source, { document, integrationReady: ready, submitLead: submit, SubmissionError, validateLead, requestAnimationFrame: fn => fn() });
  return { inputs, form, selectors, privacy, link, privacyLink, send: () => form.listeners.submit({ preventDefault() {} }) };
}

test('unconfigured controller leaves send disabled and never calls adapter', async () => {
  let calls = 0;
  const h = setup({ ready: false, submit: async () => { calls += 1; } });
  assert.equal(h.selectors['#lead-submit'].disabled, true);
  await h.send();
  assert.equal(calls, 0);
  assert.equal(h.form.dataset.state, 'unavailable');
});

test('invalid submit focuses first invalid field and exposes associated error', async () => {
  let calls = 0;
  const h = setup({ submit: async () => { calls += 1; } });
  h.inputs.name.value = ' ';
  await h.send();
  assert.equal(h.inputs.name.focused, true);
  assert.equal(h.inputs.name.attrs['aria-invalid'], 'true');
  assert.equal(h.selectors['#lead-name-error'].hidden, false);
  assert.equal(h.selectors['#form-error'].hidden, false);
  assert.equal(calls, 0);
  h.inputs.name.value = 'Pessoa de teste';
  h.inputs.name.listeners.input();
  assert.equal(h.inputs.name.attrs['aria-invalid'], 'false');
  assert.equal(h.selectors['#lead-name-error'].hidden, true);
});

test('pending request disables fields and rejects repeated submissions', async () => {
  let calls = 0; let resolve;
  const h = setup({ submit: () => { calls += 1; return new Promise(done => { resolve = done; }); } });
  const first = h.send();
  assert.equal(h.form.dataset.state, 'submitting');
  assert.equal(h.form.attrs['aria-busy'], 'true');
  assert.equal(h.selectors.fieldset.disabled, true);
  await h.send();
  assert.equal(calls, 1);
  resolve({ confirmed: true });
  await first;
  assert.equal(h.form.dataset.state, 'success');
  assert.equal(h.form.attrs['aria-busy'], 'false');
  assert.equal(h.inputs.email.value, '');
  await h.send();
  assert.equal(calls, 1);
});

test('definite rejected response preserves fields for a manual correction', async () => {
  const h = setup({ submit: async () => { throw new SubmissionError('Confira os dados.'); } });
  await h.send();
  assert.equal(h.form.dataset.state, 'error');
  assert.equal(h.selectors['#lead-submit'].disabled, false);
  assert.equal(h.inputs.email.value, 'example@example.com');
  assert.equal(h.selectors['#form-error'].textContent, 'Confira os dados.');
});

test('uncertain receipt blocks retries and retains entered data', async () => {
  let calls = 0;
  const h = setup({ submit: async () => { calls += 1; throw new Error('Private upstream error'); } });
  await h.send();
  assert.equal(h.form.dataset.state, 'uncertain');
  assert.equal(h.selectors['#lead-submit'].disabled, true);
  assert.equal(h.inputs.email.value, 'example@example.com');
  assert.equal(h.selectors['#form-error'].textContent.includes('Private'), false);
  await h.send();
  assert.equal(calls, 1);
});

test('nonconfirmed adapter result cannot create a success message', async () => {
  const h = setup({ submit: async () => ({ success: true }) });
  await h.send();
  assert.equal(h.form.dataset.state, 'uncertain');
  assert.equal(h.inputs.email.value, 'example@example.com');
});

test('inline calls to action focus form; data link opens disclosure', () => {
  const h = setup();
  h.link.listeners.click();
  assert.equal(h.inputs.name.focused, true);
  h.privacyLink.listeners.click();
  assert.equal(h.privacy.open, true);
});

test('failed response exposes only its safe enum without another request', async () => {
  let calls = 0;
  const h = setup({ submit: async () => { calls += 1; throw new SubmissionError('O envio está indisponível.', { code: 'not_configured' }); } });
  await h.send();
  assert.equal(h.form.dataset.errorCode, 'not_configured');
  assert.equal(calls, 1);
});

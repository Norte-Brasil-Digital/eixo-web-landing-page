import { validateLead } from './lead-validation.mjs';
import { integrationReady, submitLead, SubmissionError } from './evo-integration.mjs';

const form = document.querySelector('#demo-form');

if (form) {
  const fieldset = form.querySelector('fieldset');
  const button = form.querySelector('#lead-submit');
  const buttonLabel = form.querySelector('#lead-submit-label');
  const status = form.querySelector('#form-status');
  const errorMessage = form.querySelector('#form-error');
  const inputs = Object.fromEntries(['name', 'email', 'phone', 'company'].map(name => [name, form.elements.namedItem(name)]));
  const touched = new Set();
  let busy = false;
  let completed = false;
  let uncertain = false;

  function values() {
    return Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
  }

  function fieldError(name, message) {
    const input = inputs[name];
    const output = form.querySelector(`#lead-${name}-error`);
    output.textContent = message || '';
    output.hidden = !message;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function clearError() {
    errorMessage.hidden = true;
    errorMessage.textContent = '';
    delete form.dataset.errorCode;
  }

  function setError(message) {
    status.textContent = '';
    errorMessage.textContent = message;
    errorMessage.hidden = false;
  }

  function setState(state) {
    form.dataset.state = state;
    form.setAttribute('aria-busy', String(state === 'submitting'));
    fieldset.disabled = busy || completed || uncertain;
    button.disabled = !integrationReady || busy || completed || uncertain;
    buttonLabel.textContent = busy ? 'Enviando…' : completed ? 'Solicitação enviada' : uncertain ? 'Envio não confirmado' : 'Solicitar demonstração';
  }

  for (const [name, input] of Object.entries(inputs)) {
    input.addEventListener('blur', () => {
      touched.add(name);
      fieldError(name, validateLead(values()).errors[name]);
    });
    input.addEventListener('input', () => {
      if (touched.has(name)) fieldError(name, validateLead(values()).errors[name]);
    });
  }

  document.querySelectorAll('[data-demo]').forEach(link => {
    link.addEventListener('click', () => {
      // Native anchor navigation remains functional without JavaScript.
      requestAnimationFrame(() => inputs.name.focus({ preventScroll: true }));
    });
  });

  document.querySelectorAll('a[href="#sobre-dados"]').forEach(link => {
    link.addEventListener('click', () => { document.querySelector('#sobre-dados').open = true; });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || completed || uncertain) return;
    clearError();
    const result = validateLead(values());
    for (const name of Object.keys(inputs)) {
      touched.add(name);
      fieldError(name, result.errors[name]);
    }
    if (!result.valid) {
      setError('Confira os campos destacados antes de enviar.');
      inputs[Object.keys(result.errors)[0]].focus();
      return;
    }
    if (!integrationReady) {
      setError('O envio está em configuração. Use o formulário de atendimento ou o WhatsApp.');
      return;
    }

    busy = true;
    status.textContent = 'Enviando sua solicitação. Aguarde a confirmação antes de sair desta página.';
    setState('submitting');
    try {
      // Only the verified adapter may return confirmed: true.
      const response = await submitLead(result.lead);
      if (response?.confirmed !== true) {
        throw new SubmissionError('Não foi possível confirmar o recebimento. Para evitar um envio duplicado, consulte o atendimento pelo WhatsApp antes de tentar novamente.', { uncertain: true });
      }
      completed = true;
      form.reset();
      status.textContent = 'Sua solicitação foi recebida. A Norte Brasil Digital entrará em contato pelos dados informados.';
      setState('success');
    } catch (error) {
      // Unknown/network errors cannot prove that the service rejected the lead.
      uncertain = !(error instanceof SubmissionError) || error.uncertain;
      // A safe, fixed enum makes the existing failed response diagnosable
      // without resubmitting or exposing upstream errors or contact data.
      form.dataset.errorCode = error instanceof SubmissionError ? error.code : 'receipt_unknown';
      setError(error instanceof SubmissionError ? error.message : 'Não foi possível confirmar o recebimento. Consulte o atendimento pelo WhatsApp antes de tentar novamente para evitar duplicidade.');
    } finally {
      busy = false;
      setState(completed ? 'success' : uncertain ? 'uncertain' : 'error');
    }
  });

  if (integrationReady) status.textContent = '';
  setState(integrationReady ? 'ready' : 'unavailable');
}

import { validateLead } from './lead-validation.mjs';

// The same-origin Netlify Function validates configuration and CRM receipt.
// Activation is authorized for the noindex review site; no automatic retries.
// No CRM token belongs in this file. The browser never calls the private API.
export const integrationReady = true;
export const submissionUrl = '/api/eixo-lead';

export class SubmissionError extends Error {
  constructor(message, { uncertain = false, code = 'unavailable' } = {}) {
    super(message);
    this.name = 'SubmissionError';
    this.uncertain = uncertain;
    this.code = code;
  }
}

export function buildSubmissionPayload(values) {
  const { lead, valid } = validateLead(values);
  if (!valid) throw new SubmissionError('Confira os dados antes de enviar.');
  // Only these four public fields can reach the server. Destination IDs and
  // credentials are server-owned configuration, never visitor input.
  return lead;
}

export function interpretSubmissionResponse(status, body) {
  const safeCodes = new Set(['not_configured', 'origin_not_allowed', 'method_not_allowed', 'invalid_body', 'invalid_fields', 'crm_rejected', 'rate_limited', 'service_unavailable', 'destination_unavailable', 'receipt_unknown', 'name_required', 'email_required', 'email_invalid', 'destination_invalid', 'phone_conflict', 'phone_invalid', 'active_card_exists', 'crm_validation_rejected', 'unknown_crm_rejection']);
  const code = safeCodes.has(body?.code) ? body.code : 'unavailable';
  if (status === 201 && body?.confirmed === true) return { confirmed: true };
  // Netlify can rate-limit before the function runs, with a non-JSON response.
  if (status === 429) {
    throw new SubmissionError('O serviço recebeu muitas solicitações. Aguarde antes de tentar novamente ou use o WhatsApp.', { code: 'rate_limited' });
  }
  if (body?.confirmed === false && body?.uncertain === false) {
    if (status === 422 && code === 'phone_conflict') {
      throw new SubmissionError('Este telefone já está cadastrado no atendimento. Fale com Fabio pelo WhatsApp para continuar.', { code });
    }
    if (status === 422 && code === 'active_card_exists') {
      throw new SubmissionError('Já existe um atendimento em andamento com estes dados. Fale com Fabio pelo WhatsApp para dar continuidade.', { code });
    }
    if ([400, 413, 415, 422].includes(status)) {
      throw new SubmissionError('Não foi possível aceitar os dados. Confira as informações ou fale com Fabio pelo WhatsApp.', { code });
    }
    if ([403, 405, 503].includes(status)) {
      throw new SubmissionError('O formulário está indisponível no momento. Use o formulário de atendimento ou o WhatsApp.', { code });
    }
  }
  // Unknown responses cannot prove that the CRM did not create a lead.
  // Raw response messages are never shown or logged by the browser.
  throw new SubmissionError('Não foi possível confirmar o recebimento. Para evitar um envio duplicado, consulte o atendimento pelo WhatsApp antes de tentar novamente.', { uncertain: true, code: code === 'unavailable' ? 'receipt_unknown' : code });
}

export function createSubmissionClient({ enabled = false, request = fetch } = {}) {
 return async function submitLead(values) {
  // This guard also blocks direct programmatic invocation while unavailable.
  if (!enabled) {
    throw new SubmissionError('O envio está em configuração. Use o formulário de atendimento ou o WhatsApp.');
  }
  const payload = buildSubmissionPayload(values);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await request(submissionUrl, {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return interpretSubmissionResponse(response.status, body);
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError('Não foi possível confirmar o recebimento. Consulte o atendimento pelo WhatsApp antes de tentar novamente para evitar duplicidade.', { uncertain: true, code: 'receipt_unknown' });
  } finally {
    clearTimeout(timeout);
  }
 };
}

export const submitLead = createSubmissionClient({ enabled: integrationReady });

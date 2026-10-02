import { createHash } from 'node:crypto';
import { validateLead, phoneToE164 } from '../../site/lead-validation.mjs';

// Deployment candidate. EIXO_LEADS_ENABLED must remain false until activation
// and a real test submission have been explicitly approved.
// Credentials must be entered by the owner in Netlify's secure settings,
// Functions scope. Never put credentials in a frontend file or this source.
export const upstreamUrl = 'https://chatapi.slsistemas.com.br/public/api/v1/leads';
export const pipelineUrl = 'https://chatapi.slsistemas.com.br/api/v1/pipelines';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_BODY_BYTES = 4096;
const ALLOWED_FIELDS = new Set(['name', 'email', 'phone', 'company']);

export const config = {
  path: '/api/eixo-lead',
  rateLimit: { action: 'rate_limit', windowLimit: 5, windowSize: 180, aggregateBy: ['ip', 'domain'] },
};

function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

const rejected = (status, code, message) => json(status, { confirmed: false, uncertain: false, code, message });
const uncertain = (code = 'receipt_unknown') => json(502, {
  confirmed: false,
  uncertain: true,
  code,
  message: 'Não foi possível confirmar o recebimento. Consulte o atendimento pelo WhatsApp antes de tentar novamente para evitar duplicidade.',
});

function configFromEnvironment(env) {
  if (env.EIXO_LEADS_ENABLED !== 'true') return null;
  const key = env.EVO_API_ACCESS_TOKEN;
  const pipelineName = String(env.EVO_PIPELINE_NAME || '').trim();
  const stageName = String(env.EVO_STAGE_NAME || '').trim();
  if (!key || !pipelineName || !stageName || pipelineName.length > 150 || stageName.length > 150) return null;
  const origins = String(env.EIXO_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length || origins.some(origin => {
    try { const url = new URL(origin); return url.protocol !== 'https:' || url.origin !== origin; }
    catch { return true; }
  })) return null;
  return { key, pipelineName, stageName, origins };
}

async function readSmallJSON(request) {
  const declaredSize = request.headers.get('content-length');
  if (declaredSize && (!/^\d+$/u.test(declaredSize) || Number(declaredSize) > MAX_BODY_BYTES)) {
    return { error: 'too_large' };
  }
  if (!request.body) return { error: 'invalid' };
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: 'too_large' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { error: 'invalid' };
  }
}

function presentId(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0)
    || (typeof value === 'string' && value.trim().length > 0);
}

export function crmConfirmed(status, body) {
  // The current controller uses 201/top-level IDs; official documentation
  // shows 200/data IDs. Both still require evidence of two persisted records.
  if (![200, 201].includes(status) || body?.success !== true) return false;
  return (presentId(body.lead_id) && presentId(body.deal_id))
    || (presentId(body.data?.lead_id) && presentId(body.data?.deal_id));
}

export function classifyCRMValidation(body) {
  if (body?.success !== false) return null;
  const messages = Array.isArray(body.details) && body.details.length ? body.details : [body.error];
  if (messages.length > 20 || messages.some(message => typeof message !== 'string' || message.length > 2000)) return null;
  const exact = new Map([
    ['contact.name is required', 'name_required'], ['contact.email is required', 'email_required'],
    ['contact.email must be a valid email address', 'email_invalid'],
    ['deal.pipeline_id is required', 'destination_invalid'], ['deal.stage_id is required', 'destination_invalid'],
    ['Pipeline not found', 'destination_invalid'], ['Stage not found or does not belong to this pipeline', 'destination_invalid'],
  ]);
  const codes = messages.map(message => {
    if (exact.has(message)) return exact.get(message);
    if (/^Phone number \+[1-9]\d{1,14} is already registered to another contact \([^\r\n]*\)$/u.test(message)) return 'phone_conflict';
    if (/^Phone number must be in E\.164 format \(\+\[country\]\[number\]\)\. Example: \+[1-9]\d{1,14}$/u.test(message)) return 'phone_invalid';
    if (/^Contact(?: id)? already has an active journey in this pipeline$/u.test(message)) return 'active_card_exists';
    return null;
  });
  if (codes.some(code => code === null)) return null;
  return new Set(codes).size === 1 ? codes[0] : 'crm_validation_rejected';
}

class DestinationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function selectDestination(body, pipelineName, stageName) {
  if (body?.success !== true || !Array.isArray(body.data) || !body.meta || typeof body.meta !== 'object') {
    throw new DestinationError('unexpected_schema');
  }
  // The documented endpoint is not paginated. Future pagination must be
  // reviewed explicitly, rather than silently matching only its first page.
  if (Object.keys(body.meta).some(key => key !== 'timestamp')
    || ['pagination', 'next_page', 'next_cursor', 'has_more'].some(key => key in body)) {
    throw new DestinationError('unexpected_pagination');
  }
  const matches = body.data.filter(pipeline => pipeline?.name === pipelineName && pipeline.is_active === true);
  if (matches.length !== 1) throw new DestinationError('pipeline_missing_or_ambiguous');
  const pipeline = matches[0];
  if (typeof pipeline.id !== 'string' || !UUID.test(pipeline.id) || !Array.isArray(pipeline.stages)) {
    throw new DestinationError('invalid_pipeline_identity');
  }
  const stages = pipeline.stages.filter(stage => stage?.name === stageName);
  if (stages.length !== 1) throw new DestinationError('stage_missing_or_ambiguous');
  const stage = stages[0];
  if (typeof stage.id !== 'string' || !UUID.test(stage.id) || stage.pipeline_id !== pipeline.id) {
    throw new DestinationError('invalid_stage_ownership');
  }
  return { pipelineId: pipeline.id, stageId: stage.id };
}

export function createHandler({ environment = () => process.env, requestUpstream = fetch, now = Date.now } = {}) {
  // Cache only the resolved UUIDs and a one-way configuration fingerprint.
  // No lists, personal data, token or response body are retained here.
  let cached = null;
  async function resolveDestination(settings, signal) {
    const fingerprint = createHash('sha256').update(JSON.stringify([settings.key, settings.pipelineName, settings.stageName])).digest('hex');
    if (cached?.fingerprint === fingerprint && cached.expires > now()) return cached.destination;
    cached = null;
    const response = await requestUpstream(pipelineUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', api_access_token: settings.key },
      redirect: 'error', signal,
    });
    if (response.status !== 200) throw new Error('Pipeline lookup unavailable');
    const body = await response.json();
    const destination = selectDestination(body, settings.pipelineName, settings.stageName);
    cached = { fingerprint, destination, expires: now() + 300000 };
    return destination;
  }
  return async function handleLead(request) {
    if (new URL(request.url).pathname !== config.path) {
      return rejected(404, 'not_found', 'Abra o formulário pela página oficial.');
    }
    const env = environment();
    if (request.method !== 'POST') {
      return rejected(405, 'method_not_allowed', 'Use o formulário desta página para enviar a solicitação.');
    }
    const settings = configFromEnvironment(env);
    if (!settings) return rejected(503, 'not_configured', 'O envio ainda não está disponível. Use o formulário de atendimento ou o WhatsApp.');
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin || !settings.origins.includes(origin)) {
      return rejected(403, 'origin_not_allowed', 'Abra o formulário pela página oficial.');
    }
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return rejected(415, 'unsupported_type', 'Não foi possível processar o formulário.');
    }
    const parsed = await readSmallJSON(request);
    if (parsed.error) return rejected(parsed.error === 'too_large' ? 413 : 400, 'invalid_body', 'Não foi possível processar os dados enviados.');
    const input = parsed.value;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !ALLOWED_FIELDS.has(key))
      || ['name', 'email', 'phone'].some(key => typeof input[key] !== 'string')
      || (input.company !== undefined && typeof input.company !== 'string')) {
      return rejected(400, 'invalid_fields', 'Confira os campos do formulário.');
    }
    const result = validateLead(input);
    if (!result.valid) return rejected(422, 'invalid_fields', 'Confira os campos do formulário antes de enviar.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let postAttempted = false;
    try {
      const destination = await resolveDestination(settings, controller.signal);
      const payload = {
        contact: { name: result.lead.name, email: result.lead.email, phone_number: phoneToE164(result.lead.phone), company: result.lead.company },
        deal: { title: `Demonstração Eixo Web · ${result.lead.name}`, pipeline_id: destination.pipelineId, stage_id: destination.stageId },
        custom_fields: {},
        metadata: {},
      };
      postAttempted = true;
      const response = await requestUpstream(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', api_access_token: settings.key },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (crmConfirmed(response.status, body)) return json(201, { confirmed: true });
      // No upstream body, token, IDs, email conflict details or exception is
      // logged or forwarded to the visitor. There are no automatic retries.
      if (response.status === 422) {
        cached = null;
        const reason = classifyCRMValidation(body);
        const message = reason === 'phone_conflict'
          ? 'Este telefone já está cadastrado no atendimento. Fale com Fabio pelo WhatsApp para continuar.'
          : reason === 'active_card_exists'
            ? 'Já existe um atendimento em andamento com estes dados. Fale com Fabio pelo WhatsApp para dar continuidade.'
            : 'Não foi possível aceitar os dados. Confira as informações ou fale com Fabio pelo WhatsApp.';
        return reason ? rejected(422, reason, message) : uncertain('unknown_crm_rejection');
      }
      if (response.status === 429) return rejected(429, 'rate_limited', 'O serviço recebeu muitas solicitações. Aguarde antes de tentar novamente ou use o WhatsApp.');
      if ([400, 401, 403, 404, 405].includes(response.status)) {
        cached = null;
        return rejected(503, 'service_unavailable', 'O envio está indisponível no momento. Use o formulário de atendimento ou o WhatsApp.');
      }
      return uncertain();
    } catch {
      cached = null;
      return postAttempted ? uncertain() : rejected(503, 'destination_unavailable', 'O atendimento está indisponível no momento. Use o formulário de atendimento ou o WhatsApp.');
    } finally {
      clearTimeout(timeout);
    }
  };
}

export default createHandler();

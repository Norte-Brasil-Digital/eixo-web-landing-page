const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export function phoneToE164(value) {
  const phone = String(value ?? '').trim();
  if (!/^\+?[\d\s().-]+$/u.test(phone)) return null;
  const digits = phone.replace(/\D/gu, '');
  if (digits.startsWith('0') || /^(\d)\1+$/u.test(digits)) return null;
  if (phone.startsWith('+')) return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return `+${digits}`;
  return null;
}

export function normalizeLead(values) {
  return {
    name: String(values.name ?? '').trim().replace(/\s+/gu, ' '),
    email: String(values.email ?? '').trim(),
    phone: String(values.phone ?? '').trim(),
    company: String(values.company ?? '').trim().replace(/\s+/gu, ' '),
  };
}

export function validateLead(values) {
  const lead = normalizeLead(values);
  const errors = {};
  if (!lead.name) errors.name = 'Informe seu nome.';
  else if (lead.name.length < 2 || lead.name.length > 100 || CONTROL_CHARACTERS.test(lead.name)) {
    errors.name = 'Informe um nome entre 2 e 100 caracteres.';
  }

  if (!lead.email) errors.email = 'Informe seu e-mail.';
  else if (lead.email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(lead.email)) {
    errors.email = 'Informe um e-mail válido, como voce@exemplo.com.br.';
  }

  if (!lead.phone) errors.phone = 'Informe seu telefone com DDD.';
  else if (!phoneToE164(lead.phone)) {
    errors.phone = 'Confira o número e inclua o DDD. Exemplo: (94) 99999-9999.';
  }

  if (lead.company.length > 150 || CONTROL_CHARACTERS.test(lead.company)) {
    errors.company = 'Use até 150 caracteres para o nome da empresa.';
  }
  return { lead, errors, valid: Object.keys(errors).length === 0 };
}

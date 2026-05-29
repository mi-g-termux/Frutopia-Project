/**
 * Country-aware phone number validation.
 *
 * Each entry defines the allowed length(s) of the *local* (national) part
 * — i.e. the digits AFTER the international dial code.
 *
 *   { dial: '+880', lengths: [10] }  →  +880 1XXXXXXXXX  (10 local digits, total 11 with leading 0 not required)
 *   { dial: '+1',   lengths: [10] }  →  +1 NXX-XXX-XXXX  (10 local digits)
 *
 * Note: "BD numbers must be 11 digits" in everyday speech means the
 * national form starting with `01` (11 digits). When stored in E.164 with
 * `+880`, the leading `0` is dropped so the local part is 10 digits.
 * We accept BOTH (with or without the leading 0).
 */

export interface CountryPhoneRule {
  dial: string;
  name: string;
  /** Allowed lengths of the local (national) number, without the dial code. */
  lengths: number[];
  /** Optional regex the local number must match (after stripping non-digits). */
  pattern?: RegExp;
  /** Whether a leading "0" trunk prefix should be stripped before validation. */
  stripLeadingZero?: boolean;
}

export const COUNTRY_PHONE_RULES: CountryPhoneRule[] = [
  { dial: '+880', name: 'Bangladesh',          lengths: [10],     pattern: /^1[3-9]\d{8}$/, stripLeadingZero: true },
  { dial: '+91',  name: 'India',               lengths: [10],     pattern: /^[6-9]\d{9}$/ },
  { dial: '+92',  name: 'Pakistan',            lengths: [10],     pattern: /^3\d{9}$/,       stripLeadingZero: true },
  { dial: '+1',   name: 'USA / Canada',        lengths: [10],     pattern: /^[2-9]\d{2}[2-9]\d{6}$/ },
  { dial: '+44',  name: 'United Kingdom',      lengths: [10],     pattern: /^7\d{9}$/,       stripLeadingZero: true },
  { dial: '+971', name: 'UAE',                 lengths: [9],      pattern: /^5\d{8}$/,       stripLeadingZero: true },
  { dial: '+966', name: 'Saudi Arabia',        lengths: [9],      pattern: /^5\d{8}$/,       stripLeadingZero: true },
  { dial: '+974', name: 'Qatar',               lengths: [8] },
  { dial: '+965', name: 'Kuwait',              lengths: [8] },
  { dial: '+973', name: 'Bahrain',             lengths: [8] },
  { dial: '+968', name: 'Oman',                lengths: [8] },
  { dial: '+60',  name: 'Malaysia',            lengths: [9, 10],  stripLeadingZero: true },
  { dial: '+65',  name: 'Singapore',           lengths: [8] },
  { dial: '+62',  name: 'Indonesia',           lengths: [9, 10, 11, 12], stripLeadingZero: true },
  { dial: '+66',  name: 'Thailand',            lengths: [9],      stripLeadingZero: true },
  { dial: '+84',  name: 'Vietnam',             lengths: [9, 10],  stripLeadingZero: true },
  { dial: '+63',  name: 'Philippines',         lengths: [10],     stripLeadingZero: true },
  { dial: '+86',  name: 'China',               lengths: [11] },
  { dial: '+81',  name: 'Japan',               lengths: [10, 11], stripLeadingZero: true },
  { dial: '+82',  name: 'South Korea',         lengths: [9, 10],  stripLeadingZero: true },
  { dial: '+852', name: 'Hong Kong',           lengths: [8] },
  { dial: '+886', name: 'Taiwan',              lengths: [9],      stripLeadingZero: true },
  { dial: '+61',  name: 'Australia',           lengths: [9],      stripLeadingZero: true },
  { dial: '+64',  name: 'New Zealand',         lengths: [8, 9, 10], stripLeadingZero: true },
  { dial: '+49',  name: 'Germany',             lengths: [10, 11], stripLeadingZero: true },
  { dial: '+33',  name: 'France',              lengths: [9],      stripLeadingZero: true },
  { dial: '+39',  name: 'Italy',               lengths: [9, 10] },
  { dial: '+34',  name: 'Spain',               lengths: [9] },
  { dial: '+31',  name: 'Netherlands',         lengths: [9],      stripLeadingZero: true },
  { dial: '+32',  name: 'Belgium',             lengths: [9],      stripLeadingZero: true },
  { dial: '+41',  name: 'Switzerland',         lengths: [9],      stripLeadingZero: true },
  { dial: '+43',  name: 'Austria',             lengths: [10, 11], stripLeadingZero: true },
  { dial: '+46',  name: 'Sweden',              lengths: [9],      stripLeadingZero: true },
  { dial: '+47',  name: 'Norway',              lengths: [8] },
  { dial: '+45',  name: 'Denmark',             lengths: [8] },
  { dial: '+358', name: 'Finland',             lengths: [9, 10],  stripLeadingZero: true },
  { dial: '+351', name: 'Portugal',            lengths: [9] },
  { dial: '+353', name: 'Ireland',             lengths: [9],      stripLeadingZero: true },
  { dial: '+30',  name: 'Greece',              lengths: [10] },
  { dial: '+48',  name: 'Poland',              lengths: [9] },
  { dial: '+420', name: 'Czechia',             lengths: [9] },
  { dial: '+90',  name: 'Turkey',              lengths: [10],     stripLeadingZero: true },
  { dial: '+7',   name: 'Russia',              lengths: [10] },
  { dial: '+380', name: 'Ukraine',             lengths: [9] },
  { dial: '+972', name: 'Israel',              lengths: [9],      stripLeadingZero: true },
  { dial: '+20',  name: 'Egypt',               lengths: [10],     stripLeadingZero: true },
  { dial: '+27',  name: 'South Africa',        lengths: [9],      stripLeadingZero: true },
  { dial: '+234', name: 'Nigeria',             lengths: [10],     stripLeadingZero: true },
  { dial: '+254', name: 'Kenya',               lengths: [9],      stripLeadingZero: true },
  { dial: '+212', name: 'Morocco',             lengths: [9],      stripLeadingZero: true },
  { dial: '+55',  name: 'Brazil',              lengths: [10, 11] },
  { dial: '+52',  name: 'Mexico',              lengths: [10] },
  { dial: '+54',  name: 'Argentina',           lengths: [10] },
  { dial: '+56',  name: 'Chile',               lengths: [9] },
  { dial: '+57',  name: 'Colombia',            lengths: [10] },
  { dial: '+51',  name: 'Peru',                lengths: [9] },
];

export const DEFAULT_RULE: CountryPhoneRule = {
  dial: '',
  name: 'Generic',
  lengths: [6, 7, 8, 9, 10, 11, 12, 13, 14],
};

export function findRule(dial: string): CountryPhoneRule {
  return COUNTRY_PHONE_RULES.find(r => r.dial === dial) || { ...DEFAULT_RULE, dial };
}

export interface PhoneValidationResult {
  ok: boolean;
  normalizedLocal: string;
  e164: string;
  error?: string;
}

/**
 * Validate `localInput` against the rule for `dial`.
 *
 *   validatePhone('+880', '01712345678')  → ok, e164 '+8801712345678'
 *   validatePhone('+880', '1712345678')   → ok, e164 '+8801712345678'
 *   validatePhone('+1',   '4155552671')   → ok, e164 '+14155552671'
 *   validatePhone('+1',   '12345')        → not ok, message about expected length
 */
export function validatePhone(dial: string, localInput: string): PhoneValidationResult {
  const rule = findRule(dial);
  let local = (localInput || '').replace(/\D/g, '');

  if (rule.stripLeadingZero && local.startsWith('0')) {
    local = local.replace(/^0+/, '');
  }

  if (!local) {
    return { ok: false, normalizedLocal: '', e164: dial, error: 'Phone number is required.' };
  }

  if (!rule.lengths.includes(local.length)) {
    const expected = rule.lengths.length === 1
      ? `${rule.lengths[0]} digits`
      : `${rule.lengths.join(' or ')} digits`;
    return {
      ok: false,
      normalizedLocal: local,
      e164: `${dial}${local}`,
      error: `${rule.name} numbers must be ${expected} (you entered ${local.length}).`,
    };
  }

  if (rule.pattern && !rule.pattern.test(local)) {
    return {
      ok: false,
      normalizedLocal: local,
      e164: `${dial}${local}`,
      error: `That doesn't look like a valid ${rule.name} mobile number.`,
    };
  }

  return { ok: true, normalizedLocal: local, e164: `${dial}${local}` };
}

/** Convenience: build the E.164 string from dial + local digits. */
export function toE164(dial: string, local: string): string {
  const rule = findRule(dial);
  let digits = (local || '').replace(/\D/g, '');
  if (rule.stripLeadingZero) digits = digits.replace(/^0+/, '');
  return `${dial}${digits}`;
}

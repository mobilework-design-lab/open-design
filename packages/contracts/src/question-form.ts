/**
 * Shared parser for completed inline question forms emitted by an agent.
 *
 * The Web app also has a streaming parser for rendering a form while it is
 * still being generated. This module deliberately handles the completed
 * message boundary used by daemon/MCP consumers: it extracts one valid form,
 * normalizes its fields, and never defines domain-specific questions.
 */

export type QuestionType =
  | 'radio'
  | 'checkbox'
  | 'select'
  | 'text'
  | 'textarea'
  | 'number'
  | 'range'
  | 'date'
  | 'time'
  | 'datetime-local'
  | 'color'
  | 'url'
  | 'email'
  | 'tel'
  | 'file'
  | 'switch'
  | 'direction-cards';

export interface FormOption {
  label: string;
  value: string;
  description?: string;
}

export interface FormQuestion {
  id: string;
  label: string;
  type: QuestionType;
  options?: FormOption[];
  placeholder?: string;
  required?: boolean;
  help?: string;
  defaultValue?: string | string[];
  allowCustom?: boolean;
  customLabel?: string;
  customPlaceholder?: string;
  min?: number;
  max?: number;
  maxSelections?: number;
  step?: number;
  multiple?: boolean;
  accept?: string;
}

export interface QuestionForm {
  id: string;
  title: string;
  description?: string;
  questions: FormQuestion[];
  submitLabel?: string;
  lang?: string;
}

export interface ParsedQuestionForm {
  form: QuestionForm;
  raw: string;
}

const OPEN_RE = /<(question-form|ask-question)\b([^>]*)>/i;

/** Return the first valid form in an assistant message, or null. */
export function findFirstQuestionForm(input: string): ParsedQuestionForm | null {
  if (typeof input !== 'string' || input.length === 0) return null;

  let cursor = 0;
  while (cursor < input.length) {
    const match = OPEN_RE.exec(input.slice(cursor));
    if (!match) return null;

    const tagName = (match[1] ?? 'question-form').toLowerCase();
    const closeTag = `</${tagName}>`;
    const openStart = cursor + match.index;
    const openEnd = openStart + match[0].length;
    const closeIndex = findCloseTag(input, openEnd, closeTag);

    if (closeIndex < 0) return null;

    const body = input.slice(openEnd, closeIndex);
    const form = parseForm(body, parseAttrs(match[2] ?? ''));
    const blockEnd = closeIndex + closeTag.length;
    if (form) {
      return { form, raw: input.slice(openStart, blockEnd) };
    }

    // A malformed block may be prose mentioning one tag around a valid
    // nested block. Continue scanning after the malformed block rather than
    // treating it as a valid discovery request.
    cursor = blockEnd;
  }

  return null;
}

function findCloseTag(input: string, from: number, closeTag: string): number {
  const closeLower = closeTag.toLowerCase();
  for (let i = from; i <= input.length - closeTag.length; i++) {
    if (input.slice(i, i + closeTag.length).toLowerCase() === closeLower) return i;
  }
  return -1;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    attrs[match[1] as string] = match[2] ?? match[3] ?? '';
  }
  return attrs;
}

function parseForm(body: string, attrs: Record<string, string>): QuestionForm | null {
  const stripped = body
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (!stripped) return null;

  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return null;
  }

  const object = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
  const rawQuestions = Array.isArray(data)
    ? data
    : object && Array.isArray(object.questions)
      ? object.questions
      : null;
  if (!rawQuestions) return null;

  const questions = rawQuestions
    .map((question, index) => mapQuestion(question, index))
    .filter((question): question is FormQuestion => question !== null);
  if (questions.length === 0) return null;

  return {
    id: attrs.id ?? (typeof object?.id === 'string' ? object.id : 'discovery'),
    title: attrs.title ?? (typeof object?.title === 'string' ? object.title : 'A few quick questions'),
    questions,
    ...(typeof object?.description === 'string' ? { description: object.description } : {}),
    ...(typeof object?.submitLabel === 'string' ? { submitLabel: object.submitLabel } : {}),
    ...(typeof object?.lang === 'string' && object.lang.trim() ? { lang: object.lang.trim() } : {}),
  };
}

function mapQuestion(raw: unknown, index: number): FormQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const question = raw as Record<string, unknown>;
  const id = typeof question.id === 'string' && question.id.trim()
    ? question.id.trim()
    : `q${index + 1}`;
  const options = parseOptions(question.options);
  const label = typeof question.label === 'string'
    ? question.label
    : typeof question.prompt === 'string'
      ? question.prompt
      : id;
  const min = parseNumber(question.min);
  const max = parseNumber(question.max);
  const maxSelections = parseNumber(question.maxSelections);
  const step = parseNumber(question.step);
  const defaultValue = parseDefaultValue(question, options);
  const mapped: FormQuestion = {
    id,
    label,
    type: normalizeType(question.type, options),
    ...(options ? { options } : {}),
    ...(typeof question.placeholder === 'string' ? { placeholder: question.placeholder } : {}),
    ...(question.required === true ? { required: true } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(typeof question.help === 'string' ? { help: question.help } : {}),
    ...(typeof question.allowCustom === 'boolean' ? { allowCustom: question.allowCustom } : {}),
    ...(typeof question.customLabel === 'string' ? { customLabel: question.customLabel } : {}),
    ...(typeof question.customPlaceholder === 'string' ? { customPlaceholder: question.customPlaceholder } : {}),
    ...(question.multiple === true ? { multiple: true } : {}),
    ...(typeof question.accept === 'string' ? { accept: question.accept } : {}),
  };
  if (min !== undefined) mapped.min = min;
  if (max !== undefined) mapped.max = max;
  if (maxSelections !== undefined) mapped.maxSelections = maxSelections;
  if (step !== undefined) mapped.step = step;
  return mapped;
}

function parseDefaultValue(
  question: Record<string, unknown>,
  options: FormOption[] | undefined,
): string | string[] | undefined {
  const raw =
    typeof question.defaultValue === 'string' || Array.isArray(question.defaultValue)
      ? question.defaultValue
      : typeof question.defaultValue === 'number' || typeof question.defaultValue === 'boolean'
        ? String(question.defaultValue)
        : typeof question.default === 'string' || Array.isArray(question.default)
          ? question.default
          : typeof question.default === 'number' || typeof question.default === 'boolean'
            ? String(question.default)
            : undefined;
  if (typeof raw === 'string') return formOptionValueForLabel(raw, options);
  if (Array.isArray(raw)) {
    return raw
      .filter((value): value is string => typeof value === 'string')
      .map((value) => formOptionValueForLabel(value, options));
  }
  return undefined;
}

function formOptionValueForLabel(value: string, options: FormOption[] | undefined): string {
  const match = options?.find((option) => option.value === value || option.label === value);
  return match?.value ?? value;
}

function parseOptions(raw: unknown): FormOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options = raw.map((option) => {
    if (typeof option === 'string') {
      const label = option.trim();
      return label ? { label, value: label } : null;
    }
    if (!option || typeof option !== 'object') return null;
    const object = option as Record<string, unknown>;
    const label = typeof object.label === 'string' ? object.label.trim() : '';
    if (!label) return null;
    const value = typeof object.value === 'string' && object.value.trim()
      ? object.value.trim()
      : typeof object.id === 'string' && object.id.trim()
        ? object.id.trim()
        : label;
    return {
      label,
      value,
      ...(typeof object.description === 'string' && object.description.trim()
        ? { description: object.description.trim() }
        : {}),
    };
  }).filter((option): option is FormOption => option !== null);
  return options.length > 0 ? options : undefined;
}

function normalizeType(raw: unknown, options?: FormOption[]): QuestionType {
  if (typeof raw !== 'string') return options?.length ? 'radio' : 'text';
  const type = raw.toLowerCase().trim();
  if (type === 'radio' || type === 'single' || type === 'choice') return 'radio';
  if (type === 'checkbox' || type === 'multi' || type === 'multiple') return 'checkbox';
  if (type === 'select' || type === 'dropdown') return 'select';
  if (type === 'textarea' || type === 'long' || type === 'paragraph') return 'textarea';
  if (type === 'number' || type === 'numeric') return 'number';
  if (type === 'range' || type === 'slider') return 'range';
  if (type === 'datetime' || type === 'date-time' || type === 'datetime_local') return 'datetime-local';
  if (type === 'colour' || type === 'color-picker') return 'color';
  if (type === 'link') return 'url';
  if (type === 'phone') return 'tel';
  if (type === 'upload' || type === 'attachment') return 'file';
  if (type === 'toggle' || type === 'boolean') return 'switch';
  if (type === 'directions' || type === 'cards' || type === 'direction') return 'direction-cards';
  return type as QuestionType;
}

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

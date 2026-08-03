import type Database from 'better-sqlite3';
import type { FormQuestion, QuestionForm } from '@open-design/contracts';

type SqliteDb = Database.Database;

export type DiscoverySessionStatus =
  | 'waiting_for_user'
  | 'ready'
  | 'canceled'
  | 'expired';

export type DiscoverySubmissionAction =
  | 'submit'
  | 'accept_defaults'
  | 'skip';

export interface DiscoverySubmission {
  action: DiscoverySubmissionAction;
  answers?: Record<string, unknown>;
  additionalContext?: string;
}

export interface DiscoverySession {
  id: string;
  projectId: string;
  conversationId: string;
  status: DiscoverySessionStatus;
  initialRequest: string;
  form: QuestionForm;
  answers: Record<string, unknown>;
  submissionAction: DiscoverySubmissionAction | null;
  additionalContext: string;
  currentQuestionIndex: number;
  createdAt: number;
  updatedAt: number;
}

export class DiscoverySessionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'DISCOVERY_NOT_FOUND'
      | 'DISCOVERY_INVALID_STATUS'
      | 'DISCOVERY_QUESTION_OUT_OF_ORDER'
      | 'DISCOVERY_INVALID_ANSWERS',
  ) {
    super(message);
    this.name = 'DiscoverySessionError';
  }
}

export function createDiscoverySession(
  db: SqliteDb,
  input: Pick<DiscoverySession, 'id' | 'projectId' | 'conversationId' | 'form'> & {
    initialRequest?: string;
  },
): DiscoverySession {
  const now = Date.now();
  db.prepare(
    `INSERT INTO discovery_sessions
       (id, project_id, conversation_id, status, initial_request, form_json,
        answers_json, submission_action, additional_context,
        current_question_index, created_at, updated_at)
     VALUES (?, ?, ?, 'waiting_for_user', ?, ?, ?, NULL, '', 0, ?, ?)`,
  ).run(
    input.id,
    input.projectId,
    input.conversationId,
    input.initialRequest?.trim() ?? '',
    JSON.stringify(input.form),
    JSON.stringify({}),
    now,
    now,
  );
  return getDiscoverySessionOrThrow(db, input.id);
}

export function getDiscoverySession(
  db: SqliteDb,
  id: string,
): DiscoverySession | null {
  const record = db
    .prepare(
      `SELECT id, project_id AS projectId, conversation_id AS conversationId,
              status, initial_request AS initialRequest,
              form_json AS formJson, answers_json AS answersJson,
              submission_action AS submissionAction,
              additional_context AS additionalContext,
              current_question_index AS currentQuestionIndex,
              created_at AS createdAt, updated_at AS updatedAt
         FROM discovery_sessions
        WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return record ? normalizeDiscoverySession(record) : null;
}

export function getDiscoverySessionOrThrow(
  db: SqliteDb,
  id: string,
): DiscoverySession {
  const session = getDiscoverySession(db, id);
  if (!session) {
    throw new DiscoverySessionError(
      `Discovery session not found: ${id}`,
      'DISCOVERY_NOT_FOUND',
    );
  }
  return session;
}

export function getCurrentDiscoveryQuestion(
  session: DiscoverySession,
) {
  return session.form.questions[session.currentQuestionIndex] ?? null;
}

/**
 * Persist exactly one answer and advance the session atomically.
 * The question id is checked against the persisted cursor so a stale or
 * duplicated client cannot silently overwrite a later answer.
 */
export function answerDiscoveryQuestion(
  db: SqliteDb,
  id: string,
  questionId: string,
  answer: unknown,
): DiscoverySession {
  const transaction = db.transaction(() => {
    const session = getDiscoverySessionOrThrow(db, id);
    if (session.status !== 'waiting_for_user') {
      throw new DiscoverySessionError(
        `Discovery session is ${session.status}, not waiting_for_user.`,
        'DISCOVERY_INVALID_STATUS',
      );
    }
    const question = getCurrentDiscoveryQuestion(session);
    if (!question || question.id !== questionId) {
      throw new DiscoverySessionError(
        `Expected question ${question?.id ?? '(none)'}, received ${questionId}.`,
        'DISCOVERY_QUESTION_OUT_OF_ORDER',
      );
    }

    const answers = { ...session.answers, [questionId]: answer };
    const nextIndex = session.currentQuestionIndex + 1;
    const nextStatus: DiscoverySessionStatus =
      nextIndex >= session.form.questions.length ? 'ready' : 'waiting_for_user';
    const updatedAt = Date.now();

    db.prepare(
      `UPDATE discovery_sessions
          SET status = ?, answers_json = ?,
              submission_action = CASE WHEN ? = 'ready' THEN 'submit' ELSE submission_action END,
              current_question_index = ?, updated_at = ?
        WHERE id = ? AND status = 'waiting_for_user'
          AND current_question_index = ?`,
    ).run(
      nextStatus,
      JSON.stringify(answers),
      nextStatus,
      nextIndex,
      updatedAt,
      id,
      session.currentQuestionIndex,
    );
  });
  transaction();
  return getDiscoverySessionOrThrow(db, id);
}

/**
 * Submit the complete single-shot form in one operation.
 * This is the primary scheme-2A path; answerDiscoveryQuestion remains as a
 * compatibility experiment for clients that intentionally want sequential
 * interviewing.
 */
export function submitDiscoveryAnswers(
  db: SqliteDb,
  id: string,
  submission: DiscoverySubmission,
): DiscoverySession {
  const transaction = db.transaction(() => {
    const session = getDiscoverySessionOrThrow(db, id);
    if (session.status !== 'waiting_for_user') {
      throw new DiscoverySessionError(
        `Discovery session is ${session.status}, not waiting_for_user.`,
        'DISCOVERY_INVALID_STATUS',
      );
    }
    const action = submission.action;
    if (action !== 'submit' && action !== 'accept_defaults' && action !== 'skip') {
      throw new DiscoverySessionError(
        `Invalid discovery submission action: ${String(action)}`,
        'DISCOVERY_INVALID_ANSWERS',
      );
    }
    const suppliedAnswers = submission.answers ?? {};
    const questionIds = new Set(session.form.questions.map((question) => question.id));
    const unknown = Object.keys(suppliedAnswers).filter((questionId) => !questionIds.has(questionId));
    if (unknown.length > 0) {
      throw new DiscoverySessionError(
        `Unknown discovery question ids: ${unknown.join(', ')}`,
        'DISCOVERY_INVALID_ANSWERS',
      );
    }
    const answers = action === 'skip'
      ? {}
      : action === 'accept_defaults'
        ? defaultDiscoveryAnswers(session.form)
        : suppliedAnswers;
    validateDiscoveryAnswers(session.form, answers, action === 'submit');
    const additionalContext = submission.additionalContext?.trim() ?? '';
    db.prepare(
      `UPDATE discovery_sessions
          SET status = 'ready', answers_json = ?, submission_action = ?,
              additional_context = ?, current_question_index = ?, updated_at = ?
        WHERE id = ? AND status = 'waiting_for_user'`,
    ).run(
      JSON.stringify(answers),
      action,
      additionalContext,
      session.form.questions.length,
      Date.now(),
      id,
    );
  });
  transaction();
  return getDiscoverySessionOrThrow(db, id);
}

/** Build the handoff text consumed by the next start_run call. */
export function buildDiscoveryBrief(session: DiscoverySession): string {
  const lines = [`# ${session.form.title}`, ''];
  if (session.initialRequest) {
    lines.push('## Original request', session.initialRequest, '');
  }
  if (session.submissionAction) {
    lines.push('## Discovery response', renderSubmissionAction(session.submissionAction), '');
  }
  for (const question of session.form.questions) {
    if (!Object.prototype.hasOwnProperty.call(session.answers, question.id)) continue;
    const answer = session.answers[question.id];
    const rendered = renderDiscoveryAnswer(question, answer);
    lines.push(`## ${question.label}`, rendered, '');
  }
  if (session.additionalContext) {
    lines.push('## Additional context', session.additionalContext, '');
  }
  return lines.join('\n').trim();
}

function defaultDiscoveryAnswers(form: QuestionForm): Record<string, unknown> {
  return Object.fromEntries(
    form.questions
      .filter((question) => question.defaultValue !== undefined)
      .map((question) => [question.id, question.defaultValue]),
  );
}

function validateDiscoveryAnswers(
  form: QuestionForm,
  answers: Record<string, unknown>,
  enforceRequired: boolean,
): void {
  const missing = enforceRequired
    ? form.questions
        .filter((question) => question.required && !Object.prototype.hasOwnProperty.call(answers, question.id))
        .map((question) => question.id)
    : [];
  if (missing.length > 0) {
    throw new DiscoverySessionError(
      `Missing required discovery answers: ${missing.join(', ')}`,
      'DISCOVERY_INVALID_ANSWERS',
    );
  }

  for (const question of form.questions) {
    if (!Object.prototype.hasOwnProperty.call(answers, question.id)) continue;
    validateDiscoveryAnswer(question, answers[question.id]);
  }
}

function validateDiscoveryAnswer(question: FormQuestion, answer: unknown): void {
  // Null is an explicit per-question skip. Omitting the key means the user
  // simply left an optional question unanswered.
  if (answer === null) return;
  const invalid = (reason: string): never => {
    throw new DiscoverySessionError(
      `Invalid answer for ${question.id}: ${reason}`,
      'DISCOVERY_INVALID_ANSWERS',
    );
  };
  const isKnownOption = (value: string): boolean =>
    question.options?.some((option) => option.value === value || option.label === value) ?? false;
  const assertOptionOrCustom = (value: string): void => {
    if (question.options && !isKnownOption(value) && question.allowCustom === false) {
      invalid(`value "${value}" is not one of the allowed options`);
    }
  };

  if (question.type === 'checkbox') {
    if (!Array.isArray(answer)) invalid('checkbox answers must be an array of strings');
    const values = answer as unknown[];
    if (values.some((value) => typeof value !== 'string')) {
      invalid('checkbox answers must be an array of strings');
    }
    if (question.maxSelections !== undefined && values.length > question.maxSelections) {
      invalid(`at most ${question.maxSelections} selections are allowed`);
    }
    for (const value of values) assertOptionOrCustom(value as string);
    return;
  }
  if (question.type === 'radio' || question.type === 'select' || question.type === 'direction-cards') {
    if (typeof answer !== 'string') invalid(`${question.type} answers must be strings`);
    assertOptionOrCustom(answer as string);
    return;
  }
  if (question.type === 'number' || question.type === 'range') {
    const numeric = typeof answer === 'number' ? answer : Number(answer);
    if (!Number.isFinite(numeric)) invalid(`${question.type} answers must be numeric`);
    return;
  }
  if (question.type === 'switch') {
    if (typeof answer !== 'boolean' && answer !== 'true' && answer !== 'false') {
      invalid('switch answers must be boolean');
    }
    return;
  }
  if (question.type === 'file' && question.multiple) {
    if (!Array.isArray(answer) || answer.some((value) => typeof value !== 'string')) {
      invalid('multiple file answers must be an array of strings');
    }
    return;
  }
  if (typeof answer !== 'string') invalid(`${question.type} answers must be strings`);
}

function renderDiscoveryAnswer(question: FormQuestion, answer: unknown): string {
  if (answer === null) return 'Skipped by user';
  const renderValue = (value: unknown): string => {
    const raw = String(value ?? '');
    const option = question.options?.find(
      (candidate) => candidate.value === raw || candidate.label === raw,
    );
    return option ? `${option.label} (${option.value})` : raw;
  };
  if (Array.isArray(answer)) return answer.map(renderValue).join(', ');
  if (typeof answer === 'object' && answer !== null) return JSON.stringify(answer);
  return renderValue(answer);
}

function renderSubmissionAction(action: DiscoverySubmissionAction): string {
  if (action === 'accept_defaults') return 'User accepted the recommended defaults.';
  if (action === 'skip') return 'User skipped the discovery form; infer missing details from the original request.';
  return 'User submitted or confirmed the answers below.';
}

export function cancelDiscoverySession(
  db: SqliteDb,
  id: string,
): DiscoverySession {
  const session = getDiscoverySessionOrThrow(db, id);
  if (session.status === 'ready' || session.status === 'canceled') return session;
  db.prepare(
    `UPDATE discovery_sessions SET status = 'canceled', updated_at = ? WHERE id = ?`,
  ).run(Date.now(), id);
  return getDiscoverySessionOrThrow(db, id);
}

function normalizeDiscoverySession(
  record: Record<string, unknown>,
): DiscoverySession {
  const status = record.status;
  if (
    status !== 'waiting_for_user' &&
    status !== 'ready' &&
    status !== 'canceled' &&
    status !== 'expired'
  ) {
    throw new Error(`Invalid discovery session status: ${String(status)}`);
  }
  return {
    id: String(record.id),
    projectId: String(record.projectId),
    conversationId: String(record.conversationId),
    status,
    initialRequest: typeof record.initialRequest === 'string' ? record.initialRequest : '',
    form: JSON.parse(String(record.formJson)) as QuestionForm,
    answers: JSON.parse(String(record.answersJson)) as Record<string, unknown>,
    submissionAction: normalizeSubmissionAction(record.submissionAction),
    additionalContext: typeof record.additionalContext === 'string' ? record.additionalContext : '',
    currentQuestionIndex: Number(record.currentQuestionIndex),
    createdAt: Number(record.createdAt),
    updatedAt: Number(record.updatedAt),
  };
}

function normalizeSubmissionAction(value: unknown): DiscoverySubmissionAction | null {
  return value === 'submit' || value === 'accept_defaults' || value === 'skip'
    ? value
    : null;
}

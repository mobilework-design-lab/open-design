import type Database from 'better-sqlite3';
import type { QuestionForm } from '@open-design/contracts';

type SqliteDb = Database.Database;

export type DiscoverySessionStatus =
  | 'waiting_for_user'
  | 'ready'
  | 'canceled'
  | 'expired';

export interface DiscoverySession {
  id: string;
  projectId: string;
  conversationId: string;
  status: DiscoverySessionStatus;
  form: QuestionForm;
  answers: Record<string, unknown>;
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
  input: Pick<DiscoverySession, 'id' | 'projectId' | 'conversationId' | 'form'>,
): DiscoverySession {
  const now = Date.now();
  db.prepare(
    `INSERT INTO discovery_sessions
       (id, project_id, conversation_id, status, form_json, answers_json,
        current_question_index, created_at, updated_at)
     VALUES (?, ?, ?, 'waiting_for_user', ?, ?, 0, ?, ?)`,
  ).run(
    input.id,
    input.projectId,
    input.conversationId,
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
              status, form_json AS formJson, answers_json AS answersJson,
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
          SET status = ?, answers_json = ?, current_question_index = ?, updated_at = ?
        WHERE id = ? AND status = 'waiting_for_user'
          AND current_question_index = ?`,
    ).run(
      nextStatus,
      JSON.stringify(answers),
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
  answers: Record<string, unknown>,
): DiscoverySession {
  const transaction = db.transaction(() => {
    const session = getDiscoverySessionOrThrow(db, id);
    if (session.status !== 'waiting_for_user') {
      throw new DiscoverySessionError(
        `Discovery session is ${session.status}, not waiting_for_user.`,
        'DISCOVERY_INVALID_STATUS',
      );
    }
    const questionIds = new Set(session.form.questions.map((question) => question.id));
    const unknown = Object.keys(answers).filter((questionId) => !questionIds.has(questionId));
    if (unknown.length > 0) {
      throw new DiscoverySessionError(
        `Unknown discovery question ids: ${unknown.join(', ')}`,
        'DISCOVERY_INVALID_ANSWERS',
      );
    }
    const missing = session.form.questions
      .filter((question) => question.required && !Object.prototype.hasOwnProperty.call(answers, question.id))
      .map((question) => question.id);
    if (missing.length > 0) {
      throw new DiscoverySessionError(
        `Missing required discovery answers: ${missing.join(', ')}`,
        'DISCOVERY_INVALID_ANSWERS',
      );
    }
    db.prepare(
      `UPDATE discovery_sessions
          SET status = 'ready', answers_json = ?, current_question_index = ?, updated_at = ?
        WHERE id = ? AND status = 'waiting_for_user'`,
    ).run(JSON.stringify(answers), session.form.questions.length, Date.now(), id);
  });
  transaction();
  return getDiscoverySessionOrThrow(db, id);
}

/** Build the handoff text consumed by the next start_run call. */
export function buildDiscoveryBrief(session: DiscoverySession): string {
  const lines = [`# ${session.form.title}`, ''];
  for (const question of session.form.questions) {
    if (!Object.prototype.hasOwnProperty.call(session.answers, question.id)) continue;
    const answer = session.answers[question.id];
    const rendered = Array.isArray(answer)
      ? answer.map((value) => String(value)).join(', ')
      : typeof answer === 'object' && answer !== null
        ? JSON.stringify(answer)
        : String(answer ?? '');
    lines.push(`## ${question.label}`, rendered, '');
  }
  return lines.join('\n').trim();
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
    form: JSON.parse(String(record.formJson)) as QuestionForm,
    answers: JSON.parse(String(record.answersJson)) as Record<string, unknown>,
    currentQuestionIndex: Number(record.currentQuestionIndex),
    createdAt: Number(record.createdAt),
    updatedAt: Number(record.updatedAt),
  };
}

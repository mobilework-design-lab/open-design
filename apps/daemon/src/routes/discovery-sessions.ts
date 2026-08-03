import type { Express } from 'express';
import type { QuestionForm } from '@open-design/contracts';
import { randomUUID } from 'node:crypto';
import {
  getConversation,
  getProject,
} from '../db.js';
import type { RouteDeps } from '../server-context.js';
import {
  answerDiscoveryQuestion,
  buildDiscoveryBrief,
  cancelDiscoverySession,
  createDiscoverySession,
  getCurrentDiscoveryQuestion,
  getDiscoverySession,
  submitDiscoveryAnswers,
  DiscoverySessionError,
} from '../discovery-session.js';

export interface RegisterDiscoverySessionRoutesDeps extends RouteDeps<'db' | 'http'> {}

function isQuestionForm(value: unknown): value is QuestionForm {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const form = value as Record<string, unknown>;
  return (
    typeof form.id === 'string' &&
    typeof form.title === 'string' &&
    Array.isArray(form.questions) &&
    form.questions.length > 0
  );
}

function discoveryResponse(session: ReturnType<typeof getDiscoverySession>) {
  if (!session) return { session: null, currentQuestion: null, awaitingUser: false };
  const awaitingUser = session.status === 'waiting_for_user';
  return {
    session,
    currentQuestion: awaitingUser ? getCurrentDiscoveryQuestion(session) : null,
    awaitingUser,
    ...(session.status === 'ready' ? {
      brief: buildDiscoveryBrief(session),
      nextAction: 'call start_run with the brief',
    } : {}),
  };
}

function sendDiscoveryError(res: any, error: unknown) {
  if (error instanceof DiscoverySessionError) {
    const status = error.code === 'DISCOVERY_NOT_FOUND'
      ? 404
      : error.code === 'DISCOVERY_INVALID_ANSWERS'
        ? 400
        : 409;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  return res.status(400).json({
    error: error instanceof Error ? error.message : String(error),
    code: 'BAD_REQUEST',
  });
}

export function registerDiscoverySessionRoutes(
  app: Express,
  ctx: RegisterDiscoverySessionRoutesDeps,
): void {
  const { db } = ctx;

  app.post('/api/discovery-sessions', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
    if (!projectId || !conversationId || !isQuestionForm(body.form)) {
      return res.status(400).json({
        error: 'projectId, conversationId, and a non-empty form are required',
        code: 'BAD_REQUEST',
      });
    }
    const project = getProject(db, projectId);
    const conversation = getConversation(db, conversationId);
    if (!project) return res.status(404).json({ error: 'project not found', code: 'PROJECT_NOT_FOUND' });
    if (!conversation || conversation.projectId !== projectId) {
      return res.status(404).json({ error: 'conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    }

    try {
      const session = createDiscoverySession(db, {
        id: typeof body.id === 'string' && body.id ? body.id : randomUUID(),
        projectId,
        conversationId,
        form: body.form,
      });
      return res.status(201).json(discoveryResponse(session));
    } catch (error) {
      return sendDiscoveryError(res, error);
    }
  });

  app.get('/api/discovery-sessions/:id', (req, res) => {
    const session = getDiscoverySession(db, req.params.id);
    if (!session) return res.status(404).json({ error: 'discovery session not found', code: 'DISCOVERY_NOT_FOUND' });
    return res.json(discoveryResponse(session));
  });

  app.post('/api/discovery-sessions/:id/answer', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.questionId !== 'string' || !body.questionId) {
      return res.status(400).json({ error: 'questionId is required', code: 'BAD_REQUEST' });
    }
    try {
      const session = answerDiscoveryQuestion(
        db,
        req.params.id,
        body.questionId,
        body.answer,
      );
      return res.json(discoveryResponse(session));
    } catch (error) {
      return sendDiscoveryError(res, error);
    }
  });

  app.post('/api/discovery-sessions/:id/submit', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) {
      return res.status(400).json({ error: 'answers must be an object', code: 'BAD_REQUEST' });
    }
    try {
      const session = submitDiscoveryAnswers(
        db,
        req.params.id,
        body.answers as Record<string, unknown>,
      );
      return res.json(discoveryResponse(session));
    } catch (error) {
      return sendDiscoveryError(res, error);
    }
  });

  app.post('/api/discovery-sessions/:id/cancel', (req, res) => {
    try {
      const session = cancelDiscoverySession(db, req.params.id);
      return res.json(discoveryResponse(session));
    } catch (error) {
      return sendDiscoveryError(res, error);
    }
  });
}

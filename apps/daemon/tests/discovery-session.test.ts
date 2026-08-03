import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
} from '../src/db.js';
import {
  answerDiscoveryQuestion,
  cancelDiscoverySession,
  createDiscoverySession,
  DiscoverySessionError,
  getCurrentDiscoveryQuestion,
  getDiscoverySession,
  submitDiscoveryAnswers,
} from '../src/discovery-session.js';

describe('discovery session persistence', () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    closeDatabase();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('persists a form, advances one question at a time, and reaches ready', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-discovery-'));
    const db = openDatabase(dataDir, { dataDir });
    insertProject(db, { id: 'project-1', name: 'Test project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, {
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'Discovery',
      createdAt: 1,
      updatedAt: 1,
    });

    const session = createDiscoverySession(db, {
      id: 'discovery-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      form: {
        id: 'discovery',
        title: 'Questions',
        questions: [
          { id: 'platform', label: 'Platform', type: 'text' },
          { id: 'renderMode', label: 'Render mode', type: 'text' },
        ],
      },
    });

    expect(session.status).toBe('waiting_for_user');
    expect(getCurrentDiscoveryQuestion(session)?.id).toBe('platform');

    const afterFirst = answerDiscoveryQuestion(db, 'discovery-1', 'platform', 'responsive-web');
    expect(afterFirst.status).toBe('waiting_for_user');
    expect(getCurrentDiscoveryQuestion(afterFirst)?.id).toBe('renderMode');

    const afterSecond = answerDiscoveryQuestion(db, 'discovery-1', 'renderMode', 'static');
    expect(afterSecond.status).toBe('ready');
    expect(afterSecond.answers).toEqual({ platform: 'responsive-web', renderMode: 'static' });
    expect(getCurrentDiscoveryQuestion(afterSecond)).toBeNull();

    closeDatabase();
    const reopened = openDatabase(dataDir, { dataDir });
    expect(getDiscoverySession(reopened, 'discovery-1')?.answers).toEqual({
      platform: 'responsive-web',
      renderMode: 'static',
    });
  });

  it('rejects stale or out-of-order answers', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-discovery-'));
    const db = openDatabase(dataDir, { dataDir });
    insertProject(db, { id: 'project-1', name: 'Test project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'conversation-1', projectId: 'project-1', createdAt: 1, updatedAt: 1 });
    createDiscoverySession(db, {
      id: 'discovery-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      form: {
        id: 'discovery',
        title: 'Questions',
        questions: [{ id: 'platform', label: 'Platform', type: 'text' }],
      },
    });

    expect(() => answerDiscoveryQuestion(db, 'discovery-1', 'renderMode', 'static'))
      .toThrowError(DiscoverySessionError);
  });

  it('supports cancellation as a terminal state', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-discovery-'));
    const db = openDatabase(dataDir, { dataDir });
    insertProject(db, { id: 'project-1', name: 'Test project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'conversation-1', projectId: 'project-1', createdAt: 1, updatedAt: 1 });
    createDiscoverySession(db, {
      id: 'discovery-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      form: {
        id: 'discovery',
        title: 'Questions',
        questions: [{ id: 'platform', label: 'Platform', type: 'text' }],
      },
    });

    expect(cancelDiscoverySession(db, 'discovery-1').status).toBe('canceled');
    expect(() => answerDiscoveryQuestion(db, 'discovery-1', 'platform', 'web'))
      .toThrowError(DiscoverySessionError);
  });

  it('supports scheme-2A single-shot form submission', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-discovery-'));
    const db = openDatabase(dataDir, { dataDir });
    insertProject(db, { id: 'project-1', name: 'Test project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'conversation-1', projectId: 'project-1', createdAt: 1, updatedAt: 1 });
    createDiscoverySession(db, {
      id: 'discovery-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      form: {
        id: 'discovery',
        title: 'Discovery',
        questions: [
          { id: 'platform', label: 'Platform', type: 'text', required: true },
          { id: 'renderMode', label: 'Render mode', type: 'text' },
        ],
      },
    });

    const submitted = submitDiscoveryAnswers(db, 'discovery-1', {
      platform: 'responsive-web',
      renderMode: 'static',
    });
    expect(submitted.status).toBe('ready');
    expect(submitted.currentQuestionIndex).toBe(2);
    expect(submitted.answers).toEqual({ platform: 'responsive-web', renderMode: 'static' });
  });
});

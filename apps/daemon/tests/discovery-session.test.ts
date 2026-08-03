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
  buildDiscoveryBrief,
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
      action: 'submit',
      answers: {
        platform: 'responsive-web',
        renderMode: 'static',
      },
    });
    expect(submitted.status).toBe('ready');
    expect(submitted.currentQuestionIndex).toBe(2);
    expect(submitted.answers).toEqual({ platform: 'responsive-web', renderMode: 'static' });
  });

  it('preserves the original request, option labels, and free-form context in the brief', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-discovery-'));
    const db = openDatabase(dataDir, { dataDir });
    insertProject(db, { id: 'project-1', name: 'Test project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'conversation-1', projectId: 'project-1', createdAt: 1, updatedAt: 1 });
    createDiscoverySession(db, {
      id: 'discovery-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      initialRequest: 'Create a SaaS admin platform.',
      form: {
        id: 'discovery',
        title: 'SaaS discovery',
        questions: [{
          id: 'platform',
          label: 'Target platform',
          type: 'radio',
          required: true,
          options: [{ label: 'Responsive web', value: 'responsive-web' }],
        }],
      },
    });

    const submitted = submitDiscoveryAnswers(db, 'discovery-1', {
      action: 'submit',
      answers: { platform: 'responsive-web' },
      additionalContext: 'Use our existing blue brand color.',
    });
    const brief = buildDiscoveryBrief(submitted);
    expect(submitted.submissionAction).toBe('submit');
    expect(brief).toContain('Create a SaaS admin platform.');
    expect(brief).toContain('Responsive web (responsive-web)');
    expect(brief).toContain('Use our existing blue brand color.');
  });

  it('accepts recommended defaults without treating them as prior user answers', async () => {
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
        title: 'Defaults',
        questions: [
          { id: 'platform', label: 'Platform', type: 'radio', required: true, defaultValue: 'web' },
          { id: 'style', label: 'Style', type: 'text', defaultValue: 'modern' },
        ],
      },
    });

    const submitted = submitDiscoveryAnswers(db, 'discovery-1', {
      action: 'accept_defaults',
    });
    expect(submitted.status).toBe('ready');
    expect(submitted.answers).toEqual({ platform: 'web', style: 'modern' });
    expect(buildDiscoveryBrief(submitted)).toContain('User accepted the recommended defaults.');
  });

  it('allows skipping the form while retaining the original request', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-discovery-'));
    const db = openDatabase(dataDir, { dataDir });
    insertProject(db, { id: 'project-1', name: 'Test project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'conversation-1', projectId: 'project-1', createdAt: 1, updatedAt: 1 });
    createDiscoverySession(db, {
      id: 'discovery-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      initialRequest: 'Create a SaaS admin platform.',
      form: {
        id: 'discovery',
        title: 'Optional discovery',
        questions: [{ id: 'platform', label: 'Platform', type: 'text', required: true }],
      },
    });

    const submitted = submitDiscoveryAnswers(db, 'discovery-1', {
      action: 'skip',
      additionalContext: 'Make reasonable decisions for anything unspecified.',
    });
    expect(submitted.status).toBe('ready');
    expect(submitted.answers).toEqual({});
    expect(buildDiscoveryBrief(submitted)).toContain('Create a SaaS admin platform.');
    expect(buildDiscoveryBrief(submitted)).toContain('User skipped the discovery form');
  });

  it('accepts custom choices by default and enforces closed choices and selection limits', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-discovery-'));
    const db = openDatabase(dataDir, { dataDir });
    insertProject(db, { id: 'project-1', name: 'Test project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'conversation-1', projectId: 'project-1', createdAt: 1, updatedAt: 1 });

    const makeSession = (id: string, allowCustom?: boolean) => createDiscoverySession(db, {
      id,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      form: {
        id: 'discovery',
        title: 'Choices',
        questions: [
          {
            id: 'style',
            label: 'Style',
            type: 'radio',
            options: [{ label: 'Modern', value: 'modern' }],
            ...(allowCustom === undefined ? {} : { allowCustom }),
          },
          {
            id: 'modules',
            label: 'Modules',
            type: 'checkbox',
            options: [
              { label: 'Dashboard', value: 'dashboard' },
              { label: 'Users', value: 'users' },
            ],
            maxSelections: 1,
          },
        ],
      },
    });

    makeSession('custom-allowed');
    expect(submitDiscoveryAnswers(db, 'custom-allowed', {
      action: 'submit',
      answers: { style: 'neo-brutalist' },
    }).answers.style).toBe('neo-brutalist');

    makeSession('custom-closed', false);
    expect(() => submitDiscoveryAnswers(db, 'custom-closed', {
      action: 'submit',
      answers: { style: 'neo-brutalist' },
    })).toThrowError(DiscoverySessionError);

    makeSession('too-many');
    expect(() => submitDiscoveryAnswers(db, 'too-many', {
      action: 'submit',
      answers: { modules: ['dashboard', 'users'] },
    })).toThrowError(DiscoverySessionError);
  });
});

import { describe, expect, it } from 'vitest';
import { findFirstQuestionForm } from '../src/question-form.js';

describe('findFirstQuestionForm', () => {
  it('extracts a dynamic form from surrounding assistant text', () => {
    const result = findFirstQuestionForm(`前置说明
<question-form id="discovery" title="需求收集">
{
  "questions": [
    {
      "id": "platform",
      "label": "目标平台是什么？",
      "type": "radio",
      "options": ["桌面端 Web", {"label": "响应式 Web", "value": "responsive-web"}],
      "required": true
    }
  ]
}
</question-form>
后置说明`);

    expect(result?.form.id).toBe('discovery');
    expect(result?.form.title).toBe('需求收集');
    expect(result?.form.questions).toHaveLength(1);
    expect(result?.form.questions[0]).toMatchObject({
      id: 'platform',
      label: '目标平台是什么？',
      type: 'radio',
      required: true,
    });
    expect(result?.form.questions[0]?.options).toEqual([
      { label: '桌面端 Web', value: '桌面端 Web' },
      { label: '响应式 Web', value: 'responsive-web' },
    ]);
  });

  it('accepts the ask-question alias and fenced JSON', () => {
    const result = findFirstQuestionForm(`<ask-question id='discovery'>
\`\`\`json
{"questions":[{"id":"audience","prompt":"目标用户是谁？","type":"text"}]}
\`\`\`
</ask-question>`);

    expect(result?.form.questions[0]).toMatchObject({
      id: 'audience',
      label: '目标用户是谁？',
      type: 'text',
    });
  });

  it('rejects missing, malformed, and empty forms', () => {
    expect(findFirstQuestionForm('没有表单')).toBeNull();
    expect(findFirstQuestionForm('<question-form>{bad}</question-form>')).toBeNull();
    expect(findFirstQuestionForm('<question-form>{"questions":[]}</question-form>')).toBeNull();
    expect(findFirstQuestionForm('<question-form>{"questions":[null]}</question-form>')).toBeNull();
  });

  it('normalizes recommended defaults and checkbox selection limits', () => {
    const result = findFirstQuestionForm(`<question-form id="constraints" title="Constraints">
{"questions":[{
  "id":"devices",
  "label":"Target devices",
  "type":"checkbox",
  "options":[{"label":"Desktop","value":"desktop"},{"label":"Mobile","value":"mobile"}],
  "default":["desktop"],
  "maxSelections":1
}]}
</question-form>`);

    expect(result?.form.questions[0]).toMatchObject({
      id: 'devices',
      defaultValue: ['desktop'],
      maxSelections: 1,
    });
  });
});

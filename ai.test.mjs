import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { checkAnswerWithAI, generateStudySetWithAI } from './ai.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockGemini(response, status = 200) {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
    };
  };
  return () => request;
}

function geminiResponse(value) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] };
}

test('Gemini study set generation sends only selected text and validates evidence', async () => {
  const text = 'Lecture p. 2\nMonte Carlo simulation generates random samples from a known input distribution to estimate outcomes.';
  const expectedEvidence = 'generates random samples from a known input distribution';
  const getRequest = mockGemini(geminiResponse({
    title: 'Monte Carlo basics',
    report: 'The lecture explains random sampling for estimating outcomes.',
    cards: [{ front: 'What does it generate?', back: 'Random samples.', source: 'Lecture p. 2', evidence: expectedEvidence }],
    quiz: [{ question: 'What does it generate?', options: ['Random samples', 'Fixed answers', 'Unknown inputs', 'No output'], answer: 'Random samples', explanation: 'The lecture says it generates random samples.', source: 'Lecture p. 2' }],
  }));

  const result = await generateStudySetWithAI('test-key', text, 'Physics', ['How does Monte Carlo estimate outcomes?'], 'source-hash', 'gemini');
  const request = getRequest();
  const body = JSON.parse(request.options.body);

  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(request.options.headers['x-goog-api-key'], 'test-key');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.contents[0].parts[0].text.includes(text), true);
  assert.deepEqual(body.contents[0].parts[0].text.includes('How does Monte Carlo estimate outcomes?'), true);
  assert.equal(result.sourceHash, 'source-hash');
  assert.equal(result.cards[0].evidence, expectedEvidence);
  assert.equal(result.quiz[0].answer, 'Random samples');
});

test('Gemini study set rejects a quiz with invalid option structure', async () => {
  mockGemini(geminiResponse({
    title: 'Study set',
    report: 'A source-based report.',
    cards: [{ front: 'Question', back: 'Answer', source: 'Lecture p. 2', evidence: '' }],
    quiz: [{ question: 'Pick one', options: ['Same', 'Same', 'Three', 'Four'], answer: 'Same', explanation: 'Invalid options.', source: 'Lecture p. 2' }],
  }));

  await assert.rejects(
    generateStudySetWithAI('test-key', 'Lecture p. 2\nThis lecture describes a sufficiently long study concept for testing.', 'Physics', [], 'source-hash', 'gemini'),
    /could not make a complete flashcard and quiz set/i,
  );
});

test('answer feedback retrieves a relevant passage and rejects a key error clearly', async () => {
  const source = 'Monte Carlo simulation generates random samples from a known input distribution.\n\nA separate section describes classroom attendance procedures.';
  const getRequest = mockGemini(geminiResponse({
    summary: '', keyPoints: [], vocabulary: [], questions: [],
    feedback: 'Your answer is supported by the lecture.', assessment: 'supported',
    evidence: 'generates random samples from a known input distribution',
  }));

  const result = await checkAnswerWithAI('test-key', source, 'How are outcomes estimated?', 'By generating random samples.', 'gemini');
  const requestBody = JSON.parse(getRequest().options.body);
  assert.equal(result.assessment, 'supported');
  assert.match(requestBody.contents[0].parts[0].text, /Monte Carlo simulation/);
  assert.doesNotMatch(requestBody.contents[0].parts[0].text, /classroom attendance/);

  mockGemini({ error: { message: 'Invalid API key' } }, 401);
  await assert.rejects(
    checkAnswerWithAI('test-key', source, 'How are outcomes estimated?', 'By generating random samples.', 'gemini'),
    /Gemini rejected this key/i,
  );
});

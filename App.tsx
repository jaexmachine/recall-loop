import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Alert,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { BlurTargetView, BlurView } from 'expo-blur';
import { StatusBar } from 'expo-status-bar';
import Svg, { Path } from 'react-native-svg';
import JSZip from 'jszip';
import mammoth from 'mammoth/mammoth.browser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parse as parsePowerPoint, renderSlideToSvg, slideText } from '@web-ppt/core';
import { checkAnswerWithAI, draftQuestionsWithAI, embedTexts, generateStudySetWithAI, summarizeWithAI, type AiProvider, type AiResult, type AiStudySet } from './ai';
import { StudySetStudio } from './StudySetStudio';
import { parseFlashcardCsv, parseMultipleChoiceCsv, parsePracticeQuizHtml, parseQuizResultsHtml, type ImportedFlashcard, type ImportedMultipleChoice } from './quizImport';
import { chunkSourceText, searchVectorRecords, type SourceChunkInput, type VectorRecord } from './vectorRag';

type Match = { question: string; passage: string; overlap: number; passageIndex: number | null; sourceLabel?: string; sourceFileId?: string; manual?: boolean };
type StudyAttempt = { id: string; question: string; mode: Pace; outcome: 'correct' | 'missed' | 'self-rated-ready' | 'needs-review'; createdAt: string };
type StudySegment = { label: string; text: string; sourceFileId?: string };
type StudyFile = { id: string; name: string; text: string; segments?: StudySegment[]; role: 'source' | 'questions' };
type OriginalDocument = { id: string; name: string; type: string; blob: Blob };
type SourceReader = { title: string; location: string; text: string };
type Subject = { id: string; name: string; notes: string; questionsText: string; files: StudyFile[]; flashcards?: ImportedFlashcard[]; multipleChoiceQuestions?: ImportedMultipleChoice[]; aiStudySet?: AiStudySet };
type SavedWorkspace = { version: 1 | 2; notes: string; questionsText: string; demoMaterial: boolean; matches: Match[]; attempted: number; correct: number; history: StudyAttempt[]; subjects: Subject[]; activeSubjectId: string | null; selectedSourceId: string | null; selectedSourceIds?: string[]; sourceScope: 'subject' | 'file' | 'notes' | 'selected' };
type Pace = 'cram' | 'steady' | 'deep';
type Phase = 'overview' | 'module' | 'diagnostic' | 'review' | 'check' | 'flashcardsDone';

const storageKey = 'recall-loop.workspace.v2';
const legacyStorageKey = 'recall-loop.workspace.v1';
const originalDbName = 'recall-loop.originals.v1';
const vectorIndexPrefix = 'vector-index:';
let originalsDatabasePromise: Promise<IDBDatabase> | null = null;

type VectorIndexEntry = { contentHash: string; provider: AiProvider; model: VectorRecord['model']; records: VectorRecord[] };

function vectorIndexKey(subjectId: string, sourceId: string) {
  return `${vectorIndexPrefix}${subjectId}:${sourceId}`;
}

function openOriginalsDatabase(): Promise<IDBDatabase> {
  if (originalsDatabasePromise) return originalsDatabasePromise;
  originalsDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(originalDbName, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('workspace')) db.createObjectStore('workspace');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { originalsDatabasePromise = null; };
      db.onversionchange = () => { db.close(); originalsDatabasePromise = null; };
      resolve(db);
    };
    request.onerror = () => { originalsDatabasePromise = null; reject(request.error || new Error('Could not open browser file storage.')); };
    request.onblocked = () => { originalsDatabasePromise = null; reject(new Error('Close other Recall Loop tabs to update browser storage.')); };
  });
  return originalsDatabasePromise;
}

async function loadWorkspaceSnapshot(): Promise<Partial<SavedWorkspace> | null> {
  const db = await openOriginalsDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readonly');
    const request = transaction.objectStore('workspace').get('current');
    request.onsuccess = () => resolve((request.result as Partial<SavedWorkspace> | undefined) || null);
    request.onerror = () => reject(request.error || new Error('Could not read the saved workspace.'));
    transaction.onabort = () => reject(transaction.error || new Error('Could not read the saved workspace.'));
  });
}

async function saveWorkspaceSnapshot(workspace: SavedWorkspace) {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(workspace, 'current');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save the workspace.'));
    transaction.onabort = () => reject(transaction.error || new Error('Could not save the workspace.'));
  });
}

async function clearWorkspaceSnapshot() {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').delete('current');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not clear the saved workspace.'));
    transaction.onabort = () => reject(transaction.error || new Error('Could not clear the saved workspace.'));
  });
}

async function getVectorIndex(subjectId: string, sourceId: string): Promise<VectorIndexEntry | null> {
  const db = await openOriginalsDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('workspace', 'readonly').objectStore('workspace').get(vectorIndexKey(subjectId, sourceId));
    request.onsuccess = () => resolve((request.result as VectorIndexEntry | undefined) || null);
    request.onerror = () => reject(request.error || new Error('Could not read the source index.'));
  });
}

async function saveVectorIndex(subjectId: string, sourceId: string, entry: VectorIndexEntry) {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(entry, vectorIndexKey(subjectId, sourceId));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save the source index.'));
    transaction.onabort = () => reject(transaction.error || new Error('Could not save the source index.'));
  });
}

async function deleteVectorIndex(subjectId: string, sourceId: string) {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').delete(vectorIndexKey(subjectId, sourceId));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not remove the source index.'));
  });
}

async function clearVectorIndexes() {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    const store = transaction.objectStore('workspace');
    const request = store.getAllKeys();
    request.onsuccess = () => request.result.filter((key) => typeof key === 'string' && key.startsWith(vectorIndexPrefix)).forEach((key) => store.delete(key));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not clear the source index.'));
  });
}

async function saveOriginalDocument(document: OriginalDocument) {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('documents', 'readwrite');
    transaction.objectStore('documents').put(document);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save the original file.'));
  });
}

async function getOriginalDocument(id: string): Promise<OriginalDocument | null> {
  const db = await openOriginalsDatabase();
  const result = await new Promise<OriginalDocument | null>((resolve, reject) => {
    const request = db.transaction('documents').objectStore('documents').get(id);
    request.onsuccess = () => resolve((request.result as OriginalDocument | undefined) || null);
    request.onerror = () => reject(request.error || new Error('Could not read the original file.'));
  });
  return result;
}

async function deleteOriginalDocument(id: string) {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('documents', 'readwrite');
    transaction.objectStore('documents').delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not remove the original file.'));
  });
}

async function clearOriginalDocuments() {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('documents', 'readwrite');
    transaction.objectStore('documents').clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not clear original files.'));
  });
}

async function replaceOriginalDocuments(documents: OriginalDocument[]) {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('documents', 'readwrite');
    const store = transaction.objectStore('documents');
    store.clear();
    documents.forEach((document) => store.put(document));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not restore original files.'));
    transaction.onabort = () => reject(transaction.error || new Error('Restore was cancelled before completion.'));
  });
}
const demoQuiz = [
  { question: 'Where does glycolysis take place, and what is its net ATP yield?', options: ['In the cytoplasm; net gain of 2 ATP', 'In the mitochondrial matrix; net gain of 30 ATP', 'At the inner mitochondrial membrane; no ATP made'], correct: 0, feedback: ['Glycolysis happens in the cytoplasm and produces a net gain of two ATP.', 'The mitochondrial matrix is where the citric acid cycle takes place. Glycolysis happens in the cytoplasm and has a net yield of 2 ATP.', 'The inner mitochondrial membrane is where oxidative phosphorylation happens. Glycolysis instead occurs in the cytoplasm and yields 2 ATP net.'] },
  { question: 'Which stage produces most of the ATP during cellular respiration?', options: ['Glycolysis', 'The citric acid cycle', 'Oxidative phosphorylation'], correct: 2, feedback: ['Glycolysis makes a small net gain of two ATP. Most ATP is made during oxidative phosphorylation.', 'The citric acid cycle produces some ATP, but oxidative phosphorylation produces most of it.', 'Oxidative phosphorylation produces most of the ATP as hydrogen ions flow through ATP synthase.'] },
  { question: 'What is the final electron acceptor in the electron transport chain?', options: ['Oxygen', 'NADH', 'ATP synthase'], correct: 0, feedback: ['Oxygen accepts the electrons at the end of the chain and combines with hydrogen to form water.', 'NADH donates electrons to the chain; oxygen is the final electron acceptor.', 'ATP synthase uses the hydrogen ion flow to make ATP; oxygen accepts the final electrons.'] },
];

const palette = {
  ink: '#f3f8f6', muted: '#b1c2c2', soft: '#081514', paper: 'rgba(16,35,35,0.76)',
  line: 'rgba(211,241,238,0.17)', navy: '#102927', navy2: '#19423c', yellow: '#f2cb72',
  yellowSoft: '#fff3b5', green: '#21815b', greenSoft: '#e5f4ea', blueSoft: '#e8f1f5',
  aqua: '#7bd9d0', coral: '#e08b72',
};

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: palette.soft },
  shell: { flex: 1, minHeight: 0, flexDirection: 'row' },
  sidebar: { width: 236, backgroundColor: 'rgba(5,17,12,0.76)', paddingHorizontal: 18, paddingTop: 26, paddingBottom: 22, justifyContent: 'space-between', borderRightWidth: 1, borderColor: 'rgba(255,255,255,0.10)' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 38 },
  navLabel: { color: '#91a1aa', fontSize: 11, fontWeight: '700', letterSpacing: 1.4, marginLeft: 12, marginBottom: 10, marginTop: 10 },
  navItem: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, marginBottom: 4, flexDirection: 'row', gap: 11, alignItems: 'center' },
  main: { flex: 1, minWidth: 0, minHeight: 0 },
  inner: { width: '100%', minWidth: 0, maxWidth: 1320, alignSelf: 'center', paddingHorizontal: 30 },
  header: { minHeight: 78, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', position: 'relative' },
  content: { width: '100%', minWidth: 0, paddingTop: 28, paddingBottom: 56, gap: 20 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  card: { minWidth: 0, backgroundColor: palette.paper, borderRadius: 22, borderWidth: 1, borderColor: palette.line, padding: 22, overflow: 'hidden', shadowColor: '#000000', shadowOpacity: 0.28, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 5 },
  ambience: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'hidden' },
  scrollBackdrop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'hidden', backgroundColor: palette.soft },
  backgroundBlur: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  glowA: { position: 'absolute', width: 520, height: 520, borderRadius: 260, backgroundColor: 'rgba(19,104,62,0.4)', top: -190, right: '12%' },
  glowB: { position: 'absolute', width: 460, height: 460, borderRadius: 230, backgroundColor: 'rgba(7,105,113,0.28)', bottom: -170, right: '8%' },
  glowC: { position: 'absolute', width: 380, height: 380, borderRadius: 190, backgroundColor: 'rgba(191,133,42,0.20)', bottom: '18%', left: '18%' },
  label: { fontSize: 11, fontWeight: '800', color: palette.muted, letterSpacing: 1.1, textTransform: 'uppercase' },
  title: { fontSize: 28, fontWeight: '800', color: palette.ink, letterSpacing: -0.7 },
  body: { fontSize: 14, color: palette.muted, lineHeight: 21 },
  small: { fontSize: 12, color: palette.muted, lineHeight: 18 },
  button: { minHeight: 44, backgroundColor: '#197447', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  secondaryButton: { minHeight: 44, borderWidth: 1, borderColor: palette.line, backgroundColor: 'rgba(255,255,255,0.06)', paddingVertical: 11, paddingHorizontal: 14, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 140, backgroundColor: 'rgba(5,14,11,0.62)', borderWidth: 1, borderColor: palette.line, borderRadius: 12, padding: 13, color: palette.ink, fontSize: 16, lineHeight: 23, textAlignVertical: 'top' },
});

function splitQuestions(raw: string) {
  return raw.split('\n').map((q) => q.trim().replace(/^\s*(?:\d+[.)]|[-*])\s*/, '')).filter(Boolean);
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function flashcardKey(card: ImportedFlashcard) {
  return `${card.front.trim().toLocaleLowerCase()}\u0000${card.source.trim().toLocaleLowerCase()}`;
}

function draftPracticeQuestions(notes: string) {
  const sentences = (notes.match(/[^.!?\n]+[.!?]?/g) || []).map((raw) => raw.trim()).filter((sentence) => sentence.length >= 35 && sentence.length <= 320 && terms(sentence).length >= 4);
  const counts = new Map<string, number>();
  sentences.forEach((sentence) => terms(sentence).forEach((term) => counts.set(term, (counts.get(term) || 0) + 1)));
  const ranked = sentences.map((sentence) => {
    const tokens = terms(sentence);
    const signals = (sentence.match(/\b(?:is|are|means|refers to|because|therefore|causes|results in|leads to|increases|decreases|requires|consists of|first|second|finally)\b/gi) || []).length;
    const numbers = (sentence.match(/\b\d+(?:\.\d+)?%?\b/g) || []).length;
    const score = tokens.reduce((total, term) => total + 1 / (counts.get(term) || 1), 0) + signals * 1.8 + numbers * 1.5 + Math.min(sentence.length, 180) / 180;
    let question = '';
    if (/final electron acceptor/i.test(sentence)) question = /electron transport chain/i.test(sentence) ? 'What is the final electron acceptor in the electron transport chain?' : 'What is the final electron acceptor?';
    else {
      const location = sentence.match(/^(.+?)\s+(happens|occurs|takes place)\s+(in|at|within)\s+(.+?)[.!?]?$/i);
      const definition = sentence.match(/^(.{3,65}?)\s+(is|are|means|refers to|consists of)\s+(.+?)[.!?]?$/i);
      const cause = sentence.match(/^(.{3,65}?)\s+(causes|results in|leads to|produces|increases|decreases)\s+(.+?)[.!?]?$/i);
      const production = sentence.match(/^(.{3,65}?)\s+(?:releases?|produces?|makes?|generates?|requires?)\s+(.+?)[.!?]?$/i);
      if (location) question = `Where does ${location[1].trim().toLowerCase()} ${location[2].toLowerCase() === 'happens' ? 'happen' : location[2].toLowerCase() === 'occurs' ? 'occur' : 'take place'}?`;
      else if (definition) question = `${definition[2].toLowerCase() === 'are' ? 'What are' : 'What is'} ${definition[1].trim()}?`;
      else if (cause) question = `What does ${cause[1].trim()} ${cause[2].toLowerCase() === 'causes' ? 'cause' : cause[2].toLowerCase() === 'results in' ? 'result in' : cause[2].toLowerCase() === 'leads to' ? 'lead to' : cause[2].toLowerCase()}?`;
      else if (production) {
        const verb = production[2].toLowerCase().replace(/s$/, '');
        question = `What does ${production[1].trim()} ${verb}?`;
      }
      else {
        const focus = [...new Set(tokens)].sort((a, b) => (counts.get(a) || 0) - (counts.get(b) || 0) || b.length - a.length)[0];
        if (focus) question = `Complete the key idea: ${sentence.replace(new RegExp(`\\b${focus}\\b`, 'i'), '_____')}`;
      }
    }
    return { question, score };
  }).filter((item) => item.question);
  const drafts: string[] = [];
  ranked.sort((a, b) => b.score - a.score).forEach(({ question }) => { if (!drafts.includes(question) && drafts.length < 15) drafts.push(question); });
  return drafts;
}

const stop = new Set('what which where when does did is are the a an and or in on of to for from with into this that take takes happens happen produces produce most each one'.split(' '));
function terms(s: string) { return [...new Set((s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !stop.has(w)))]; }

function asStudySegments(input: string | StudySegment[], sourceName = 'Subject notes'): StudySegment[] {
  if (Array.isArray(input)) return input;
  return input.split(/\n\s*\n/).map((text, index) => ({ label: `${sourceName} · paragraph ${index + 1}`, text: text.trim() })).filter((segment) => segment.text);
}

function buildMatches(input: string | StudySegment[], questions: string[]): Match[] {
  const passages = asStudySegments(input).flatMap((segment) => segment.text.split(/\n\s*\n/).map((passage) => ({ passage: passage.trim(), sourceLabel: segment.label, sourceFileId: segment.sourceFileId }))).filter(({ passage }) => passage.length > 45 && !/^[A-Z\s]+$/.test(passage)).map((item, index) => ({ ...item, passageIndex: index + 1 }));
  return questions.map((question) => {
    const qTerms = terms(question);
    const ranked = passages.map(({ passage, passageIndex, sourceLabel, sourceFileId }) => {
      const pTerms = new Set(terms(passage));
      const overlap = qTerms.filter((t) => pTerms.has(t)).length;
      let answerCue = 0;
      if (/\bfinal electron acceptor\b/i.test(question) && /\bfinal electron acceptor\b/i.test(passage)) answerCue += 5;
      if (/\bmost\b|\bmajority\b/i.test(question) && /\bmost of the (?:ATP|energy)\b/i.test(passage)) answerCue += 4;
      if (/\bwhere\b|\blocation\b|\bplace\b/i.test(question) && /\b(?:happens|occurs|takes place)\s+(?:in|at|within)\b/i.test(passage)) answerCue += 2;
      if (/\byield\b|\bhow many\b|\bnet\b/i.test(question) && /\bnet\s+(?:gain|yield)\b/i.test(passage)) answerCue += 2;
      return { passage, passageIndex, sourceLabel, sourceFileId, overlap, score: overlap + answerCue };
    }).sort((a, b) => b.score - a.score || b.overlap - a.overlap);
    return ranked[0] && ranked[0].overlap > 0 ? { question, ...ranked[0] } : { question, passage: 'No clear passage match yet. Review this question manually.', overlap: 0, passageIndex: null };
  });
}

function highlightedPassage(passage: string, question: string) {
  if (!passage || passage.startsWith('No clear passage')) return <Text style={{ color: palette.ink, fontSize: 15, lineHeight: 26 }}>{passage}</Text>;
  const primary: { start: number; end: number }[] = [];
  const addCaptured = (pattern: RegExp, phraseGroup: number) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(passage))) {
      const phrase = match[phraseGroup];
      const offset = match[0].toLowerCase().lastIndexOf(phrase.toLowerCase());
      if (offset >= 0) primary.push({ start: match.index + offset, end: match.index + offset + phrase.length });
    }
  };
  if (/\bwhere\b|\blocation\b|\bplace\b/i.test(question)) {
    const locations = [...passage.matchAll(/\b(?:happens|occurs|takes place)\s+(in|at|within)\s+((?:the\s+)?[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3})/gi)];
    locations.forEach((match) => {
      const phrase = `${match[1]} ${match[2]}`;
      const offset = match[0].toLowerCase().lastIndexOf(phrase.toLowerCase());
      if (offset >= 0) primary.push({ start: match.index! + offset, end: match.index! + offset + phrase.length });
    });
  }
  if (/\byield\b|\bhow many\b|\bamount\b|\bnet\b|\bproduce\b/i.test(question)) {
    addCaptured(/\b(net\s+(?:gain|yield)\s+of\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:ATP|NADH|FADH2))\b/gi, 1);
  }
  if (/\bmost\b|\bmajority\b/i.test(question)) {
    addCaptured(/\b((?:makes|produces|generates)\s+(?:most\s+of\s+)?(?:the\s+)?(?:ATP|energy))\b/gi, 1);
    addCaptured(/\b(most\s+of\s+the\s+(?:ATP|energy))\b/gi, 1);
  }
  if (/\bfinal electron acceptor\b/i.test(question)) {
    addCaptured(/\b([A-Z][a-z]+\s+is\s+the\s+final\s+electron\s+acceptor)\b/g, 1);
  }
  const spans = primary.map((span) => ({ ...span, primary: true }));
  const words = terms(question).sort((a, b) => b.length - a.length);
  words.forEach((word) => {
    const pattern = new RegExp(`\\b${word}\\b`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(passage))) {
      const span = { start: match.index, end: match.index + match[0].length };
      if (!spans.some((existing) => span.start < existing.end && span.end > existing.start)) spans.push({ ...span, primary: false });
    }
  });
  spans.sort((a, b) => a.start - b.start || Number(b.primary) - Number(a.primary));
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, index) => {
    if (span.start < cursor) return;
    if (span.start > cursor) parts.push(passage.slice(cursor, span.start));
    parts.push(<Text key={`highlight-${index}`} style={span.primary ? { backgroundColor: palette.yellow, color: '#193326', fontWeight: '900' } : { backgroundColor: 'rgba(245,216,94,0.17)', color: '#fff2ad', fontWeight: '700' }}>{passage.slice(span.start, span.end)}</Text>);
    cursor = span.end;
  });
  if (cursor < passage.length) parts.push(passage.slice(cursor));
  return <Text style={{ color: palette.ink, fontSize: 15, lineHeight: 26 }}>{parts}</Text>;
}

async function extractDocumentText(file: File): Promise<StudySegment[]> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'txt' || extension === 'md' || extension === 'markdown') return (await file.text()).split(/\n\s*\n/).map((text, index) => ({ label: `${file.name} · paragraph ${index + 1}`, text: text.trim() })).filter((segment) => segment.text);
  const data = await file.arrayBuffer();
  if (extension === 'docx') {
    const result = await mammoth.extractRawText({ arrayBuffer: data });
    return result.value.split(/\n\s*\n/).map((text, index) => ({ label: `${file.name} · paragraph ${index + 1}`, text: text.trim() })).filter((segment) => segment.text);
  }
  if (extension === 'ppt') {
    const presentation = await parsePowerPoint(data);
    try {
      return presentation.slides.map((slide, index) => ({ label: `${file.name} · slide ${index + 1}`, text: slideText(slide).trim() }));
    } finally {
      presentation.dispose?.();
    }
  }
  if (extension === 'pptx') {
    const archive = await JSZip.loadAsync(data);
    const slideFiles = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const presentationXml = await archive.file('ppt/presentation.xml')?.async('text');
    const relationshipsXml = await archive.file('ppt/_rels/presentation.xml.rels')?.async('text');
    let slideNames: string[] = [];
    if (presentationXml && relationshipsXml) {
      const presentation = new DOMParser().parseFromString(presentationXml, 'application/xml');
      const relationships = new DOMParser().parseFromString(relationshipsXml, 'application/xml');
      const targets = new Map([...relationships.getElementsByTagName('Relationship')].map((relationship) => [relationship.getAttribute('Id') || '', relationship.getAttribute('Target') || '']));
      const orderedTargets = [...presentation.getElementsByTagName('p:sldId')].map((slide) => targets.get(slide.getAttribute('r:id') || slide.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || '')).filter(Boolean) as string[];
      slideNames = orderedTargets.map((target) => new URL(target, 'https://recall-loop.local/ppt/presentation.xml').pathname.slice(1)).filter((path) => slideFiles.includes(path));
    }
    if (!slideNames.length) slideNames = slideFiles.sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
    const slides: StudySegment[] = [];
    for (const [index, name] of slideNames.entries()) {
      const xml = await archive.file(name)?.async('text');
      if (!xml) continue;
      const document = new DOMParser().parseFromString(xml, 'application/xml');
      const paragraphs = [...document.getElementsByTagName('a:p')].map((paragraph) => [...paragraph.getElementsByTagName('a:t')].map((node) => node.textContent || '').join('').trim()).filter(Boolean);
      slides.push({ label: `${file.name} · slide ${index + 1}`, text: paragraphs.join('\n\n') });
    }
    return slides;
  }
  if (extension === 'pdf') {
    if (typeof window !== 'undefined') {
      const basePath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname.slice(0, window.location.pathname.lastIndexOf('/') + 1);
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(`${basePath}pdf.worker.min.mjs`, window.location.origin).toString();
    }
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
    const pages: StudySegment[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let lineY: number | null = null;
      content.items.forEach((item: any) => {
        if (typeof item.str !== 'string' || !item.str.trim()) return;
        const y = Number(item.transform?.[5] ?? 0);
        if (lineY === null || Math.abs(y - lineY) > 2) { lines.push(item.str.trim()); lineY = y; }
        else lines[lines.length - 1] += ` ${item.str.trim()}`;
      });
      pages.push({ label: `${file.name} · page ${pageNumber}`, text: lines.join(' ') });
    }
    return pages;
  }
  throw new Error('Choose a PDF, DOCX, PPT, PPTX, TXT, or Markdown file.');
}

function ActionButton({ label, onPress, secondary = false, compact = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; compact?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} testID="torch-block" onPress={onPress} style={({ pressed }) => [secondary ? styles.secondaryButton : styles.button, { overflow: 'hidden' }, compact && { paddingVertical: 9, paddingHorizontal: 12 }, disabled && { opacity: 0.42 }, pressed && !disabled && { transform: [{ scale: 0.975 }], opacity: 0.96, backgroundColor: secondary ? 'rgba(190,255,216,0.17)' : 'rgba(188,255,218,0.28)', borderWidth: 1, borderColor: 'rgba(210,255,226,0.56)', shadowColor: '#b9ffd3', shadowOpacity: 0.22, shadowRadius: 16 }]}><Text style={{ color: secondary ? palette.ink : '#fff', fontWeight: '700', fontSize: compact ? 12 : 14, textAlign: 'center', flexShrink: 1 }}>{label}</Text></Pressable>;
}

function wrapMatchedWords(textRoot: Element, highlightTerms: string[], mode: 'slide' | 'pdf') {
  const usableTerms = [...new Set(highlightTerms.map((term) => term.trim()).filter((term) => term.length > 2))].sort((a, b) => b.length - a.length);
  if (!usableTerms.length) return;
  const escapedTerms = usableTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`\\b(${escapedTerms.join('|')})\\b`, 'gi');
  const walker = (textRoot.ownerDocument || document).createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
  const textNodes: Node[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Node);
  textNodes.forEach((textNode) => {
    const value = textNode.nodeValue || '';
    const parent = textNode.parentElement;
    if (!parent || parent.closest('style,title,desc,metadata')) return;
    const isPdfText = mode === 'pdf' && !!parent.closest('.recall-pdf-text-layer');
    const isSlideHtml = mode === 'slide' && !!parent.closest('foreignObject');
    if (!isPdfText && !isSlideHtml) return;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    let cursor = 0;
    const owner = textNode.ownerDocument || document;
    const fragment = owner.createDocumentFragment();
    while ((match = pattern.exec(value))) {
      if (match.index > cursor) fragment.appendChild(owner.createTextNode(value.slice(cursor, match.index)));
      const mark = owner.createElementNS('http://www.w3.org/1999/xhtml', 'span');
      mark.textContent = match[0];
      // Background-only inline styling keeps the source font, color, spacing, and line breaks intact.
      // PDF.js paints the page first and uses transparent text spans for selection. Blend
      // the inline mark into that page so the original glyphs stay visible underneath.
      mark.setAttribute('style', `background-color:rgba(255,220,78,${mode === 'pdf' ? '.64' : '.56'});border-radius:.1em;${isPdfText ? 'color:transparent;mix-blend-mode:multiply;' : ''}`);
      mark.setAttribute('data-recall-highlight', 'true');
      fragment.appendChild(mark);
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) fragment.appendChild(owner.createTextNode(value.slice(cursor)));
    if (cursor > 0) textNode.parentNode?.replaceChild(fragment, textNode);
  });
}

function highlightPdfPhrases(host: HTMLElement, textRoot: Element, phrases: string[]) {
  host.querySelector('[data-source-highlight-layer]')?.remove();
  const normalizeForSearch = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const searchablePhrases = [...new Set(phrases.map(normalizeForSearch).filter((phrase) => phrase.length >= 4))];
  if (!searchablePhrases.length) return;
  const walker = (textRoot.ownerDocument || document).createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
  const nodes: globalThis.Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as unknown as globalThis.Text);
  let normalizedText = '';
  const positions: { node: globalThis.Text; offset: number }[] = [];
  let pendingSpace: { node: globalThis.Text; offset: number } | null = null;
  nodes.forEach((node, nodeIndex) => {
    const value = node.nodeValue || '';
    if (nodeIndex > 0 && value && normalizedText && normalizedText.at(-1) !== ' ' && /[\p{L}\p{N}]/u.test(value[0])) {
      normalizedText += ' ';
      positions.push({ node, offset: 0 });
    }
    for (let offset = 0; offset < value.length; offset += 1) {
      const character = value[offset];
      if (!/[\p{L}\p{N}]/u.test(character)) {
        if (normalizedText && normalizedText.at(-1) !== ' ') pendingSpace = { node, offset };
        continue;
      }
      if (pendingSpace) { normalizedText += ' '; positions.push(pendingSpace); pendingSpace = null; }
      normalizedText += character.toLocaleLowerCase();
      positions.push({ node, offset });
    }
  });
  const lowerText = normalizedText;
  const hostRect = host.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('data-source-highlight-layer', 'true');
  overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2;';
  let highlighted = 0;
  const ranges: { start: number; end: number }[] = [];
  searchablePhrases.forEach((phrase) => {
    const target = phrase;
    let offset = lowerText.indexOf(target);
    while (offset >= 0 && highlighted < 12) {
      const end = offset + target.length;
      if (!ranges.some((range) => offset < range.end && end > range.start)) ranges.push({ start: offset, end });
      offset = lowerText.indexOf(target, end);
    }
  });
  ranges.slice(0, 12).forEach(({ start, end }) => {
    const first = positions[start];
    const last = positions[end - 1];
    if (!first || !last) return;
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    [...range.getClientRects()].forEach((rect) => {
      if (!rect.width || !rect.height) return;
      const mark = document.createElement('div');
      mark.style.cssText = `position:absolute;left:${rect.left - hostRect.left}px;top:${rect.top - hostRect.top}px;width:${rect.width}px;height:${rect.height}px;border-radius:2px;background:rgba(255,211,62,.46);mix-blend-mode:multiply;`;
      overlay.appendChild(mark);
      highlighted += 1;
    });
  });
  if (!highlighted) {
    const stopWords = new Set('this that with from into within their there about which while where when have has were will your does been being chapter explores foundations supported alongside remarkable'.split(' '));
    const contextTerms = [...new Set(searchablePhrases.flatMap((phrase) => phrase.split(' ')).filter((term) => term.length > 3 && !stopWords.has(term)))];
    const textElements = [...textRoot.querySelectorAll('span, text')].map((element) => {
      const elementText = normalizeForSearch(element.textContent || '');
      const rect = element.getBoundingClientRect();
      return { element, rect, terms: new Set(elementText.split(' ').filter((term) => contextTerms.includes(term))) };
    }).filter(({ rect, terms }) => rect.width > 0 && rect.height > 0 && terms.size > 0).sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
    const lines: { top: number; terms: Set<string>; elements: typeof textElements }[] = [];
    textElements.forEach((item) => {
      let line = lines.find((candidate) => Math.abs(candidate.top - item.rect.top) < Math.max(4, item.rect.height * 0.22));
      if (!line) { line = { top: item.rect.top, terms: new Set(), elements: [] }; lines.push(line); }
      item.terms.forEach((term) => line!.terms.add(term));
      line.elements.push(item);
    });
    lines.sort((left, right) => left.top - right.top);
    let bestLines = lines.slice(0, 2);
    let bestScore = -1;
    for (let index = 0; index < Math.max(1, lines.length - 1); index += 1) {
      const windowLines = lines.slice(index, index + 2);
      const score = new Set(windowLines.flatMap((line) => [...line.terms])).size;
      if (score > bestScore) { bestScore = score; bestLines = windowLines; }
    }
    bestLines.flatMap((line) => line.elements).forEach(({ rect }) => {
      const mark = document.createElement('div');
      mark.style.cssText = `position:absolute;left:${rect.left - hostRect.left}px;top:${rect.top - hostRect.top}px;width:${rect.width}px;height:${rect.height}px;border-radius:2px;background:rgba(255,211,62,.42);mix-blend-mode:multiply;`;
      overlay.appendChild(mark);
      highlighted += 1;
    });
  }
  if (highlighted) host.appendChild(overlay);
}

function findRelevantEvidence(passage: string, question: string) {
  const stopWords = new Set('what which where when does did is are the a an and or in on of to for from with into this that about your their they them have has was were complete idea key fill blank'.split(' '));
  const queryTerms = [...new Set((question.toLocaleLowerCase().match(/[a-z0-9]+/g) || []).filter((term) => term.length > 2 && !stopWords.has(term)))];
  const chunks = (passage.match(/[^.!?]+(?:[.!?]+|$)/g) || [passage]).map((chunk) => chunk.trim()).filter(Boolean);
  const scored = chunks.map((chunk, index) => {
    const text = chunk.toLocaleLowerCase();
    const score = queryTerms.reduce((total, term) => total + (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text) ? 1 : 0), 0);
    return { chunk, index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  const best = scored[0]?.chunk || passage.trim();
  if (best.length <= 360) return best;
  const bestText = best.toLocaleLowerCase();
  const firstTerm = queryTerms.find((term) => bestText.includes(term));
  const matchIndex = firstTerm ? bestText.indexOf(firstTerm) : 0;
  let start = Math.max(0, matchIndex - 130);
  let end = Math.min(best.length, start + 360);
  if (start > 0) { const boundary = best.indexOf(' ', start); if (boundary > 0 && boundary < start + 40) start = boundary + 1; }
  if (end < best.length) { const boundary = best.lastIndexOf(' ', end); if (boundary > start) end = boundary; }
  return best.slice(start, end).trim();
}

function underlineVectorMatches(textRoot: Element, highlightTerms: string[]) {
  const usableTerms = [...new Set(highlightTerms.map((term) => term.trim()).filter((term) => term.length > 2))].sort((a, b) => b.length - a.length);
  if (!usableTerms.length) return;
  const pattern = new RegExp(`\\b(${usableTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
  const walker = (textRoot.ownerDocument || document).createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Node);
  nodes.forEach((node) => {
    const parent = node.parentElement;
    if (!parent || parent.closest('foreignObject,style,title,desc,metadata') || !parent.closest('text,tspan')) return;
    const value = node.nodeValue || '';
    pattern.lastIndex = 0;
    if (!pattern.test(value)) return;
    pattern.lastIndex = 0;
    const owner = node.ownerDocument || document;
    const fragment = owner.createDocumentFragment();
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value))) {
      if (match.index > cursor) fragment.appendChild(owner.createTextNode(value.slice(cursor, match.index)));
      const markedRun = owner.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      markedRun.textContent = match[0];
      markedRun.setAttribute('style', 'text-decoration:underline;text-decoration-color:#c49200;text-decoration-thickness:0.13em;text-underline-offset:0.14em;');
      fragment.appendChild(markedRun);
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) fragment.appendChild(owner.createTextNode(value.slice(cursor)));
    if (cursor > 0) node.parentNode?.replaceChild(fragment, node);
  });
}

function sanitizePresentationSvg(svg: SVGSVGElement) {
  svg.querySelectorAll('script,iframe,object,embed').forEach((node) => node.remove());
  svg.querySelectorAll('style').forEach((style) => {
    if (/@import|url\(\s*['"]?(?:https?:|\/\/)/i.test(style.textContent || '')) style.remove();
  });
  svg.querySelectorAll('*').forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      if (/^(?:href|xlink:href)$/i.test(attribute.name) && attribute.value && !/^(?:#|data:image\/|blob:)/i.test(attribute.value)) element.removeAttribute(attribute.name);
      if (attribute.name.toLowerCase() === 'style' && /url\(\s*['"]?(?:https?:|\/\/)/i.test(attribute.value)) element.removeAttribute(attribute.name);
    });
  });
}

function RenderedPagePreview({ fileId, fileName, pageIndex, highlightPhrases, fallbackText }: { fileId: string; fileName: string; pageIndex: number; highlightPhrases: string[]; fallbackText: string }) {
  const hostRef = useRef<React.ComponentRef<typeof View> | null>(null);
  const [error, setError] = useState('');
  const [showFallbackText, setShowFallbackText] = useState(false);
  const normalizedPhrases = highlightPhrases.join('|');

  useEffect(() => {
    const host = hostRef.current as unknown as HTMLDivElement | null;
    if (!host) return;
    if (Platform.OS !== 'web') { host.style.display = 'none'; setError('Original page preview is available in the browser.'); return; }
    let cancelled = false;
    let disposePresentation: (() => void) | undefined;
    let activePdfTask: { cancel: () => void } | null = null;
    let activePdfDocument: any = null;
    let activeTextLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    let pdfObserver: ResizeObserver | null = null;
    let pdfResizeListener: (() => void) | null = null;
    let renderGeneration = 0;
    const phrasesForPage = normalizedPhrases ? normalizedPhrases.split('|').filter(Boolean) : [];
    setError('');
    setShowFallbackText(false);
    host.replaceChildren();
    host.style.position = 'relative';
    host.style.width = '100%';
    host.style.minHeight = '180px';
    host.style.overflow = 'hidden';
    host.style.background = '#fff';
    host.style.display = 'block';
    const showError = (message: string) => { host.style.display = 'none'; setError(message); };

    const render = async () => {
      try {
        const original = await getOriginalDocument(fileId);
        if (!original) throw new Error('The original file is no longer available in this browser.');
        const extension = fileName.split('.').pop()?.toLowerCase();
        if (extension === 'pptx' || extension === 'ppt') {
          const presentation = await parsePowerPoint(original.blob);
          disposePresentation = () => presentation.dispose?.();
          if (cancelled) { disposePresentation(); return; }
          const slide = presentation.slides[pageIndex];
          if (!slide) throw new Error('This slide could not be opened.');
          if (cancelled) return;
          const parsed = new DOMParser().parseFromString(renderSlideToSvg(presentation, slide), 'image/svg+xml');
          if (parsed.querySelector('parsererror')) throw new Error('This slide could not be rendered.');
          const svg = parsed.documentElement as unknown as SVGSVGElement;
          sanitizePresentationSvg(svg);
          svg.setAttribute('width', '100%');
          svg.setAttribute('height', '100%');
          svg.style.display = 'block';
          svg.style.width = '100%';
          svg.style.height = 'auto';
          svg.style.background = '#ffffff';
          host.style.aspectRatio = `${presentation.width} / ${presentation.height}`;
          host.style.height = 'auto';
          host.replaceChildren(document.importNode(svg, true));
          const renderedSvg = host.querySelector('svg');
          if (renderedSvg) {
            const drawHighlights = () => highlightPdfPhrases(host, renderedSvg, phrasesForPage);
            pdfObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(drawHighlights) : null;
            pdfObserver?.observe(host);
            requestAnimationFrame(drawHighlights);
          }
          setError('');
          return;
        }
        if (extension !== 'pdf') throw new Error('A rendered page preview is available for PDF and PowerPoint files.');
        const bytes = new Uint8Array(await original.blob.arrayBuffer());
        if (typeof window !== 'undefined') {
          const basePath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname.slice(0, window.location.pathname.lastIndexOf('/') + 1);
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(`${basePath}pdf.worker.min.mjs`, window.location.origin).toString();
        }
        const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
        activePdfDocument = pdf;
        if (cancelled) return;
        const page = await pdf.getPage(pageIndex + 1);
        const baseViewport = page.getViewport({ scale: 1 });
        host.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`;
        host.style.height = 'auto';
        const layerStyle = document.createElement('style');
        layerStyle.textContent = `.recall-pdf-text-layer{position:absolute;inset:0;overflow:hidden;line-height:1;z-index:1;transform-origin:0 0;user-select:text}.recall-pdf-text-layer>:is(span,br),.recall-pdf-text-layer .markedContent>span:not([data-recall-highlight]){position:absolute;color:transparent;white-space:pre;transform-origin:0 0;cursor:text}`;
        host.appendChild(layerStyle);
        const drawPage = async () => {
          const generation = ++renderGeneration;
          activePdfTask?.cancel();
          activeTextLayer?.cancel();
          const availableWidth = host.clientWidth;
          if (availableWidth < 20) return;
          const scale = Math.min(availableWidth / baseViewport.width, 1.75);
          const viewport = page.getViewport({ scale });
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width * pixelRatio);
          canvas.height = Math.ceil(viewport.height * pixelRatio);
          canvas.style.cssText = `position:absolute;inset:0;width:${viewport.width}px;height:${viewport.height}px;display:block;`;
          const textContainer = document.createElement('div');
          textContainer.className = 'recall-pdf-text-layer';
          textContainer.style.width = `${viewport.width}px`;
          textContainer.style.height = `${viewport.height}px`;
          host.style.height = `${viewport.height}px`;
          host.replaceChildren(layerStyle, canvas, textContainer);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('This browser could not draw the PDF page.');
          activePdfTask = page.render({ canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
          try {
            await (activePdfTask as any).promise;
            if (cancelled || generation !== renderGeneration) return;
            const textLayer = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container: textContainer, viewport });
            activeTextLayer = textLayer;
            await textLayer.render();
            if (cancelled || generation !== renderGeneration) return;
            highlightPdfPhrases(host, textContainer, phrasesForPage);
            setError('');
          } catch (renderError) {
            if (renderGeneration === generation && !cancelled && !(renderError instanceof Error && renderError.name === 'RenderingCancelledException')) throw renderError;
          }
        };
        pdfObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { void drawPage().catch((drawError) => { if (!cancelled) showError(drawError instanceof Error ? drawError.message : 'Could not render this page.'); }); }) : null;
        pdfObserver?.observe(host);
        pdfResizeListener = () => { void drawPage().catch((drawError) => { if (!cancelled) showError(drawError instanceof Error ? drawError.message : 'Could not render this page.'); }); };
        if (!pdfObserver) window.addEventListener('resize', pdfResizeListener);
        await drawPage();
      } catch (renderError) {
        if (!cancelled) showError(renderError instanceof Error ? renderError.message : 'Could not render this page.');
      }
    };
    void render();
    return () => {
      cancelled = true;
      renderGeneration += 1;
      activePdfTask?.cancel();
      activeTextLayer?.cancel();
      void activePdfDocument?.destroy().catch(() => undefined);
      pdfObserver?.disconnect();
      if (pdfResizeListener) window.removeEventListener('resize', pdfResizeListener);
      disposePresentation?.();
      host.replaceChildren();
    };
  }, [fileId, fileName, pageIndex, normalizedPhrases]);

  return <View style={{ gap: 8 }}><View ref={hostRef} accessibilityLabel={`Original page preview for ${fileName}, page ${pageIndex + 1}`} style={{ width: '100%', aspectRatio: 1.45, minHeight: 180, borderWidth: 1, borderColor: 'rgba(20,50,35,0.24)', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' }} />{!!error && <View style={{ gap: 7 }}><Text style={{ color: '#ffe9a0', fontSize: 12, lineHeight: 18 }}>Could not open the original page in this browser. {error}</Text>{!!fallbackText && <><Pressable accessibilityRole="button" accessibilityState={{ expanded: showFallbackText }} onPress={() => setShowFallbackText((shown) => !shown)} style={{ minHeight: 40, justifyContent: 'center', alignSelf: 'flex-start' }}><Text style={{ color: '#b8e8c7', fontWeight: '800' }}>{showFallbackText ? 'Hide extracted text' : 'View extracted text'}</Text></Pressable>{showFallbackText && <Text style={{ color: '#20372c', fontSize: 14, lineHeight: 21, backgroundColor: '#fffdf3', padding: 12, borderRadius: 8 }}>{fallbackText}</Text>}</>}</View>}</View>;
}

export default function App() {
  const { width } = useWindowDimensions();
  const wide = width > 900;
  const compact = width <= 640;
  const ambientRef = useRef<React.ComponentRef<typeof View>>(null);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [page, setPage] = useState<'home' | 'modes' | 'import' | 'study' | 'insights'>('home');
  const activeNavId = page === 'study' ? 'modes' : page;
  const previousNavId = useRef(activeNavId);
  const [notes, setNotes] = useState('');
  const [questionsText, setQuestionsText] = useState('');
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [activeSubjectId, setActiveSubjectId] = useState<string | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [materialsTab, setMaterialsTab] = useState<'sources' | 'add' | 'summary'>('sources');
  const [addTab, setAddTab] = useState<'notes' | 'questions'>('notes');
  const [showMatchReview, setShowMatchReview] = useState(false);
  const [expandedMatchIndex, setExpandedMatchIndex] = useState<number | null>(null);
  const [studyFormat, setStudyFormat] = useState<'flashcards' | 'qa' | 'read'>('qa');
  const [readMaterialIndex, setReadMaterialIndex] = useState(0);
  const [flashcardRevealed, setFlashcardRevealed] = useState(false);
  const flashcardFlip = useRef(new Animated.Value(0)).current;
  const [flashcardRatings, setFlashcardRatings] = useState<Record<string, 'known' | 'unknown'>>({});
  const [flashcardReviewDeck, setFlashcardReviewDeck] = useState<ImportedFlashcard[] | null>(null);
  const [flashcardSourceResult, setFlashcardSourceResult] = useState<{ front: string; record: VectorRecord } | null>(null);
  const [ragBusy, setRagBusy] = useState(false);
  const [ragProgress, setRagProgress] = useState('');
  const [showExtractedText, setShowExtractedText] = useState(false);
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null);
  const [sourceViewerOpen, setSourceViewerOpen] = useState(false);
  const [previewSlideIndex, setPreviewSlideIndex] = useState(0);
  const [sourceCheckPageIndex, setSourceCheckPageIndex] = useState(0);
  const [sourceReader, setSourceReader] = useState<SourceReader | null>(null);
  const [sourceScope, setSourceScope] = useState<'subject' | 'file' | 'notes' | 'selected'>('subject');
  const [newSubjectName, setNewSubjectName] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [mode, setMode] = useState<'cram' | 'steady' | 'deep'>('cram');
  const [phase, setPhase] = useState<Phase>('diagnostic');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedPace, setSelectedPace] = useState<Pace>('cram');
  const [answer, setAnswer] = useState<number | null>(null);
  const [attempted, setAttempted] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [history, setHistory] = useState<StudyAttempt[]>([]);
  const [demoMaterial, setDemoMaterial] = useState(false);
  const [answerDraft, setAnswerDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [aiProvider, setAiProvider] = useState<AiProvider>('gemini');
  const [apiKeyProvider, setApiKeyProvider] = useState<AiProvider | null>(null);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const [aiSummary, setAiSummary] = useState<{ subjectId: string; sourceHash: string; result: AiResult } | null>(null);
  const [aiFeedback, setAiFeedback] = useState<AiResult | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRestoreBackup, setConfirmRestoreBackup] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageReady, setStorageReady] = useState(Platform.OS !== 'web');
  const aiProviderName = aiProvider === 'gemini' ? 'Gemini' : 'OpenAI';
  const connectedProviderName = apiKeyProvider === 'openai' ? 'OpenAI' : 'Gemini';

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [page, folderOpen, activeSubjectId]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let cancelled = false;
    const hydrateWorkspace = async () => {
      try {
        let saved: Partial<SavedWorkspace> | null = null;
        try { saved = await loadWorkspaceSnapshot(); } catch { /* Fall back to the previous browser save if IndexedDB is unavailable. */ }
        if (!saved) {
          const raw = window.localStorage.getItem(storageKey) || window.localStorage.getItem(legacyStorageKey);
          if (raw) saved = JSON.parse(raw) as Partial<SavedWorkspace>;
        }
        if (cancelled) return;
        if (saved) {
        if ((saved.version === 1 || saved.version === 2) && typeof saved.notes === 'string' && typeof saved.questionsText === 'string') {
          setNotes(saved.notes);
          setQuestionsText(saved.questionsText);
          setDemoMaterial(saved.demoMaterial === true);
          setMatches(Array.isArray(saved.matches) ? saved.matches : buildMatches(saved.notes, splitQuestions(saved.questionsText)));
          setAttempted(Number.isFinite(saved.attempted) ? Number(saved.attempted) : 0);
          setCorrect(Number.isFinite(saved.correct) ? Number(saved.correct) : 0);
          setHistory(Array.isArray(saved.history) ? saved.history.filter((item): item is StudyAttempt => !!item && typeof item.id === 'string' && typeof item.question === 'string') : []);
          const loadedSubjects = Array.isArray(saved.subjects) ? saved.subjects.filter((subject): subject is Subject => !!subject && typeof subject.id === 'string' && typeof subject.name === 'string' && Array.isArray(subject.files)) : [];
          if (loadedSubjects.length) {
            setSubjects(loadedSubjects);
            setActiveSubjectId(typeof saved.activeSubjectId === 'string' ? saved.activeSubjectId : loadedSubjects[0].id);
            setSelectedSourceId(typeof saved.selectedSourceId === 'string' ? saved.selectedSourceId : null);
            setSelectedSourceIds(Array.isArray(saved.selectedSourceIds) ? saved.selectedSourceIds.filter((id): id is string => typeof id === 'string') : []);
            setSourceScope(saved.sourceScope === 'file' ? 'file' : saved.sourceScope === 'notes' ? 'notes' : saved.sourceScope === 'selected' ? 'selected' : 'subject');
          } else if (saved.notes.trim() || saved.questionsText.trim()) {
            const migrated: Subject = { id: 'subject-migrated', name: 'My study materials', notes: saved.notes, questionsText: saved.questionsText, files: [] };
            setSubjects([migrated]); setActiveSubjectId(migrated.id);
          }
        }
      }
      } catch { /* Keep the in-memory demo usable if browser storage is disabled or unreadable. */ }
      finally { if (!cancelled) setStorageReady(true); }
    };
    void hydrateWorkspace();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || !storageReady) return;
    const savedSubjects = subjects.map((subject) => subject.id === activeSubjectId ? { ...subject, notes, questionsText } : subject);
    const saved: SavedWorkspace = { version: 2, notes, questionsText, demoMaterial, matches, attempted, correct, history, subjects: savedSubjects, activeSubjectId, selectedSourceId, selectedSourceIds, sourceScope };
    const timer = window.setTimeout(() => {
    void saveWorkspaceSnapshot(saved).catch((error) => setNotice(`Browser storage could not save this workspace${error instanceof Error ? `: ${error.message}` : ''}. Download a backup before closing this tab.`));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [storageReady, notes, questionsText, demoMaterial, matches, attempted, correct, history, subjects, activeSubjectId, selectedSourceId, selectedSourceIds, sourceScope]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const style = document.createElement('style');
    style.textContent = `
      [role="button"] { transition: transform 180ms ease, filter 180ms ease, box-shadow 220ms ease; }
      [role="button"]:active { filter: brightness(1.08); transform: scale(.975); border-color: rgba(210,255,226,.56); -webkit-backdrop-filter: blur(10px) saturate(150%); backdrop-filter: blur(10px) saturate(150%); box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 0 22px rgba(158,255,190,.16); }
      [data-testid="torch-block"] { position: relative; isolation: isolate; overflow: hidden; transition: box-shadow 220ms ease, transform 220ms ease; }
      [data-testid="torch-block"] > * { position: relative; z-index: 2; }
      [data-testid="torch-block"]::before { content: ''; position: absolute; inset: 0; z-index: 3; padding: 1.5px; border-radius: inherit; pointer-events: none; opacity: 0; background: radial-gradient(140px circle at var(--torch-x, 50%) var(--torch-y, 50%), rgba(220,255,232,1), rgba(126,238,164,.62) 30%, rgba(126,238,164,.14) 58%, transparent 78%); -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask-composite: exclude; transition: opacity 260ms ease; }
      [data-testid="torch-block"]::after { content: ''; position: absolute; z-index: 0; left: var(--torch-x, 50%); top: var(--torch-y, 50%); width: 440px; height: 440px; border-radius: 50%; pointer-events: none; opacity: 0; background: radial-gradient(circle, rgba(196,255,216,.26) 0%, rgba(106,222,153,.12) 42%, rgba(106,222,153,.04) 60%, transparent 73%); transform: translate(-50%,-50%) scale(.28); transition: transform 720ms cubic-bezier(.18,.72,.24,1), opacity 280ms ease; }
      [data-testid="torch-block"].torch-active { box-shadow: 0 12px 34px rgba(0,0,0,.28); transform: translateY(-1px); }
      [data-testid="torch-block"].torch-active::before, [data-testid="torch-block"].torch-active::after { opacity: 1; }
      [data-testid="torch-block"].torch-active::after { transform: translate(-50%,-50%) scale(.5); }
      [data-testid="torch-block"].torch-pressed { transform: translateY(0) scale(.99); }
      [data-testid="torch-block"].torch-pressed::after { transform: translate(-50%,-50%) scale(1); transition-duration: 1100ms; }
      [data-testid="nav-track"] { position: relative; }
      [data-testid="nav-glass-indicator"] { z-index: 0; border: 1px solid rgba(190,255,216,.34); background: linear-gradient(135deg, rgba(202,255,222,.25), rgba(112,180,139,.13) 48%, rgba(255,255,255,.07)); box-shadow: inset 0 1px 0 rgba(255,255,255,.24), inset 0 -1px 0 rgba(130,231,168,.1), 0 7px 24px rgba(0,0,0,.18); -webkit-backdrop-filter: blur(15px) saturate(155%); backdrop-filter: blur(15px) saturate(155%); will-change: left, top, width, height, border-radius, transform; transition: left 520ms cubic-bezier(.2,.82,.25,1), top 520ms cubic-bezier(.2,.82,.25,1), width 520ms cubic-bezier(.2,.82,.25,1), height 520ms cubic-bezier(.2,.82,.25,1); }
      [data-testid="nav-track"].nav-liquid-morph [data-testid="nav-glass-indicator"] { animation: nav-glass-morph 680ms cubic-bezier(.2,.8,.25,1) both; }
      @keyframes nav-glass-morph { 0% { border-radius: 999px; transform: scale(1,1); } 24% { border-radius: 42% 58% 50% 50% / 55% 44% 56% 45%; transform: scale(1.14,.78); } 52% { border-radius: 58% 42% 46% 54% / 43% 57% 43% 57%; transform: scale(.96,1.12); } 76% { border-radius: 999px; transform: scale(1.035,.97); } 100% { border-radius: 999px; transform: scale(1,1); } }
      [data-testid="ambient-glow-a"] { transform-origin: center; will-change: transform, border-radius; animation: lava-drift-a 19s ease-in-out -7s infinite; }
      [data-testid="ambient-glow-b"] { transform-origin: center; will-change: transform, border-radius; animation: lava-drift-b 23s ease-in-out -13s infinite; }
      [data-testid="ambient-glow-c"] { transform-origin: center; will-change: transform, border-radius; animation: lava-drift-c 17s ease-in-out -5s infinite; }
      @keyframes lava-drift-a { 0%,100% { transform: translate3d(0,0,0) scale(.94); border-radius: 48% 52% 56% 44% / 48% 45% 55% 52%; } 35% { transform: translate3d(-132px,104px,0) scale(1.2); border-radius: 58% 42% 40% 60% / 53% 62% 38% 47%; } 70% { transform: translate3d(82px,136px,0) scale(.86); border-radius: 40% 60% 58% 42% / 42% 44% 56% 58%; } }
      @keyframes lava-drift-b { 0%,100% { transform: translate3d(0,0,0) scale(.9); border-radius: 52% 48% 45% 55% / 50% 44% 56% 50%; } 40% { transform: translate3d(118px,-126px,0) scale(1.22); border-radius: 40% 60% 62% 38% / 60% 46% 54% 40%; } 75% { transform: translate3d(-104px,-74px,0) scale(.84); border-radius: 62% 38% 42% 58% / 40% 62% 38% 60%; } }
      @keyframes lava-drift-c { 0%,100% { transform: translate3d(0,0,0) scale(.88); border-radius: 50% 50% 48% 52% / 52% 46% 54% 48%; } 45% { transform: translate3d(128px,-92px,0) scale(1.24); border-radius: 38% 62% 60% 40% / 46% 62% 38% 54%; } 80% { transform: translate3d(-88px,72px,0) scale(.82); border-radius: 62% 38% 40% 60% / 60% 38% 62% 40%; } }
      [data-testid="register-glass"] { border: 1px solid rgba(190,255,216,.28); background: linear-gradient(135deg, rgba(202,255,222,.13), rgba(112,180,139,.07) 54%, rgba(255,255,255,.035)); box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 0 rgba(130,231,168,.08), 0 6px 20px rgba(0,0,0,.14); -webkit-backdrop-filter: blur(14px) saturate(150%); backdrop-filter: blur(14px) saturate(150%); }
      [data-testid="brand-wordmark"] { font-family: "Segoe UI Variable", "Inter", system-ui, sans-serif; font-weight: 600; letter-spacing: -.65px; color: transparent !important; background: linear-gradient(180deg, #f5fff8 8%, #d5f2df 54%, #91c7a2 100%); -webkit-background-clip: text; background-clip: text; text-shadow: 0 0 13px rgba(177,255,202,.28); filter: drop-shadow(0 1px 0 rgba(255,255,255,.16)); }
      @media (prefers-reduced-motion: reduce) { [data-testid="torch-block"], [data-testid="nav-glass-indicator"] { transition: none !important; } [data-testid="nav-track"].nav-liquid-morph [data-testid="nav-glass-indicator"], [data-testid^="ambient-glow-"] { animation: none !important; } }
    `;
    document.head.appendChild(style);
    const move = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-testid="torch-block"]') : null;
      document.querySelectorAll<HTMLElement>('[data-testid="torch-block"].torch-active').forEach((card) => { if (card !== target) { card.classList.remove('torch-active'); card.classList.remove('torch-pressed'); } });
      if (!target) return;
      const bounds = target.getBoundingClientRect();
      target.style.setProperty('--torch-x', `${event.clientX - bounds.left}px`);
      target.style.setProperty('--torch-y', `${event.clientY - bounds.top}px`);
      target.classList.add('torch-active');
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType !== 'touch') return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-testid="torch-block"]') : null;
      if (!target) return;
      const bounds = target.getBoundingClientRect();
      target.style.setProperty('--torch-x', `${event.clientX - bounds.left}px`);
      target.style.setProperty('--torch-y', `${event.clientY - bounds.top}px`);
      target.classList.add('torch-active', 'torch-pressed');
    };
    const release = () => document.querySelectorAll<HTMLElement>('[data-testid="torch-block"].torch-pressed').forEach((card) => card.classList.remove('torch-pressed'));
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) document.querySelectorAll<HTMLElement>('[data-testid="torch-block"].torch-active').forEach((card) => { card.classList.remove('torch-active'); card.classList.remove('torch-pressed'); }); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    document.addEventListener('pointerout', leave);
    return () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerdown', down); document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release); document.removeEventListener('pointerout', leave); style.remove(); };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const changed = previousNavId.current !== activeNavId;
    previousNavId.current = activeNavId;
    const tracks = [...document.querySelectorAll<HTMLElement>('[data-testid="nav-track"]')];
    const update = () => tracks.forEach((track) => {
      const activeItem = track.querySelector<HTMLElement>(`[data-testid="nav-item-${activeNavId}"]`);
      const indicator = track.querySelector<HTMLElement>('[data-testid="nav-glass-indicator"]');
      if (!activeItem || !indicator) return;
      const trackRect = track.getBoundingClientRect();
      const itemRect = activeItem.getBoundingClientRect();
      indicator.style.left = `${itemRect.left - trackRect.left}px`;
      indicator.style.top = `${itemRect.top - trackRect.top}px`;
      indicator.style.width = `${itemRect.width}px`;
      indicator.style.height = `${itemRect.height}px`;
    });
    if (changed) tracks.forEach((track) => {
      track.classList.remove('nav-liquid-morph');
      void track.offsetWidth;
      track.classList.add('nav-liquid-morph');
      window.setTimeout(() => track.classList.remove('nav-liquid-morph'), 720);
    });
    const frame = window.requestAnimationFrame(update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    tracks.forEach((track) => observer?.observe(track));
    window.addEventListener('resize', update);
    return () => { window.cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [activeNavId, width]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !('IntersectionObserver' in window)) return;
    const style = document.createElement('style');
    style.textContent = `@media (prefers-reduced-motion: no-preference) { [data-testid="scroll-reveal"] { opacity: 0; transform: translateY(22px); transition: opacity 650ms ease, transform 650ms cubic-bezier(.2,.75,.25,1); } [data-testid="scroll-reveal"].reveal-visible { opacity: 1; transform: translateY(0); } }`;
    document.head.appendChild(style);
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add('reveal-visible'); observer.unobserve(entry.target); }
    }), { threshold: 0.12 });
    document.querySelectorAll('[data-testid="scroll-reveal"]').forEach((section) => observer.observe(section));
    return () => { observer.disconnect(); style.remove(); };
  }, [page]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const style = document.createElement('style');
    style.textContent = '[data-testid="scroll-backdrop"]::after { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(180deg, rgba(2,9,7,.72) 0%, rgba(2,9,7,.48) 18%, rgba(2,9,7,.16) 42%, rgba(2,9,7,0) 68%); }';
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const activeSubject = subjects.find((subject) => subject.id === activeSubjectId) || null;
  const sourceFiles = activeSubject?.files.filter((file) => file.role === 'source') || [];
  const visibleSourceIndex = Math.max(0, sourceFiles.findIndex((file) => file.id === previewSourceId));
  const visibleSourceFile = sourceFiles[visibleSourceIndex] || null;
  const selectedSource = activeSubject?.files.find((file) => file.id === selectedSourceId && file.role === 'source') || null;
  const fileSegments = (file: StudyFile) => (file.segments?.length ? file.segments : asStudySegments(file.text, file.name)).map((segment) => ({ ...segment, sourceFileId: file.id }));
  const selectedStudyFiles = activeSubject?.files.filter((file) => file.role === 'source' && selectedSourceIds.includes(file.id)) || [];
  const lecturePreview = (file: StudyFile, focusQuestion?: string, emphasizeQuestionContext = false) => {
    const slides = fileSegments(file);
    const slideIndex = Math.min(previewSlideIndex, Math.max(0, slides.length - 1));
    const slide = slides[slideIndex];
    if (!slide) return null;
    const linkedQuestions = questionList.map((question) => ({ question, match: buildMatches([slide], [question])[0] })).filter(({ match }) => match.overlap > 0).sort((a, b) => b.match.overlap - a.match.overlap);
    const visibleLinkedQuestions = focusQuestion ? linkedQuestions.filter(({ question }) => question === focusQuestion) : linkedQuestions;
    const highlightedEvidence = emphasizeQuestionContext ? (focusQuestion ? linkedQuestions.filter(({ question }) => question === focusQuestion) : linkedQuestions.slice(0, 2)).map(({ question, match }) => findRelevantEvidence(match.passage, question)) : [];
    const slideSuggestion = draftPracticeQuestions(slide.text)[0];
    const originalPageNumber = Number(slide.label.match(/\bslide\s+(\d+)/i)?.[1] || slide.label.match(/\bpage\s+(\d+)/i)?.[1]);
    const renderedPageIndex = Number.isFinite(originalPageNumber) && originalPageNumber > 0 ? originalPageNumber - 1 : slideIndex;
    const addSuggestedQuestion = () => {
      if (!slideSuggestion || questionList.includes(slideSuggestion)) return;
      const updatedQuestions = [...questionList, slideSuggestion];
      setQuestionsText(updatedQuestions.map((question, index) => `${index + 1}. ${question}`).join('\n'));
      setMatches(buildMatches(studySourceSegments, updatedQuestions));
      notify('Slide question added to your study set. Review its source match below.');
    };
    return <View style={{ borderRadius: 12, borderWidth: 1, borderColor: 'rgba(245,216,94,0.28)', padding: 14, backgroundColor: 'rgba(5,14,11,0.52)', gap: 12 }}>
      <View style={{ flexDirection: compact ? 'column' : 'row', justifyContent: 'space-between', alignItems: compact ? 'stretch' : 'center', gap: 9 }}>
        <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.label}>{/\.pptx?$/i.test(file.name) ? 'SLIDE PREVIEW' : 'PDF PAGE PREVIEW'} · ORIGINAL LAYOUT</Text><Text style={{ color: palette.ink, fontWeight: '800', fontSize: 16, marginTop: 4 }}>{/\.pptx?$/i.test(file.name) ? `Slide ${originalPageNumber || slideIndex + 1} of ${slides.length}` : `${slide.label.split(' · ').slice(-1)[0]} · ${slideIndex + 1} of ${slides.length}`}</Text></View>
        <View style={{ flexDirection: 'row', gap: 7 }}><ActionButton compact secondary label="← Previous" onPress={() => setPreviewSlideIndex((index) => Math.max(0, index - 1))} /><ActionButton compact secondary label="Next →" onPress={() => setPreviewSlideIndex((index) => Math.min(slides.length - 1, index + 1))} /></View>
      </View>
      {/\.(?:pdf|pptx?)$/i.test(file.name) ? <RenderedPagePreview fileId={file.id} fileName={file.name} pageIndex={renderedPageIndex} highlightPhrases={highlightedEvidence} fallbackText={slide.text ? `${slide.label}\n${slide.text}` : ''} /> : <View style={{ borderRadius: 8, padding: 13, backgroundColor: '#f7f7ee' }}>{slide.text ? emphasizeQuestionContext ? highlightedPassage(slide.text, focusQuestion || linkedQuestions[0]?.question || '') : <Text style={{ color: '#20372c', fontSize: 15, lineHeight: 23 }}>{slide.text}</Text> : <Text style={{ color: '#20372c', fontSize: 15, lineHeight: 23 }}>No readable text on this page.</Text>}</View>}
      {!!slide.text && <View style={{ borderLeftWidth: 1, borderColor: palette.line, backgroundColor: 'rgba(255,255,255,0.025)', paddingHorizontal: 12, borderRadius: 8 }}><Pressable accessibilityRole="button" accessibilityState={{ expanded: showExtractedText }} onPress={() => setShowExtractedText((shown) => !shown)} style={{ minHeight: 42, justifyContent: 'center', alignSelf: 'flex-start' }}><Text style={{ color: '#b8e8c7', fontWeight: '800' }}>{showExtractedText ? 'Hide extracted text' : 'View extracted text'}</Text></Pressable>{showExtractedText && <Text style={{ color: palette.ink, fontSize: 14, lineHeight: 22, paddingBottom: 12 }}>{slide.text}</Text>}</View>}
      {!!visibleLinkedQuestions.length && <View style={{ gap: 7 }}><Text style={styles.label}>{focusQuestion ? 'QUESTION IN THIS MATERIAL' : 'QUESTIONS LINKED TO THIS PAGE'}</Text>{visibleLinkedQuestions.slice(0, 3).map(({ question }, index) => <View key={`${question}-${index}`} style={{ borderRadius: 9, padding: 10, backgroundColor: 'rgba(33,129,91,0.14)', borderWidth: 1, borderColor: 'rgba(90,210,141,0.22)' }}><Text style={{ color: '#dff8e7', fontSize: 13, fontWeight: '700' }}>{question}</Text></View>)}</View>}
      {slideSuggestion && <View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 9, borderTopWidth: 1, borderColor: palette.line, paddingTop: 10 }}><Text style={[styles.body, { flex: 1, color: '#dfe9e3' }]}>Draft: {slideSuggestion}</Text><ActionButton compact secondary label={questionList.includes(slideSuggestion) ? 'Already added' : 'Add question'} onPress={addSuggestedQuestion} /></View>}
    </View>;
  };
  const studySourceText = sourceScope === 'file' && selectedSource ? selectedSource.text : sourceScope === 'notes' ? notes : sourceScope === 'selected' ? [selectedSourceIds.includes('__notes__') ? notes : '', ...selectedStudyFiles.map((file) => file.text)].filter(Boolean).join('\n\n') : [notes, ...(activeSubject?.files.filter((file) => file.role === 'source').map((file) => file.text) || [])].filter(Boolean).join('\n\n');
  const studySourceSegments = sourceScope === 'file' && selectedSource
    ? fileSegments(selectedSource)
    : sourceScope === 'notes'
      ? asStudySegments(notes)
      : sourceScope === 'selected'
        ? [...(selectedSourceIds.includes('__notes__') ? asStudySegments(notes) : []), ...selectedStudyFiles.flatMap(fileSegments)]
      : [...asStudySegments(notes), ...(activeSubject?.files.filter((file) => file.role === 'source').flatMap(fileSegments) || [])];
  const questionList = useMemo(() => splitQuestions(questionsText), [questionsText]);
  const importedFlashcards = activeSubject?.flashcards || [];
  const importedMultipleChoice = activeSubject?.multipleChoiceQuestions || [];
  const importedQuestionKeys = new Set(importedFlashcards.map((card) => card.front.trim().toLocaleLowerCase()));
  const allFlashcards: ImportedFlashcard[] = [
    ...importedFlashcards,
    ...questionList.filter((question) => !importedQuestionKeys.has(question.trim().toLocaleLowerCase())).map((front) => ({ front, back: '', source: '' })),
  ];
  const flashcardDeck = flashcardReviewDeck || allFlashcards;
  const unknownFlashcards = allFlashcards.filter((card) => flashcardRatings[flashcardKey(card)] === 'unknown');
  const knownFlashcardCount = allFlashcards.filter((card) => flashcardRatings[flashcardKey(card)] === 'known').length;
  const selectedRagSources: { id: string; name: string; segments: SourceChunkInput[] }[] = [
    ...(selectedSourceIds.includes('__notes__') && notes.trim() ? [{ id: '__notes__', name: 'Subject notes', segments: asStudySegments(notes).map((segment) => ({ sourceId: '__notes__', sourceName: 'Subject notes', label: segment.label, text: segment.text })) }] : []),
    ...selectedStudyFiles.map((file) => ({ id: file.id, name: file.name, segments: fileSegments(file).map((segment) => ({ sourceId: file.id, sourceName: file.name, label: `${file.name} · ${segment.label}`, text: segment.text })) })),
  ];
  const selectedAiSegments = [...(selectedSourceIds.includes('__notes__') && notes.trim() ? [{ label: 'Subject notes', text: notes }] : []), ...selectedStudyFiles.flatMap((file) => fileSegments(file).map((segment) => ({ ...segment, label: `${file.name} · ${segment.label}` })))];
  const selectedAiMaterialText = selectedAiSegments.map((segment) => `${segment.label}\n${segment.text}`).join('\n\n');
  const aiSourceHash = hashText(`${activeSubject?.name || ''}\n${selectedAiMaterialText}`);
  const aiStudySourceHash = hashText(`${aiSourceHash}\n${questionList.join('\n')}`);
  const aiSelectedSourceCount = selectedSourceIds.filter((id) => id === '__notes__' ? !!notes.trim() : selectedStudyFiles.some((file) => file.id === id)).length;
  const sourceParagraphs = studySourceSegments.flatMap((segment) => segment.text.split(/\n\s*\n/).map((text) => ({ text: text.trim(), sourceLabel: segment.label }))).filter((item) => item.text);
  const hasStudyContent = studySourceText.trim().length > 0 || questionList.length > 0 || importedFlashcards.length > 0;
  const currentQuestion = demoMaterial ? (demoQuiz[questionIndex % demoQuiz.length]?.question || 'What is the main idea of this module?') : (questionList[questionIndex] || 'What is the main idea of this module?');
  useEffect(() => { setAiFeedback(null); }, [currentQuestion]);
  const currentDemoQuiz = demoQuiz[questionIndex % demoQuiz.length];
  const currentImportedQuiz = importedMultipleChoice.find((item) => item.question === currentQuestion) || null;
  const quizOptions = currentImportedQuiz?.options || currentDemoQuiz.options;
  const correctAnswer = currentImportedQuiz?.correctIndex ?? currentDemoQuiz.correct;
  const hasNextQuestion = questionIndex < questionList.length - 1;
  const sourceOptions = studySourceSegments.flatMap((segment) => segment.text.split(/\n\s*\n/).map((passage) => ({ passage: passage.trim(), sourceLabel: segment.label, sourceFileId: segment.sourceFileId }))).filter(({ passage }) => passage.length > 45 && !/^[A-Z\s]+$/.test(passage)).map((item, index) => ({ ...item, passageIndex: index + 1 }));
  const moduleTitle = sourceScope === 'file' && selectedSource ? selectedSource.name.replace(/\.[^.]+$/, '') : activeSubject?.name || notes.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || 'Untitled module';
  const displayModuleTitle = demoMaterial ? 'Cellular respiration' : !hasStudyContent ? 'No study set yet' : moduleTitle.length > 52 ? `${moduleTitle.slice(0, 49)}…` : moduleTitle;
  const currentMatch = matches.find((match) => match.question === currentQuestion && (match.overlap > 0 || (match.manual && match.passageIndex !== null)));
  const reviewPassage = currentMatch?.passage || studySourceText.split(/\n+/).map((part) => part.trim()).find((part) => part.length > 30) || 'Add notes to see the source passage here.';
  const openSourcePassage = () => {
    setPhase('review');
  };
  const stepMatchSource = (question: string, direction: number) => setMatches((previous) => previous.map((match) => {
    if (match.question !== question || !sourceOptions.length) return match;
    const current = sourceOptions.findIndex((option) => option.passageIndex === match.passageIndex);
    const next = current === -1 ? 0 : (current + direction + sourceOptions.length) % sourceOptions.length;
    return { ...match, passage: sourceOptions[next].passage, passageIndex: sourceOptions[next].passageIndex, sourceLabel: sourceOptions[next].sourceLabel, sourceFileId: sourceOptions[next].sourceFileId, overlap: 0, manual: true };
  }));
  const clearMatchSource = (question: string) => setMatches((previous) => previous.map((match) => match.question === question ? { ...match, passage: 'No source link selected. Review manually or choose a passage.', passageIndex: null, sourceLabel: undefined, overlap: 0, manual: true } : match));
  const findMatchSourceFile = (match: Match) => activeSubject?.files.find((file) => file.role === 'source' && (file.id === match.sourceFileId || (!!match.sourceLabel && match.sourceLabel.startsWith(`${file.name} ·`)))) || null;
  const currentFlashcardCard = flashcardDeck[questionIndex];
  const currentFlashcardQuestion = currentFlashcardCard?.front || '';
  const currentVectorMatch = flashcardSourceResult?.front === currentFlashcardQuestion ? flashcardSourceResult.record : null;
  const currentFlashcardMatch: Match | null = currentVectorMatch
    ? { question: currentFlashcardQuestion, passage: currentVectorMatch.text, overlap: 0, passageIndex: 1, sourceLabel: currentVectorMatch.label, sourceFileId: currentVectorMatch.sourceId }
    : matches.find((match) => match.question === currentFlashcardQuestion) || null;
  const currentFlashcardFile = currentFlashcardMatch ? findMatchSourceFile(currentFlashcardMatch) : null;
  const flashcardEvidence = currentFlashcardMatch ? findRelevantEvidence(currentFlashcardMatch.passage, currentFlashcardQuestion) : '';
  const currentFlashcardRating = currentFlashcardCard ? flashcardRatings[flashcardKey(currentFlashcardCard)] : undefined;
  const flashcardPageFromMatch = Number(currentFlashcardMatch?.sourceLabel?.match(/(?:page|slide)\s+(\d+)/i)?.[1] || 1) - 1;
  const flashcardPageCount = currentFlashcardFile ? fileSegments(currentFlashcardFile).length : 0;
  const flashcardPageSegment = currentFlashcardFile ? fileSegments(currentFlashcardFile)[sourceCheckPageIndex] : null;
  const flashcardFrontRotation = flashcardFlip.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const flashcardBackRotation = flashcardFlip.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] });
  const flashcardFrontOpacity = flashcardFlip.interpolate({ inputRange: [0, 0.48, 0.52, 1], outputRange: [1, 1, 0, 0] });
  const flashcardBackOpacity = flashcardFlip.interpolate({ inputRange: [0, 0.48, 0.52, 1], outputRange: [0, 0, 1, 1] });

  useEffect(() => {
    Animated.timing(flashcardFlip, {
      toValue: flashcardRevealed ? 1 : 0,
      duration: 460,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [flashcardFlip, flashcardRevealed]);

  useEffect(() => { setSourceCheckPageIndex(Math.max(0, flashcardPageFromMatch)); }, [currentFlashcardQuestion, currentFlashcardMatch?.sourceLabel]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const pageFile = page === 'study' && studyFormat === 'flashcards' && flashcardRevealed ? currentFlashcardFile : page === 'study' && studyFormat === 'read' ? selectedStudyFiles[readMaterialIndex] || null : page === 'import' && materialsTab === 'sources' && sourceViewerOpen ? visibleSourceFile : null;
    if (!pageFile || !/\.(?:pdf|pptx?)$/i.test(pageFile.name)) return;
    const pageCount = page === 'study' && studyFormat === 'flashcards' ? flashcardPageCount : fileSegments(pageFile).length;
    if (pageCount < 2) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      if (page === 'study' && studyFormat === 'flashcards') setSourceCheckPageIndex((index) => Math.max(0, Math.min(pageCount - 1, index + (event.key === 'ArrowRight' ? 1 : -1))));
      else setPreviewSlideIndex((index) => Math.max(0, Math.min(pageCount - 1, index + (event.key === 'ArrowRight' ? 1 : -1))));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [page, studyFormat, flashcardRevealed, currentFlashcardFile?.id, flashcardPageCount, materialsTab, sourceViewerOpen, visibleSourceFile?.id, readMaterialIndex, selectedStudyFiles.map((file) => file.id).join('|')]);

  const moveSourceFile = (fileId: string, direction: -1 | 1) => {
    setSubjects((previous) => previous.map((subject) => {
      if (subject.id !== activeSubjectId) return subject;
      const files = [...subject.files];
      const sourcePositions = files.flatMap((file, index) => file.role === 'source' ? [index] : []);
      const sourceIndex = sourcePositions.findIndex((position) => files[position].id === fileId);
      const nextSourceIndex = sourceIndex + direction;
      if (sourceIndex < 0 || nextSourceIndex < 0 || nextSourceIndex >= sourcePositions.length) return subject;
      const currentPosition = sourcePositions[sourceIndex];
      const nextPosition = sourcePositions[nextSourceIndex];
      [files[currentPosition], files[nextPosition]] = [files[nextPosition], files[currentPosition]];
      return { ...subject, files };
    }));
  };

  const navigateSourceFile = (direction: -1 | 1) => {
    const nextIndex = Math.max(0, Math.min(sourceFiles.length - 1, visibleSourceIndex + direction));
    const nextFile = sourceFiles[nextIndex];
    if (!nextFile) return;
    setPreviewSourceId(nextFile.id);
    setPreviewSlideIndex(0);
    setShowExtractedText(false);
  };

  const openSourceViewer = (file: StudyFile) => {
    setPreviewSourceId(file.id);
    setPreviewSlideIndex(0);
    setShowExtractedText(false);
    setSourceViewerOpen(true);
  };

  const navigateReadMaterial = (direction: -1 | 1) => {
    setReadMaterialIndex((index) => Math.max(0, Math.min(selectedStudyFiles.length - 1, index + direction)));
    setPreviewSlideIndex(0);
    setShowExtractedText(false);
  };

  const openSourceLocation = async (match: Match) => {
    const sourceFile = findMatchSourceFile(match);
    if (!sourceFile || !match.sourceLabel) {
      setSourceReader({ title: 'Study notes', location: match.sourceLabel || 'Selected passage', text: match.passage });
      return;
    }
    const extension = sourceFile.name.split('.').pop()?.toLowerCase();
    if (Platform.OS === 'web' && extension === 'pdf') {
      const tab = window.open('', '_blank');
      if (!tab) { notify('Allow pop-ups to open the PDF at its source page. The passage is available in the study review.'); return; }
      try {
        const original = await getOriginalDocument(sourceFile.id);
        if (!original) { tab.close(); setSourceReader({ title: sourceFile.name, location: match.sourceLabel, text: match.passage }); return; }
        const pageNumber = Number(match.sourceLabel.match(/page\s+(\d+)/i)?.[1] || 1);
        const objectUrl = URL.createObjectURL(original.blob);
        tab.opener = null;
        tab.location.href = `${objectUrl}#page=${pageNumber}`;
      } catch {
        tab.close();
        setSourceReader({ title: sourceFile.name, location: match.sourceLabel, text: match.passage });
      }
      return;
    }
    const segment = fileSegments(sourceFile).find((item) => item.label === match.sourceLabel);
    setSourceReader({ title: sourceFile.name, location: match.sourceLabel, text: segment?.text || match.passage });
  };

  const notify = (message: string) => {
    if (Platform.OS === 'web') setNotice(message);
    else Alert.alert('StudyLoop', message);
  };

  const indexSelectedSources = async (force = false) => {
    if (!activeSubject || !selectedRagSources.length) throw new Error('Select one or more source files before building the source index.');
    if (!apiKey) { setShowApiKeyModal(true); throw new Error(`Connect your ${aiProviderName} key to build the source index.`); }
    const embeddingProvider = apiKeyProvider || aiProvider;
    const embeddingModel: VectorRecord['model'] = embeddingProvider === 'gemini' ? 'gemini-embedding-001' : 'text-embedding-3-small';
    const allRecords: VectorRecord[] = [];
    for (let sourceIndex = 0; sourceIndex < selectedRagSources.length; sourceIndex += 1) {
      const source = selectedRagSources[sourceIndex];
      const contentHash = hashText(source.segments.map((segment) => segment.text).join('\n'));
      const cached = !force ? await getVectorIndex(activeSubject.id, source.id) : null;
      if (cached?.contentHash === contentHash && cached.provider === embeddingProvider && cached.model === embeddingModel && cached.records.length) {
        allRecords.push(...cached.records);
        continue;
      }

      const chunks = source.segments.flatMap((segment) => chunkSourceText(segment));
      if (!chunks.length) continue;
      const records: VectorRecord[] = [];
      for (let offset = 0; offset < chunks.length; offset += 16) {
        const batch = chunks.slice(offset, offset + 16);
        setRagProgress(`Indexing ${source.name} · ${Math.min(offset + batch.length, chunks.length)} of ${chunks.length}`);
        const embeddings = await embedTexts(apiKey, embeddingProvider, batch.map((chunk) => chunk.text), 'RETRIEVAL_DOCUMENT', source.name);
        records.push(...batch.map((chunk, index) => ({
          ...chunk,
          id: `${source.id}:${index}:${hashText(chunk.text)}`,
          subjectId: activeSubject.id,
          contentHash,
          provider: embeddingProvider,
          model: embeddingModel,
          embedding: embeddings[index],
        })));
      }
      await saveVectorIndex(activeSubject.id, source.id, { contentHash, provider: embeddingProvider, model: embeddingModel, records });
      allRecords.push(...records);
      setRagProgress(`Indexed ${source.name} · ${sourceIndex + 1} of ${selectedRagSources.length}`);
    }
    setRagProgress('');
    return allRecords;
  };

  const findFlashcardSource = async () => {
    if (!currentFlashcardCard) return;
    if (!selectedRagSources.length) { notify('Select one or more source files to search.'); return; }
    if (!apiKey) {
      setShowApiKeyModal(true);
      return;
    }
    setRagBusy(true);
    try {
      const records = await indexSelectedSources();
      setRagProgress('Finding the closest passage…');
      const query = [currentFlashcardCard.front, currentFlashcardCard.back].filter(Boolean).join('\n');
      const [queryEmbedding] = await embedTexts(apiKey, apiKeyProvider || aiProvider, [query], 'RETRIEVAL_QUERY');
      const match = searchVectorRecords(queryEmbedding, records, 1)[0];
      if (!match) { notify('No searchable text was found in the selected sources.'); return; }
      setFlashcardSourceResult({ front: currentFlashcardCard.front, record: match });
      setSourceCheckPageIndex(Math.max(0, Number(match.label.match(/(?:page|slide)\s+(\d+)/i)?.[1] || 1) - 1));
      setFlashcardRevealed(true);
      notify(`Likely match found in ${match.sourceName} · ${match.label.split(' · ').slice(-1)[0]}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not search these sources. Try again.');
    } finally {
      setRagBusy(false);
      setRagProgress('');
    }
  };

  const importQuizResults = async () => {
    try {
      if (!activeSubject) { notify('Create a subject folder first.'); return; }
      if (Platform.OS !== 'web') { notify('Quiz-result importing is available in the browser version.'); return; }
      const picker = document.createElement('input');
      picker.type = 'file'; picker.multiple = true; picker.accept = '.html,.htm,.csv,text/html,text/csv';
      const files = await new Promise<File[]>((resolve) => {
        picker.addEventListener('change', () => resolve(Array.from(picker.files || [])), { once: true });
        picker.addEventListener('cancel', () => resolve([]), { once: true });
        picker.click();
      });
      if (!files.length) return;

      setBusy(true);
      const parsedCards: ImportedFlashcard[] = [];
      const parsedChoiceQuestions: ImportedMultipleChoice[] = [];
      const failures: string[] = [];
      for (const [index, file] of files.entries()) {
        setNotice(`Reading quiz ${index + 1} of ${files.length}: ${file.name}`);
        try {
          if (file.size > 20 * 1024 * 1024) throw new Error('file is over 20 MB');
          const bytes = await file.arrayBuffer();
          const sample = new TextDecoder('latin1').decode(bytes.slice(0, 2048));
          const charset = sample.match(/<meta[^>]+charset=["']?([^\s"'/>;]+)/i)?.[1] || 'utf-8';
          let content: string;
          try { content = new TextDecoder(charset).decode(bytes); }
          catch { content = new TextDecoder('utf-8').decode(bytes); }
          const source = file.name.replace(/\.(?:html?|csv)$/i, '');
          const isCsv = /\.csv$/i.test(file.name);
          const choices = isCsv ? parseMultipleChoiceCsv(content, source) : parsePracticeQuizHtml(content, source);
          const extracted = isCsv
            ? (choices.length ? [] : parseFlashcardCsv(content, source))
            : (choices.length ? [] : parseQuizResultsHtml(content, source));
          if (!extracted.length && !choices.length) {
            throw new Error(/\.csv$/i.test(file.name)
              ? 'No usable content found. Use Question/Answer or Front/Back for cards, or question, options A–D, and correct answer for a quiz.'
              : 'No questions were found. Use a supported practice quiz HTML file or an answered quiz-results page.');
          }
          parsedCards.push(...extracted);
          parsedChoiceQuestions.push(...choices);
          parsedCards.push(...choices.map((item) => ({ front: item.question, back: item.options[item.correctIndex], source: [item.source, item.module].filter(Boolean).join(' · ') })));
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : 'could not be read'}`);
        }
      }

      if (!parsedCards.length && !parsedChoiceQuestions.length) {
        notify(`No study questions were imported. ${failures.slice(0, 3).join(' · ')}`);
        return;
      }

      const existingCards = activeSubject.flashcards || [];
      const cardKey = (card: ImportedFlashcard) => `${card.front.trim().toLocaleLowerCase()}\u0000${card.back.trim().toLocaleLowerCase()}`;
      const knownCards = new Set(existingCards.map(cardKey));
      const additions = parsedCards.filter((card) => {
        const key = cardKey(card);
        if (knownCards.has(key)) return false;
        knownCards.add(key);
        return true;
      });
      const nextCards = [...existingCards, ...additions];
      const existingChoiceQuestions = activeSubject.multipleChoiceQuestions || [];
      const choiceKeys = new Set(existingChoiceQuestions.map((item) => item.question.trim().toLocaleLowerCase()));
      const choiceAdditions = parsedChoiceQuestions.filter((item) => {
        const key = item.question.trim().toLocaleLowerCase();
        if (choiceKeys.has(key)) return false;
        choiceKeys.add(key);
        return true;
      });
      const nextChoiceQuestions = [...existingChoiceQuestions, ...choiceAdditions];
      const existingQuestions = splitQuestions(questionsText);
      const questionKeys = new Set(existingQuestions.map((question) => question.trim().toLocaleLowerCase()));
      const nextQuestions = [...existingQuestions];
      for (const card of nextCards) {
        const key = card.front.trim().toLocaleLowerCase();
        if (!questionKeys.has(key)) { questionKeys.add(key); nextQuestions.push(card.front); }
      }
      for (const item of choiceAdditions) {
        const key = item.question.trim().toLocaleLowerCase();
        if (!questionKeys.has(key)) { questionKeys.add(key); nextQuestions.push(item.question); }
      }
      setSubjects((previous) => previous.map((subject) => subject.id === activeSubject.id ? { ...subject, flashcards: nextCards, multipleChoiceQuestions: nextChoiceQuestions } : subject));
      setQuestionsText(nextQuestions.map((question, questionIndex) => `${questionIndex + 1}. ${question}`).join('\n'));
      setMatches(buildMatches(studySourceSegments, nextQuestions));
      setDemoMaterial(false);
      const duplicateCount = Math.max(0, parsedCards.length - additions.length);
      const sourceNames = [...new Set(additions.map((card) => card.source))];
      notify(`${additions.length} answer card${additions.length === 1 ? '' : 's'} added${choiceAdditions.length ? ` · ${choiceAdditions.length} multiple-choice questions` : ''}${duplicateCount ? ` · ${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'} skipped` : ''}${sourceNames.length ? ` · ${sourceNames.slice(0, 2).join(', ')}` : ''}${failures.length ? ` · ${failures.length} file${failures.length === 1 ? '' : 's'} skipped` : ''}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not import those quiz results.');
    } finally {
      setBusy(false);
    }
  };

function GlassCard({ children, style, dark = false }: { children: React.ReactNode; style?: any; dark?: boolean }) {
  return <BlurView tint={dark ? 'dark' : 'light'} intensity={dark ? 40 : 48} blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : 'none'} testID="torch-block" style={[styles.card, dark && { backgroundColor: 'rgba(22,42,53,0.68)', borderColor: 'rgba(255,255,255,0.28)' }, style]}>{children}</BlurView>;
}

  const importFile = async (kind: 'module' | 'questions') => {
    try {
      if (!activeSubject) {
        notify('Create a subject folder first, then add its files here.');
        return;
      }
      setBusy(true);
      if (Platform.OS !== 'web') {
        notify('Browser file upload is in this prototype. Native Android file picking will be added when we package the app.');
        return;
      }
      const picker = document.createElement('input');
      picker.type = 'file'; picker.multiple = true; picker.accept = kind === 'questions' ? '.pdf,.docx,.ppt,.pptx,.txt,.md,.markdown,.csv,.html,.htm,application/pdf,text/csv,text/html,text/plain,text/markdown' : '.pdf,.docx,.ppt,.pptx,.txt,.md,.markdown,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown';
      const files = await new Promise<File[]>((resolve) => {
        picker.addEventListener('change', () => resolve(Array.from(picker.files || [])), { once: true });
        picker.addEventListener('cancel', () => resolve([]), { once: true });
        picker.click();
      });
      if (!files.length) return;
      const addedFiles: StudyFile[] = [];
      const failures: string[] = [];
      const importedChoiceQuestions: ImportedMultipleChoice[] = [];
      const importedQuestionCards: ImportedFlashcard[] = [];
      let originalSaveFailures = 0;
      for (const [index, file] of files.entries()) {
        setNotice(`Reading ${index + 1} of ${files.length}: ${file.name}`);
        try {
          if (file.size > 20 * 1024 * 1024) throw new Error('over 20 MB');
          const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          let extracted: StudySegment[];
          let content: string;
          const sourceName = file.name.replace(/\.[^.]+$/, '');
          if (kind === 'questions' && /\.(?:csv|html?)$/i.test(file.name)) {
            const text = await file.text();
            const multipleChoice = /\.csv$/i.test(file.name) ? parseMultipleChoiceCsv(text, sourceName) : parsePracticeQuizHtml(text, sourceName);
            const flashcards = /\.csv$/i.test(file.name)
              ? (multipleChoice.length ? [] : parseFlashcardCsv(text, sourceName))
              : (multipleChoice.length ? [] : parseQuizResultsHtml(text, sourceName));
            importedChoiceQuestions.push(...multipleChoice);
            importedQuestionCards.push(...flashcards, ...multipleChoice.map((item) => ({ front: item.question, back: item.options[item.correctIndex], source: [item.source, item.module].filter(Boolean).join(' · ') })));
            const quizPrompts = [...multipleChoice.map((item) => item.question), ...flashcards.map((item) => item.front)];
            if (!quizPrompts.length) throw new Error(/\.csv$/i.test(file.name) ? 'No valid Q&A or multiple-choice rows found.' : 'No supported practice-quiz questions found.');
            content = quizPrompts.join('\n');
            extracted = quizPrompts.map((text, index) => ({ label: `Question ${index + 1}`, text, sourceFileId: fileId }));
          } else {
            extracted = (await extractDocumentText(file)).map((segment) => ({ ...segment, sourceFileId: fileId }));
            content = extracted.map((segment) => segment.text).join('\n\n').trim();
          }
          const canStudyVisually = kind === 'module' && /\.(?:pdf|pptx?)$/i.test(file.name);
          if (!content && !canStudyVisually) throw new Error('no selectable text was found');
          if (content.length > 10_000_000) throw new Error('extracts to over 10 MB of text; split it into smaller files');
          const added: StudyFile = { id: fileId, name: file.name, text: content, segments: extracted, role: kind === 'module' ? 'source' : 'questions' };
          try { await saveOriginalDocument({ id: fileId, name: file.name, type: file.type || 'application/octet-stream', blob: file.slice(0, file.size, file.type || 'application/octet-stream') }); }
          catch { originalSaveFailures += 1; }
          addedFiles.push(added);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'could not be read';
          failures.push(`${file.name}: ${reason}`);
        }
      }
      if (!addedFiles.length) {
        notify(`No files were added. ${failures.slice(0, 3).join(' · ')}`);
        return;
      }
      const uniqueNewCards = importedQuestionCards.filter((card) => !activeSubject.flashcards?.some((saved) => saved.front.toLocaleLowerCase() === card.front.toLocaleLowerCase() && saved.back.toLocaleLowerCase() === card.back.toLocaleLowerCase()));
      const existingChoiceKeys = new Set((activeSubject.multipleChoiceQuestions || []).map((item) => item.question.toLocaleLowerCase()));
      const uniqueChoiceQuestions = importedChoiceQuestions.filter((item) => { const key = item.question.toLocaleLowerCase(); if (existingChoiceKeys.has(key)) return false; existingChoiceKeys.add(key); return true; });
      setSubjects((previous) => previous.map((subject) => subject.id === activeSubject.id ? { ...subject, files: [...subject.files, ...addedFiles], flashcards: [...(subject.flashcards || []), ...uniqueNewCards], multipleChoiceQuestions: [...(subject.multipleChoiceQuestions || []), ...uniqueChoiceQuestions] } : subject));
      if (kind === 'module') {
        const addedSourceFiles = addedFiles.filter((file) => file.role === 'source');
        const nextSelectedIds = [...new Set([...selectedSourceIds, ...addedSourceFiles.map((file) => file.id)])];
        const allSourceFiles = [...activeSubject.files.filter((file) => file.role === 'source'), ...addedSourceFiles];
        const nextSegments = [...(nextSelectedIds.includes('__notes__') ? asStudySegments(notes) : []), ...allSourceFiles.filter((file) => nextSelectedIds.includes(file.id)).flatMap(fileSegments)];
        setSelectedSourceId(null);
        setSelectedSourceIds(nextSelectedIds);
        setSourceScope('selected');
        setMatches(buildMatches(nextSegments, questionList));
        setPreviewSourceId(addedSourceFiles.at(-1)?.id || null);
        setPreviewSlideIndex(0);
        setShowExtractedText(false);
      } else {
        const prompts = [...addedFiles.map((file) => file.text).filter(Boolean), ...uniqueChoiceQuestions.map((item) => item.question), ...uniqueNewCards.map((item) => item.front)];
        const combinedQuestions = [...new Set([...questionList, ...prompts.flatMap(splitQuestions)])];
        setQuestionsText(combinedQuestions.map((question, index) => `${index + 1}. ${question}`).join('\n'));
        setMatches(buildMatches(studySourceSegments, combinedQuestions));
      }
      setDemoMaterial(false);
      const visualOnlyCount = addedFiles.filter((file) => !file.text.trim()).length;
      const success = `${addedFiles.length} ${kind === 'module' ? 'source file' : 'question file'}${addedFiles.length === 1 ? '' : 's'} added to ${activeSubject.name}.`;
      const details = [visualOnlyCount ? `${visualOnlyCount} need OCR for text matching` : '', originalSaveFailures ? `${originalSaveFailures} original${originalSaveFailures === 1 ? '' : 's'} could not be kept for page preview` : '', failures.length ? `${failures.length} skipped: ${failures.slice(0, 2).join(' · ')}` : ''].filter(Boolean).join(' ');
      notify(`${success} ${uniqueChoiceQuestions.length ? `${uniqueChoiceQuestions.length} multiple-choice questions · ` : ''}${uniqueNewCards.length ? `${uniqueNewCards.length} answer cards · ` : ''}${details}`.trim());
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read that file. Try pasting the text instead.');
    } finally {
      setBusy(false);
    }
  };

  const exportWorkspaceBackup = async () => {
    if (Platform.OS !== 'web') { notify('Workspace backup is available in the web version.'); return; }
    try {
      setBackupBusy(true);
      const backupSubjects = subjects.map((subject) => subject.id === activeSubjectId ? { ...subject, notes, questionsText } : subject);
      const workspace: SavedWorkspace = { version: 2, notes, questionsText, demoMaterial, matches, attempted, correct, history, subjects: backupSubjects, activeSubjectId, selectedSourceId, selectedSourceIds, sourceScope };
      const archive = new JSZip();
      const originals: { id: string; name: string; type: string }[] = [];
      let originalBytes = 0;
      for (const subject of backupSubjects) {
        for (const studyFile of subject.files) {
          if (!/^[a-zA-Z0-9_-]+$/.test(studyFile.id)) continue;
          const original = await getOriginalDocument(studyFile.id).catch(() => null);
          if (!original) continue;
          originalBytes += original.blob.size;
          if (originalBytes > 100 * 1024 * 1024) throw new Error('This backup would be larger than 100 MB. Remove some large files and try again.');
          archive.file(`originals/${studyFile.id}`, original.blob);
          originals.push({ id: studyFile.id, name: original.name, type: original.type });
        }
      }
      archive.file('recall-loop-backup.json', JSON.stringify({ format: 'recall-loop-backup', version: 1, createdAt: new Date().toISOString(), workspace, originals }));
      const blob = await archive.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `recall-loop-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notify(`Backup downloaded with ${backupSubjects.length} folder${backupSubjects.length === 1 ? '' : 's'} and ${originals.length} original file${originals.length === 1 ? '' : 's'}. Keep it somewhere private.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not create a workspace backup.');
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreWorkspaceBackup = async () => {
    if (Platform.OS !== 'web') { notify('Workspace restore is available in the web version.'); return; }
    try {
      setBackupBusy(true);
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = '.zip,application/zip';
      const file = await new Promise<File | null>((resolve) => { picker.onchange = () => resolve(picker.files?.[0] || null); picker.click(); });
      if (!file) return;
      if (file.size > 100 * 1024 * 1024) throw new Error('Backup files must be 100 MB or smaller.');
      const archive = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true });
      const uncompressedSize = Object.values(archive.files).reduce((total, item) => total + Number((item as any)._data?.uncompressedSize || 0), 0);
      if (uncompressedSize > 150 * 1024 * 1024) throw new Error('This ZIP expands beyond the 150 MB restore limit. Nothing was restored.');
      const manifestFile = archive.file('recall-loop-backup.json');
      if (!manifestFile) throw new Error('This ZIP does not contain a Recall Loop backup.');
      const manifest = JSON.parse(await manifestFile.async('text')) as { format?: string; version?: number; workspace?: Partial<SavedWorkspace>; originals?: { id: string; name: string; type: string }[] };
      const incoming = manifest.workspace;
      if (manifest.format !== 'recall-loop-backup' || manifest.version !== 1 || !incoming || !Array.isArray(incoming.subjects)) throw new Error('This backup format is invalid or unsupported.');
      const validSubjects = incoming.subjects.every((subject) => !!subject && typeof subject.id === 'string' && typeof subject.name === 'string' && typeof subject.notes === 'string' && typeof subject.questionsText === 'string' && (subject.flashcards === undefined || (Array.isArray(subject.flashcards) && subject.flashcards.every((card) => !!card && typeof card.front === 'string' && typeof card.back === 'string' && typeof card.source === 'string'))) && Array.isArray(subject.files) && subject.files.every((studyFile) => !!studyFile && typeof studyFile.id === 'string' && typeof studyFile.name === 'string' && typeof studyFile.text === 'string' && (studyFile.role === 'source' || studyFile.role === 'questions') && (studyFile.segments === undefined || (Array.isArray(studyFile.segments) && studyFile.segments.every((segment) => !!segment && typeof segment.label === 'string' && typeof segment.text === 'string')))));
      if (!validSubjects) throw new Error('The backup contains incomplete folder or file data. Nothing was restored.');
      const originals: OriginalDocument[] = [];
      let restoredOriginalBytes = 0;
      for (const item of manifest.originals || []) {
        if (!item || !/^[a-zA-Z0-9_-]+$/.test(item.id) || typeof item.name !== 'string' || typeof item.type !== 'string') continue;
        const originalFile = archive.file(`originals/${item.id}`);
        if (originalFile) {
          const extractedBlob = await originalFile.async('blob');
          const blob = new Blob([extractedBlob], { type: item.type });
          restoredOriginalBytes += blob.size;
          if (restoredOriginalBytes > 100 * 1024 * 1024) throw new Error('The extracted originals exceed 100 MB. Nothing was restored.');
          originals.push({ id: item.id, name: item.name, type: item.type, blob });
        }
      }
      await replaceOriginalDocuments(originals);
      await clearVectorIndexes();
      const restoredSubjects = incoming.subjects as Subject[];
      const restoredActiveId = restoredSubjects.some((subject) => subject.id === incoming.activeSubjectId) ? incoming.activeSubjectId! : restoredSubjects[0]?.id || null;
      const active = restoredSubjects.find((subject) => subject.id === restoredActiveId);
      setSubjects(restoredSubjects); setActiveSubjectId(restoredActiveId); setNotes(active?.notes || incoming.notes || ''); setQuestionsText(active?.questionsText || incoming.questionsText || '');
      setDemoMaterial(incoming.demoMaterial === true); setMatches(Array.isArray(incoming.matches) ? incoming.matches as Match[] : []);
      setAttempted(Number.isFinite(incoming.attempted) ? Number(incoming.attempted) : 0); setCorrect(Number.isFinite(incoming.correct) ? Number(incoming.correct) : 0);
      setHistory(Array.isArray(incoming.history) ? incoming.history as StudyAttempt[] : []); setSelectedSourceId(typeof incoming.selectedSourceId === 'string' ? incoming.selectedSourceId : null);
      setSelectedSourceIds(Array.isArray(incoming.selectedSourceIds) ? incoming.selectedSourceIds.filter((id): id is string => typeof id === 'string') : []);
      setSourceScope(incoming.sourceScope === 'file' || incoming.sourceScope === 'notes' || incoming.sourceScope === 'selected' ? incoming.sourceScope : 'subject');
      setFolderOpen(false); setPreviewSourceId(null); setSourceViewerOpen(false); setSourceReader(null); setConfirmRestoreBackup(false); setPage('home'); setQuestionIndex(0); setAnswer(null); setAnswerDraft('');
      notify(`Restored ${restoredSubjects.length} folder${restoredSubjects.length === 1 ? '' : 's'} and ${originals.length} original file${originals.length === 1 ? '' : 's'}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not restore this backup. Your current workspace was kept.');
    } finally {
      setBackupBusy(false);
    }
  };

  const createSubject = () => {
    const name = newSubjectName.trim();
    if (!name) { notify('Enter a subject name, such as Physics.'); return; }
    const created: Subject = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, notes: '', questionsText: '', files: [] };
    setSubjects((previous) => [...previous.map((subject) => subject.id === activeSubjectId ? { ...subject, notes, questionsText } : subject), created]);
    setActiveSubjectId(created.id); setNotes(''); setQuestionsText(''); setMatches([]); setSelectedSourceId(null); setSelectedSourceIds([]); setPreviewSourceId(null); setSourceViewerOpen(false); setSourceScope('subject'); setMaterialsTab('sources'); setDemoMaterial(false); setNewSubjectName('');
    notify(`${name} is ready. Add notes or upload source files to this subject.`);
  };

  const selectSubject = (id: string) => {
    const next = subjects.find((subject) => subject.id === id);
    if (!next) return;
    setSubjects((previous) => previous.map((subject) => subject.id === activeSubjectId ? { ...subject, notes, questionsText } : subject));
    setActiveSubjectId(next.id); setNotes(next.notes); setQuestionsText(next.questionsText); setMatches(buildMatches([...asStudySegments(next.notes), ...next.files.filter((file) => file.role === 'source').flatMap(fileSegments)], splitQuestions(next.questionsText)));
    setSelectedSourceId(null); setSelectedSourceIds([]); setPreviewSourceId(null); setSourceViewerOpen(false); setSourceScope('subject'); setMaterialsTab('sources'); setDemoMaterial(false);
  };

  const openSubject = (id: string) => {
    if (id !== activeSubjectId) selectSubject(id);
    setFolderOpen(true);
  };

  const setSourceToFile = (file: StudyFile) => {
    setSelectedSourceId(file.id); setSourceScope('file'); setMatches(buildMatches(fileSegments(file), questionList));
  };

  const toggleStudySource = (sourceId: string) => {
    const nextIds = selectedSourceIds.includes(sourceId) ? selectedSourceIds.filter((id) => id !== sourceId) : [...selectedSourceIds, sourceId];
    const nextSegments = [...(nextIds.includes('__notes__') ? asStudySegments(notes) : []), ...(activeSubject?.files.filter((file) => file.role === 'source' && nextIds.includes(file.id)).flatMap(fileSegments) || [])];
    setSelectedSourceIds(nextIds); setSelectedSourceId(null); setSourceScope('selected'); setMatches(buildMatches(nextSegments, questionList));
  };

  const selectAllStudySources = () => {
    const allIds = [...(notes.trim() ? ['__notes__'] : []), ...(activeSubject?.files.filter((file) => file.role === 'source').map((file) => file.id) || [])];
    const nextIds = allIds.length && allIds.every((id) => selectedSourceIds.includes(id)) ? [] : allIds;
    const nextSegments = [...(nextIds.includes('__notes__') ? asStudySegments(notes) : []), ...(activeSubject?.files.filter((file) => file.role === 'source' && nextIds.includes(file.id)).flatMap(fileSegments) || [])];
    setSelectedSourceIds(nextIds); setSelectedSourceId(null); setSourceScope('selected'); setMatches(buildMatches(nextSegments, questionList));
  };

  const selectAllSourceFiles = () => {
    const fileIds = sourceFiles.map((file) => file.id);
    const filesAlreadySelected = fileIds.length > 0 && fileIds.every((id) => selectedSourceIds.includes(id));
    const nextIds = filesAlreadySelected ? selectedSourceIds.filter((id) => id === '__notes__') : [...new Set([...selectedSourceIds, ...fileIds])];
    const nextSegments = [...(nextIds.includes('__notes__') ? asStudySegments(notes) : []), ...sourceFiles.filter((file) => nextIds.includes(file.id)).flatMap(fileSegments)];
    setSelectedSourceIds(nextIds); setSelectedSourceId(null); setSourceScope('selected'); setMatches(buildMatches(nextSegments, questionList));
  };

  const beginStudyFormat = (format: 'flashcards' | 'qa' | 'read') => {
    if (!selectedSourceIds.length && !(format === 'flashcards' && importedFlashcards.length) && !(format === 'qa' && questionList.length)) { notify('Select at least one source to study.'); return; }
    if (format === 'flashcards' && !selectedSourceIds.length && importedFlashcards.length) {
      setStudyFormat(format); setFlashcardRevealed(false); setFlashcardReviewDeck(null); setFlashcardRatings({}); setFlashcardSourceResult(null); setQuestionIndex(0); setPhase('diagnostic'); setAnswer(null); setAnswerDraft(''); setAiFeedback(null); setPage('study'); setDemoMaterial(false);
      return;
    }
    setSourceScope('selected'); setStudyFormat(format); setFlashcardRevealed(false); if (format === 'flashcards') { setFlashcardReviewDeck(null); setFlashcardRatings({}); setFlashcardSourceResult(null); setQuestionIndex(0); } setReadMaterialIndex(0); setPreviewSlideIndex(0);
    const sourceSegments = [...(selectedSourceIds.includes('__notes__') ? asStudySegments(notes) : []), ...(activeSubject?.files.filter((file) => file.role === 'source' && selectedSourceIds.includes(file.id)).flatMap(fileSegments) || [])];
    const sessionQuestions = format === 'flashcards' ? flashcardDeck.map((card) => card.front) : questionList.length ? questionList : format === 'read' ? [] : draftPracticeQuestions(sourceSegments.map((segment) => segment.text).join('\n\n'));
    if (!questionList.length && format !== 'read' && sessionQuestions.length) setQuestionsText(sessionQuestions.map((question, index) => `${index + 1}. ${question}`).join('\n'));
    setMatches(buildMatches(sourceSegments, sessionQuestions));
    if (format !== 'read' && !sessionQuestions.length) { notify('Add some questions or clearer source notes before starting practice.'); return; }
    startStudy(selectedPace);
  };

  const activateSubjectFile = (file: StudyFile) => {
    if (file.role === 'questions') {
      setQuestionsText(file.text);
      notify(`${file.name} loaded into the questions editor.`);
      return;
    }
    setSourceToFile(file);
    setPreviewSlideIndex(0);
    openSourceViewer(file);
  };

  const removeSubjectFile = (fileId: string) => {
    const updatedFiles = activeSubject?.files.filter((file) => file.id !== fileId) || [];
    if (Platform.OS === 'web') { void deleteOriginalDocument(fileId).catch(() => undefined); if (activeSubjectId) void deleteVectorIndex(activeSubjectId, fileId).catch(() => undefined); }
    setSubjects((previous) => previous.map((subject) => subject.id === activeSubjectId ? { ...subject, files: updatedFiles } : subject));
    if (previewSourceId === fileId) { setPreviewSourceId(null); setSourceViewerOpen(false); }
    setSelectedSourceIds((previous) => previous.filter((id) => id !== fileId));
    if (selectedSourceId === fileId) { setSelectedSourceId(null); setSourceScope('subject'); setMatches(buildMatches([...asStudySegments(notes), ...updatedFiles.filter((file) => file.role === 'source').flatMap(fileSegments)], questionList)); }
  };

  const matchQuestions = () => {
    const next = buildMatches(studySourceSegments, questionList);
    setMatches(next);
    setShowMatchReview(true);
  };

  const generateQuestions = async () => {
    if (!apiKey) { setShowApiKeyModal(true); return; }
    if (studySourceText.trim().length < 40) { notify('Add or select source material first.'); return; }
    setAiBusy(true);
    try {
      const result = await draftQuestionsWithAI(apiKey, studySourceText, questionList, 8, apiKeyProvider || aiProvider, setNotice);
      const additions = result.questions.map((question) => question.trim()).filter((question) => question && !questionList.some((existing) => existing.toLowerCase() === question.toLowerCase()));
      if (!additions.length) { notify('AI could not find any new questions in these sources.'); return; }
      const updatedQuestions = [...questionList, ...additions];
      setQuestionsText(updatedQuestions.map((question, index) => `${index + 1}. ${question}`).join('\n'));
      setDemoMaterial(false);
      setMatches(buildMatches(studySourceSegments, updatedQuestions));
      notify(`${additions.length} AI-written questions added. Review and edit them before studying.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not draft questions. Try again.');
    } finally { setAiBusy(false); }
  };

  const generateSummaryFor = async (text: string, subjectName: string, sourceHash: string) => {
    if (!apiKey) { setShowApiKeyModal(true); return; }
    if (text.trim().length < 40) { notify('Add more source material for an AI overview.'); return; }
    setAiBusy(true);
    try {
      const result = await summarizeWithAI(apiKey, text, subjectName, apiKeyProvider || aiProvider, setNotice);
      setAiSummary({ subjectId: activeSubjectId || '', sourceHash, result });
      setNotice('');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not summarize these sources. Try again.');
    } finally { setAiBusy(false); }
  };

  const generateSummary = async () => generateSummaryFor(selectedAiMaterialText, activeSubject?.name || 'Study materials', aiSourceHash);

  const generateStudySet = async () => {
    if (!apiKey) throw new Error(`Connect your ${aiProviderName} key to generate a study set.`);
    if (selectedAiMaterialText.trim().length < 40) throw new Error('Select source material with enough text to build a study set.');
    setAiBusy(true);
    try {
      return await generateStudySetWithAI(apiKey, selectedAiMaterialText, activeSubject?.name || 'Study materials', questionList, aiStudySourceHash, apiKeyProvider || aiProvider, setNotice);
    } finally { setAiBusy(false); setNotice(''); }
  };

  const startDiagnostic = () => { setStudyFormat('qa'); setQuestionIndex(0); setPhase('diagnostic'); setAnswer(null); setAnswerDraft(''); setAiFeedback(null); };
  const startModuleReading = () => { setStudyFormat('read'); setReadMaterialIndex(0); setPreviewSlideIndex(0); setShowExtractedText(false); setPhase('module'); setAnswer(null); setAnswerDraft(''); setAiFeedback(null); };
  const startQuiz = async () => {
    let questions = questionList;
    if (!questions.length) {
      try {
        if (apiKey && studySourceText.trim().length >= 40) {
          setAiBusy(true);
          const result = await draftQuestionsWithAI(apiKey, studySourceText, [], 6, apiKeyProvider || aiProvider, setNotice);
          questions = result.questions.map((question) => question.trim()).filter(Boolean);
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Could not make a quiz. Try again.');
      } finally { setAiBusy(false); }
      if (!questions.length) questions = draftPracticeQuestions(studySourceText);
      if (questions.length) {
        setQuestionsText(questions.map((question, index) => `${index + 1}. ${question}`).join('\n'));
        setMatches(buildMatches(studySourceSegments, questions));
      }
    }
    if (!questions.length) { notify('Add questions or clearer source text before starting a quiz.'); return; }
    setStudyFormat('qa'); setQuestionIndex(0); setPhase('check'); setAnswer(null); setAnswerDraft(''); setAiFeedback(null); setNotice('');
  };

  const openQuestionReview = () => {
    if (currentMatch) {
      const file = findMatchSourceFile(currentMatch);
      if (file) {
        const fileIndex = selectedStudyFiles.findIndex((item) => item.id === file.id);
        const segmentIndex = fileSegments(file).findIndex((segment) => segment.label === currentMatch.sourceLabel);
        if (fileIndex >= 0) setReadMaterialIndex(fileIndex);
        setPreviewSlideIndex(Math.max(0, segmentIndex));
      }
    }
    setStudyFormat('read'); setPhase('review'); setShowExtractedText(false);
  };

  const getAnswerFeedback = async () => {
    if (answer !== null) return;
    if (!apiKey) { setShowApiKeyModal(true); return; }
    if (!answerDraft.trim()) { notify('Write a short answer first.'); return; }
    if (studySourceText.trim().length < 40) { notify('Add or select source material first.'); return; }
    setAiBusy(true);
    try {
      const result = await checkAnswerWithAI(apiKey, studySourceText, currentQuestion, answerDraft, apiKeyProvider || aiProvider);
      setAiFeedback(result);
      const supported = result.assessment === 'supported';
      const outcome: StudyAttempt['outcome'] = supported ? 'self-rated-ready' : 'needs-review';
      setAnswer(supported ? 1 : 0);
      setAttempted((count) => count + 1);
      setHistory((previous) => [{ id: `${Date.now()}-${previous.length}`, question: currentQuestion, mode, outcome, createdAt: new Date().toISOString() }, ...previous].slice(0, 200));
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not check this answer. Try again.');
    } finally { setAiBusy(false); }
  };

  const clearWorkspace = () => {
    setNotes(''); setQuestionsText(''); setMatches([]); setAttempted(0); setCorrect(0); setHistory([]); setSelectedSourceIds([]);
    setDemoMaterial(false); setSubjects([]); setActiveSubjectId(null); setFolderOpen(false); setSelectedSourceId(null); setSelectedSourceIds([]); setPreviewSourceId(null); setSourceViewerOpen(false); setPreviewSlideIndex(0); setShowExtractedText(false); setSourceReader(null); setSourceScope('subject'); setNotice('Your workspace is empty. Create a subject and add notes whenever you’re ready.');
    if (Platform.OS === 'web') {
      window.localStorage.removeItem(storageKey); window.localStorage.removeItem(legacyStorageKey);
      void clearOriginalDocuments().catch(() => undefined);
      void clearWorkspaceSnapshot().catch(() => undefined);
      void clearVectorIndexes().catch(() => undefined);
    }
    setPage('home'); setQuestionIndex(0); setAnswer(null); setAnswerDraft(''); setFlashcardRatings({}); setFlashcardReviewDeck(null); setFlashcardSourceResult(null);
  };

  const startStudy = (pace: Pace = mode, firstQuestionIndex = 0) => {
    const defaultIds = [...(notes.trim() ? ['__notes__'] : []), ...sourceFiles.map((file) => file.id)];
    const effectiveIds = selectedSourceIds.length ? selectedSourceIds : sourceScope === 'selected' ? [] : defaultIds;
    if (!effectiveIds.length && (sourceFiles.length || notes.trim())) { notify('Select at least one source before starting.'); setPage('import'); return; }
    if (!selectedSourceIds.length && effectiveIds.length) {
      setSelectedSourceIds(effectiveIds);
      setSourceScope('selected');
      setMatches(buildMatches([...(effectiveIds.includes('__notes__') ? asStudySegments(notes) : []), ...sourceFiles.filter((file) => effectiveIds.includes(file.id)).flatMap(fileSegments)], questionList));
    }
    const overviewText = [...(effectiveIds.includes('__notes__') && notes.trim() ? [`Subject notes\n${notes}`] : []), ...sourceFiles.filter((file) => effectiveIds.includes(file.id)).flatMap((file) => fileSegments(file).map((segment) => `${file.name} · ${segment.label}\n${segment.text}`))].join('\n\n');
    const overviewHash = hashText(`${activeSubject?.name || 'Study materials'}\n${overviewText}`);
    const hasCachedOverview = aiSummary?.subjectId === (activeSubjectId || '') && aiSummary.sourceHash === overviewHash;
    setMode(pace); setSelectedPace(pace); setQuestionIndex(Math.max(0, firstQuestionIndex)); setPhase('overview'); setAnswer(null); setAnswerDraft(''); setAiFeedback(null); setPage('study');
    if (!hasCachedOverview && apiKey && overviewText.trim().length >= 40) void generateSummaryFor(overviewText, activeSubject?.name || 'Study materials', overviewHash);
  };

  const submitAnswer = (value: number) => {
    if (answer !== null) return;
    const gradedChoice = demoMaterial || !!currentImportedQuiz;
    const outcome: StudyAttempt['outcome'] = gradedChoice ? (value === correctAnswer ? 'correct' : 'missed') : (value === 1 ? 'self-rated-ready' : 'needs-review');
    setAnswer(value);
    setAttempted((n) => n + 1);
    if (gradedChoice && value === correctAnswer) setCorrect((n) => n + 1);
    setHistory((previous) => [{ id: `${Date.now()}-${previous.length}`, question: currentQuestion, mode, outcome, createdAt: new Date().toISOString() }, ...previous].slice(0, 200));
  };

  const continueSession = () => {
    if (phase === 'diagnostic' && hasNextQuestion) { setQuestionIndex((index) => index + 1); setAnswer(null); setAnswerDraft(''); setAiFeedback(null); }
    else if (phase === 'diagnostic') { setStudyFormat('read'); setReadMaterialIndex(0); setPreviewSlideIndex(0); setPhase('module'); setAnswer(null); setAnswerDraft(''); }
    else if (phase === 'check' && hasNextQuestion) { setQuestionIndex((index) => index + 1); setAnswer(null); setAnswerDraft(''); setAiFeedback(null); }
    else { setPhase('diagnostic'); setAnswer(null); setAnswerDraft(''); setPage('insights'); }
  };

  const quizPanel = demoMaterial || currentImportedQuiz ? <View style={[styles.card, { gap: 16 }]}><Text style={styles.label}>{phase === 'diagnostic' ? `QUESTION ${questionIndex + 1}` : 'RECALL CHECK'}</Text>{currentImportedQuiz?.module && <Text style={styles.small}>{currentImportedQuiz.module}</Text>}<Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800', lineHeight: 28 }}>{currentQuestion}</Text>
    {quizOptions.map((option, i) => <Pressable key={i} accessibilityRole="button" accessibilityState={{ selected: answer === i }} disabled={answer !== null} onPress={() => submitAnswer(i)} style={{ borderWidth: 1, borderColor: answer === i ? (i === correctAnswer ? '#43c982' : '#db785b') : answer !== null && i === correctAnswer ? '#43c982' : palette.line, backgroundColor: answer === i ? (i === correctAnswer ? 'rgba(33,129,91,0.28)' : 'rgba(217,120,91,0.20)') : answer !== null && i === correctAnswer ? 'rgba(33,129,91,0.18)' : 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 14 }}><Text style={{ color: palette.ink, fontWeight: '600', fontSize: 14 }}>{String.fromCharCode(65 + i)}. {option}</Text></Pressable>)}
    {answer !== null && <View style={{ padding: 13, borderRadius: 11, backgroundColor: answer === correctAnswer ? 'rgba(33,129,91,0.20)' : 'rgba(217,120,91,0.16)', borderWidth: 1, borderColor: answer === correctAnswer ? 'rgba(67,201,130,0.48)' : 'rgba(217,120,91,0.45)' }}><Text style={{ color: answer === correctAnswer ? '#8ce0ae' : '#f0a38d', fontWeight: '800' }}>{answer === correctAnswer ? 'Correct.' : `Correct answer: ${String.fromCharCode(65 + correctAnswer)}. ${quizOptions[correctAnswer]}`}</Text><Text style={[styles.small, { marginTop: 4, color: '#c3cfca' }]}>{currentImportedQuiz?.optionExplanations?.[answer] || currentImportedQuiz?.explanation || currentDemoQuiz.feedback[answer]}</Text></View>}
    {answer !== null && phase === 'diagnostic' && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton label={hasNextQuestion ? 'Next diagnostic →' : 'Review module →'} onPress={continueSession} />{!hasNextQuestion && <ActionButton secondary label="Skip to quiz" onPress={() => void startQuiz()} />}</View>}
    {answer !== null && phase === 'check' && (answer !== correctAnswer ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton label="Review this part →" onPress={openQuestionReview} /><ActionButton secondary label={hasNextQuestion ? 'Next question' : 'Finish quiz'} onPress={continueSession} /></View> : <ActionButton label={hasNextQuestion ? 'Next question →' : 'Finish quiz →'} onPress={continueSession} />)}
    {phase === 'diagnostic' && answer === null && <ActionButton secondary label="Skip diagnostic · read module" onPress={startModuleReading} />}
  </View> : <View style={[styles.card, { gap: 16 }]}><Text style={styles.label}>{phase === 'diagnostic' ? 'RECALL' : 'RETRY'}</Text><Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800', lineHeight: 28 }}>{currentQuestion}</Text><Text style={styles.body}>Answers are self-rated, not graded.</Text>
    <TextInput value={answerDraft} onChangeText={(value) => { setAnswerDraft(value); setAiFeedback(null); }} editable={answer === null} multiline placeholder="Type a short answer or key points…" placeholderTextColor="#9ba6ad" style={[styles.input, { minHeight: 90, opacity: answer === null ? 1 : 0.72 }]} />
    {answer === null && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton compact label={aiBusy ? 'Checking…' : 'Check with AI'} disabled={aiBusy} onPress={() => void getAnswerFeedback()} /><ActionButton compact secondary label="I could explain it" disabled={aiBusy} onPress={() => submitAnswer(1)} /><ActionButton compact secondary label="Not sure yet" disabled={aiBusy} onPress={() => submitAnswer(0)} /></View>}
    {aiFeedback && <View accessibilityLiveRegion="polite" style={{ padding: 13, borderRadius: 11, backgroundColor: aiFeedback.assessment === 'supported' ? 'rgba(33,129,91,0.20)' : 'rgba(245,216,94,0.1)', borderWidth: 1, borderColor: aiFeedback.assessment === 'supported' ? 'rgba(67,201,130,0.42)' : 'rgba(245,216,94,0.32)', gap: 5 }}><Text style={{ color: aiFeedback.assessment === 'supported' ? '#8ce0ae' : '#fff2ad', fontWeight: '800' }}>{aiFeedback.assessment === 'supported' ? 'Supported by your source' : aiFeedback.assessment === 'partial' ? 'Partly supported' : 'Review the source'}</Text><Text style={[styles.body, { color: '#d7e2dc' }]}>{aiFeedback.feedback}</Text>{!!aiFeedback.evidence && <Text style={styles.small}>“{aiFeedback.evidence}”</Text>}</View>}
    {answer !== null && <View style={{ padding: 13, borderRadius: 11, backgroundColor: answer === 1 ? 'rgba(33,129,91,0.20)' : 'rgba(245,216,94,0.12)', borderWidth: 1, borderColor: answer === 1 ? 'rgba(67,201,130,0.42)' : 'rgba(245,216,94,0.32)' }}><Text style={{ color: answer === 1 ? '#8ce0ae' : '#fff2ad', fontWeight: '800' }}>{answer === 1 ? 'Ready' : 'Review again'}</Text></View>}
    {answer !== null && phase === 'diagnostic' && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton label={hasNextQuestion ? 'Next diagnostic →' : 'Review module →'} onPress={continueSession} />{!hasNextQuestion && <ActionButton secondary label="Skip to quiz" onPress={() => void startQuiz()} />}</View>}
    {answer !== null && phase === 'check' && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>{answer === 0 && <ActionButton label="Review this part →" onPress={openQuestionReview} />}<ActionButton secondary label={hasNextQuestion ? 'Next question' : 'Finish quiz'} onPress={continueSession} /></View>}
    {phase === 'diagnostic' && answer === null && <ActionButton secondary label="Skip diagnostic · read module" onPress={startModuleReading} />}
  </View>;

  const reviewFile = currentMatch ? findMatchSourceFile(currentMatch) : null;
  const reviewPanel = <View style={[styles.card, { gap: 16 }]}>
    <View><Text style={styles.label}>QUESTION LINKED TO THIS SOURCE</Text><Text style={{ color: palette.ink, fontWeight: '800', fontSize: 19, lineHeight: 27, marginTop: 6 }}>{currentQuestion}</Text><Text style={[styles.small, { marginTop: 5 }]}>{currentMatch?.sourceLabel || 'No exact source match was found; review the closest available passage.'}</Text></View>
    {reviewFile ? <>{lecturePreview(reviewFile, currentQuestion, true)}<Text style={styles.small}>Highlighted context from the original material. The page layout stays intact.</Text></> : <View style={{ borderRadius: 11, padding: 13, borderWidth: 1, borderColor: 'rgba(245,216,94,0.25)', backgroundColor: 'rgba(245,216,94,0.07)' }}>{highlightedPassage(reviewPassage, currentQuestion)}</View>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton label="Try this question again →" onPress={() => { setPhase('check'); setAnswer(null); setAnswerDraft(''); setAiFeedback(null); }} /><ActionButton secondary label="Back to module" onPress={startModuleReading} /></View>
  </View>;

  const navigateFlashcard = (direction: -1 | 1) => {
    setQuestionIndex((index) => Math.max(0, Math.min(flashcardDeck.length - 1, index + direction)));
    setPhase('diagnostic');
    setFlashcardRevealed(false);
    setFlashcardSourceResult(null);
  };

  const rateFlashcard = (rating: 'known' | 'unknown') => {
    if (!currentFlashcardCard) return;
    setFlashcardRatings((previous) => ({ ...previous, [flashcardKey(currentFlashcardCard)]: rating }));
    setFlashcardSourceResult(null);
    setFlashcardRevealed(false);
    if (questionIndex < flashcardDeck.length - 1) setQuestionIndex((index) => index + 1);
    else setPhase('flashcardsDone');
  };

  const reviewMissedFlashcards = () => {
    setFlashcardReviewDeck(unknownFlashcards);
    setQuestionIndex(0);
    setFlashcardRevealed(false);
    setFlashcardSourceResult(null);
    setPhase('diagnostic');
  };

  const flashcardsDonePanel = <View testID="torch-block" style={[styles.card, { gap: 14, alignItems: 'flex-start' }]}>
    <Text style={styles.label}>REVIEW COMPLETE</Text>
    <Text style={{ color: palette.ink, fontSize: 23, lineHeight: 30, fontWeight: '800' }}>You reviewed {flashcardDeck.length} card{flashcardDeck.length === 1 ? '' : 's'}</Text>
    <Text style={styles.body}>{knownFlashcardCount} known · {unknownFlashcards.length} to revisit</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>
      {!!unknownFlashcards.length && <ActionButton label={`Review ${unknownFlashcards.length} missed`} onPress={reviewMissedFlashcards} />}
      {!!flashcardDeck.length && <ActionButton secondary label="Back to last card" onPress={() => { setQuestionIndex(flashcardDeck.length - 1); setFlashcardRevealed(true); setPhase('diagnostic'); }} />}
      <ActionButton secondary label="Done" onPress={() => setPage('import')} />
    </View>
  </View>;

  const navItems = [
    { id: 'home' as const, icon: '⌂', label: 'Home' },
    { id: 'modes' as const, icon: '◉', label: 'Review' },
    { id: 'import' as const, icon: '▤', label: 'Materials' },
    { id: 'insights' as const, icon: '◴', label: 'Progress' },
  ];

  const brand = <Pressable accessibilityRole="link" accessibilityLabel="Recall Loop home" onPress={() => setPage('home')} style={[styles.brandRow, { marginBottom: 0, marginRight: wide || compact ? 0 : 'auto', paddingVertical: 7 }]}>
    <Svg {...(Platform.OS === 'web' ? { 'aria-hidden': true } : { accessibilityElementsHidden: true })} width={34} height={30} viewBox="0 0 36 32" fill="none">
      <Path d="M4.5 7.5C9.1 5.6 13.6 6.1 18 9.2C22.4 6.1 26.9 5.6 31.5 7.5V25.6C26.9 23.8 22.4 24.1 18 27C13.6 24.1 9.1 23.8 4.5 25.6V7.5Z" stroke="#94dfa9" strokeWidth={2} strokeLinejoin="round" />
      <Path d="M18 9.5V26" stroke="#94dfa9" strokeWidth={1.6} strokeLinecap="round" />
      <Path d="M8 16C10.6 12.5 13.4 12.5 18 16C22.6 19.5 25.4 19.5 28 16C25.4 12.5 22.6 12.5 18 16C13.4 19.5 10.6 19.5 8 16Z" stroke="#e9d77b" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
    <Text testID="brand-wordmark" style={{ color: Platform.OS === 'web' ? 'transparent' : '#dff5e6', fontFamily: Platform.OS === 'web' ? 'Segoe UI Variable, Inter, system-ui, sans-serif' : undefined, fontSize: 23, fontWeight: '600', letterSpacing: -0.65, textShadowColor: 'rgba(177,255,202,0.28)', textShadowRadius: 12, textShadowOffset: { width: 0, height: 1 } }}>Recall Loop</Text>
  </Pressable>
  const registerButton = <Pressable testID="register-glass" accessibilityRole="button" style={{ minHeight: 44, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 22, borderWidth: 1, borderColor: 'rgba(190,255,216,0.28)', backgroundColor: 'rgba(202,255,222,0.08)', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.ink, fontWeight: '700', fontSize: 13 }}>Register</Text></Pressable>;
  const pinnedNav = <View testID="nav-track" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
    <View testID="nav-glass-indicator" pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, borderRadius: 24 }} />
    {navItems.map((item) => { const active = activeNavId === item.id; return <Pressable key={item.id} testID={`nav-item-${item.id}`} onPress={() => setPage(item.id)} style={{ zIndex: 1, minHeight: 42, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 18, backgroundColor: Platform.OS === 'web' ? 'transparent' : active ? 'rgba(33,129,91,0.40)' : 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: Platform.OS !== 'web' && active ? 'rgba(90,210,141,0.28)' : 'transparent', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: active ? '#eaffef' : '#b9c5c0', fontWeight: '700', fontSize: 12 }}>{item.label}</Text></Pressable>; })}
  </View>;
  const fixedHeader = <View style={[styles.header, { minHeight: compact ? 116 : 78, flexWrap: 'wrap', gap: compact ? 7 : 12, paddingTop: compact ? 6 : 0, paddingBottom: compact ? 8 : 0 }]}>
    {brand}
    {compact && <View style={{ marginLeft: 'auto' }}>{registerButton}</View>}
    {wide && <View style={{ position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', pointerEvents: 'box-none' }}>{pinnedNav}</View>}
    {!wide && !compact && pinnedNav}
    {compact && <View style={{ width: '100%', alignItems: 'center' }}>{pinnedNav}</View>}
    {!compact && <View style={{ marginLeft: 'auto' }}>{registerButton}</View>}
  </View>;

  const paceOptions: { id: Pace; icon: string; title: string; time: string; description: string }[] = [
    { id: 'cram', icon: '⚡︎', title: 'Cram', time: '10 min', description: 'Find gaps. Review. Retry.' },
    { id: 'steady', icon: '↗', title: 'Steady', time: '20 min', description: 'Recall, then review your questions.' },
    { id: 'deep', icon: '◎', title: 'Deep', time: '35 min', description: 'Read the module, then test yourself.' },
  ];
  const selectedOption = paceOptions.find((option) => option.id === selectedPace)!;
  const tutorialSteps = [
    { label: 'Add', title: 'Start with a source', description: 'Create a subject folder, then paste notes or upload a lecture.', accent: '#a6e5b8' },
    { label: 'Choose', title: 'Set your study focus', description: 'Select one or more sources, then read, practice questions, or build an AI study set.', accent: palette.aqua },
    { label: 'Study', title: 'Learn by retrieving', description: 'Pick Cram, Steady, or Deep. Answer from memory, then check the source.', accent: palette.yellow },
  ];
  const activeTutorialStep = tutorialSteps[tutorialStep];
  const heroTutorial = <View testID="torch-block" style={[styles.card, { width: '100%', maxWidth: wide ? 500 : 760, gap: 18, padding: compact ? 17 : 22, backgroundColor: 'rgba(13,34,34,0.88)', borderColor: 'rgba(123,217,208,0.32)', shadowColor: '#40b9b0', shadowOpacity: 0.13, shadowRadius: 28 }]}>
    <View style={{ gap: 5 }}><Text style={[styles.label, { color: palette.aqua }]}>YOUR FIRST STUDY LOOP</Text><Text style={{ color: palette.ink, fontSize: compact ? 18 : 20, fontWeight: '800' }}>From source to study session</Text></View>
    <View style={{ flexDirection: 'row', gap: 7 }}>
      {tutorialSteps.map((step, index) => {
        const active = tutorialStep === index;
        return <Pressable key={step.label} accessibilityRole="button" accessibilityLabel={`Step ${index + 1}: ${step.label}`} accessibilityState={{ selected: active }} onPress={() => setTutorialStep(index)} style={{ flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: compact ? 5 : 9, borderRadius: 12, borderWidth: 1, borderColor: active ? `${step.accent}88` : 'rgba(211,241,238,0.12)', backgroundColor: active ? `${step.accent}1c` : 'rgba(255,255,255,0.025)' }}><Text style={{ color: active ? step.accent : palette.muted, fontSize: 11, fontWeight: '900' }}>0{index + 1}</Text><Text numberOfLines={1} style={{ color: active ? palette.ink : palette.muted, fontSize: compact ? 11 : 12, fontWeight: '800' }}>{step.label}</Text></Pressable>;
      })}
    </View>
    <View accessibilityLiveRegion="polite" style={{ minHeight: compact ? 108 : 96, justifyContent: 'center', gap: 7, paddingVertical: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}><View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: activeTutorialStep.accent }} /><Text style={{ color: palette.ink, fontSize: compact ? 17 : 18, fontWeight: '800' }}>{activeTutorialStep.title}</Text></View>
      <Text style={[styles.body, { lineHeight: 22 }]}>{activeTutorialStep.description}</Text>
    </View>
    <ActionButton label={tutorialStep === 0 ? 'Add materials →' : tutorialStep === 1 ? 'Choose sources →' : hasStudyContent ? 'Choose a pace →' : 'Add materials first →'} onPress={() => setPage(tutorialStep === 2 && hasStudyContent ? 'modes' : 'import')} />
  </View>;
  const materialsSection = <View testID="scroll-reveal" style={{ paddingVertical: 54, borderTopWidth: 1, borderColor: palette.line, gap: 14 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <View style={{ gap: 5 }}><Text style={[styles.label, { color: '#8fcba6' }]}>MATERIALS</Text><Text style={[styles.title, { fontSize: 28 }]}>{hasStudyContent ? displayModuleTitle : 'Build your study set'}</Text></View>
      <ActionButton secondary label={hasStudyContent ? 'Open materials' : 'Add materials'} onPress={() => setPage('import')} />
    </View>
  </View>;
  const home = <View style={[styles.content, { paddingTop: 10, gap: 0 }]}>
    <View testID="scroll-reveal" style={{ minHeight: compact ? undefined : wide ? 500 : undefined, flexDirection: wide ? 'row' : 'column', justifyContent: 'center', alignItems: 'center', paddingVertical: compact ? 34 : 54, gap: wide ? 40 : 25 }}>
      <View style={{ flex: 1, width: '100%', maxWidth: wide ? 610 : 800, alignItems: 'flex-start', gap: 13 }}><Text style={[styles.label, { color: palette.aqua, letterSpacing: 1.8 }]}>LESS REREADING · MORE RECALL</Text><Text style={[styles.title, { fontSize: wide ? 48 : compact ? 34 : 42, lineHeight: wide ? 56 : compact ? 42 : 52 }]}>Study with a loop that sticks.</Text><Text style={[styles.body, { fontSize: 17, lineHeight: 27, maxWidth: 560 }]}>Turn notes and lecture files into focused, question-led practice.</Text></View>
      {heroTutorial}
    </View>
    {materialsSection}
  </View>;

  const lockInScreen = <View style={[styles.content, { width: '100%', maxWidth: 1120, alignSelf: 'center', alignItems: 'center' }]}>
    <View style={{ width: '100%', maxWidth: 760, alignItems: 'center', gap: 8 }}><Text style={[styles.label, { color: '#8fcba6', textAlign: 'center' }]}>REVIEW</Text><Text style={[styles.title, { marginTop: 2, textAlign: 'center' }]}>Choose a session style</Text></View>
    <View style={[styles.row, { width: '100%', justifyContent: 'center' }]}>{paceOptions.map((option) => { const active = selectedPace === option.id; return <Pressable key={option.id} onPress={() => setSelectedPace(option.id)} accessibilityRole="button" accessibilityState={{ selected: active }} testID="torch-block" style={[styles.card, { flex: compact ? undefined : 1, flexBasis: compact ? '100%' : width <= 900 ? '48%' : undefined, minWidth: compact ? 0 : 240, maxWidth: compact ? '100%' : width <= 900 ? '48%' : 360, minHeight: compact ? 190 : 220, gap: 13, borderColor: active ? 'rgba(90,210,141,0.55)' : palette.line, backgroundColor: active ? 'rgba(24,70,44,0.78)' : 'rgba(17,31,26,0.70)', padding: compact ? 18 : 20 }]}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={{ fontSize: 22, color: active ? '#9ff0ba' : palette.yellow }}>{option.icon}</Text><Text style={{ color: active ? '#d9ffe2' : palette.muted, fontSize: 11, fontWeight: '800' }}>{option.time.toUpperCase()}</Text></View><Text style={{ color: palette.ink, fontSize: 22, fontWeight: '800' }}>{option.title}</Text><Text style={[styles.body, { flex: 1 }]}>{option.description}</Text></Pressable>; })}</View>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap', marginTop: 2 }}><ActionButton label={hasStudyContent ? `Start ${selectedOption.time} ${selectedOption.title.toLowerCase()} session →` : 'Add materials to begin →'} onPress={() => hasStudyContent ? startStudy(selectedPace) : setPage('import')} /><Pressable onPress={() => setPage('import')} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}><Text style={{ color: '#b9c5c0', fontWeight: '700' }}>{hasStudyContent ? 'Choose materials' : 'Open Materials'}</Text></Pressable></View>
  </View>;

  const importScreen = <View style={styles.content}>
    <View><Text style={styles.label}>{folderOpen ? 'SUBJECT FOLDER' : 'YOUR MATERIALS'}</Text><Text style={[styles.title, { marginTop: 7 }]}>{folderOpen && activeSubject ? activeSubject.name : 'My materials'}</Text>{!folderOpen && <Text style={[styles.body, { marginTop: 7, maxWidth: 760 }]}>Create a folder for each subject.</Text>}</View>

    {!folderOpen ? <View style={{ gap: 16 }}>
      <View testID="torch-block" style={[styles.card, { gap: 14 }]}>
        <View><Text style={{ color: palette.ink, fontSize: 19, fontWeight: '800' }}>Create a subject folder</Text></View>
        <View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}><TextInput value={newSubjectName} onChangeText={setNewSubjectName} placeholder="e.g. Physics" placeholderTextColor="#9ba6ad" accessibilityLabel="New subject folder name" style={[styles.input, { minHeight: 45, flex: 1, minWidth: 210 }]} onSubmitEditing={createSubject} /><ActionButton label="Create folder" onPress={createSubject} /></View>
      </View>
      {!!subjects.length && <View style={{ gap: 12 }}><Text style={styles.label}>FOLDERS · {subjects.length}</Text><View style={styles.row}>{subjects.map((subject) => <Pressable key={subject.id} accessibilityRole="button" accessibilityLabel={`Open ${subject.name} folder`} onPress={() => openSubject(subject.id)} testID="torch-block" style={[styles.card, { flex: 1, minWidth: 220, maxWidth: 330, minHeight: 144, gap: 10, padding: 17, alignItems: 'flex-start', justifyContent: 'space-between' }]}><View style={{ gap: 8 }}><View style={{ width: 31, height: 23, borderRadius: 5, backgroundColor: 'rgba(245,216,94,0.18)', borderWidth: 1, borderColor: 'rgba(245,216,94,0.38)', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.yellow, fontSize: 12, fontWeight: '900' }}>▰</Text></View><Text style={{ color: palette.ink, fontSize: 17, fontWeight: '800' }}>{subject.name}</Text><Text style={styles.small}>{subject.files.length} {subject.files.length === 1 ? 'file' : 'files'}</Text></View><Text style={{ color: '#9fe1b5', fontSize: 12, fontWeight: '800' }}>Open folder →</Text></Pressable>)}</View></View>}
    </View> : activeSubject ? <View style={{ gap: 16 }}>
      <Pressable onPress={() => { setFolderOpen(false); setConfirmClear(false); }} style={{ alignSelf: 'flex-start', paddingVertical: 5, paddingRight: 10 }}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>← All subject folders</Text></Pressable>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, borderBottomWidth: 1, borderColor: palette.line, paddingBottom: 10 }}>
        {([['sources', 'Sources'], ['add', 'Add'], ['summary', 'AI Studio']] as const).map(([id, label]) => <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: materialsTab === id }} onPress={() => setMaterialsTab(id)} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 20, backgroundColor: materialsTab === id ? 'rgba(33,129,91,0.35)' : 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: materialsTab === id ? 'rgba(90,210,141,0.35)' : 'transparent' }}><Text style={{ color: materialsTab === id ? '#eaffef' : '#b9c5c0', fontWeight: '800' }}>{label}</Text></Pressable>)}
      </View>
      {materialsTab === 'add' ? <View style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{([['notes', 'Subject notes'], ['questions', 'Questions already asked']] as const).map(([id, label]) => <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: addTab === id }} onPress={() => setAddTab(id)} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 18, backgroundColor: addTab === id ? 'rgba(33,129,91,0.3)' : 'rgba(255,255,255,0.04)' }}><Text style={{ color: addTab === id ? '#eaffef' : palette.muted, fontWeight: '700' }}>{label}</Text></Pressable>)}</View>
      {addTab === 'notes' ? <View testID="torch-block" style={[styles.card, { gap: 12 }]}><View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><Text style={{ fontSize: 18, color: palette.ink, fontWeight: '800' }}>Subject notes</Text><ActionButton compact secondary label="Upload PDF / DOCX / PPT / PPTX" onPress={() => importFile('module')} /></View><TextInput value={notes} onChangeText={(value) => { setNotes(value); setDemoMaterial(false); }} multiline placeholder="Paste or write notes for this subject…" placeholderTextColor="#9ba6ad" style={[styles.input, { minHeight: 220 }]} /></View> : <View testID="torch-block" style={[styles.card, { gap: 12 }]}><View style={{ flexDirection: compact ? 'column' : 'row', flexWrap: 'wrap', alignItems: compact ? 'stretch' : 'center', justifyContent: 'space-between', gap: 10 }}><Text style={{ fontSize: 18, color: palette.ink, fontWeight: '800' }}>Questions already asked</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><ActionButton compact secondary disabled={busy} label={busy ? 'Importing…' : 'Import quiz / Q&A'} onPress={() => void importQuizResults()} /><ActionButton compact secondary disabled={busy} label="Upload question file" onPress={() => importFile('questions')} /></View></View><Text style={styles.small}>Q&A files become answer cards. Files with options and an answer key stay multiple choice.</Text>{!!importedFlashcards.length && <Text style={styles.small}>{importedFlashcards.length} answer cards saved</Text>}{!!importedMultipleChoice.length && <Text style={styles.small}>{importedMultipleChoice.length} multiple-choice questions saved</Text>}<TextInput value={questionsText} onChangeText={(value) => { setQuestionsText(value); setDemoMaterial(false); }} multiline placeholder="Add one question per line…" placeholderTextColor="#9ba6ad" style={[styles.input, { minHeight: 220 }]} /><ActionButton compact secondary disabled={aiBusy} label={aiBusy ? 'Writing questions…' : 'Draft practice questions with AI'} onPress={() => void generateQuestions()} /></View>}
      </View> : materialsTab === 'summary' ? <View style={{ gap: 14 }}><StudySetStudio subjectName={activeSubject.name} materialCount={aiSelectedSourceCount} materialText={selectedAiMaterialText} sourceHash={aiStudySourceHash} questions={questionList} apiKeyConnected={!!apiKey} providerName={apiKey ? connectedProviderName : aiProviderName} studySet={activeSubject.aiStudySet} onConnectKey={() => setShowApiKeyModal(true)} onGenerate={generateStudySet} onSave={(studySet) => setSubjects((previous) => previous.map((subject) => subject.id === activeSubject.id ? { ...subject, aiStudySet: studySet } : subject))} /><View style={[styles.card, { gap: 11 }]}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}><View><Text style={styles.label}>AI SUMMARY</Text><Text style={{ color: palette.ink, fontSize: 17, fontWeight: '800', marginTop: 4 }}>Key ideas and terms</Text></View><ActionButton compact secondary disabled={aiBusy || selectedAiMaterialText.trim().length < 40} label={aiBusy ? 'Working…' : aiSummary?.subjectId === activeSubject.id && aiSummary.sourceHash === aiSourceHash ? 'Refresh' : apiKey ? 'Generate' : 'Connect AI'} onPress={() => void generateSummary()} /></View>{aiSummary?.subjectId === activeSubject.id && aiSummary.sourceHash === aiSourceHash ? <><Text style={{ color: '#d9e3de', fontSize: 14, lineHeight: 21 }}>{aiSummary.result.summary}</Text>{!!aiSummary.result.keyPoints.length && <View style={{ gap: 6 }}>{aiSummary.result.keyPoints.map((point, index) => <Text key={`${index}-${point}`} style={[styles.body, { color: '#d9e3de' }]}>• {point}</Text>)}</View>}{!!aiSummary.result.vocabulary.length && <View style={{ gap: 5 }}>{aiSummary.result.vocabulary.map(({ term, definition }) => <Text key={term} style={styles.small}><Text style={{ color: palette.ink, fontWeight: '800' }}>{term}: </Text>{definition}</Text>)}</View>}</> : <Text style={styles.small}>Generated from the sources currently selected above.</Text>}</View></View> : <View style={{ gap: 15 }}>
        <View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', justifyContent: 'space-between', gap: 8 }}><Text style={styles.body}>{sourceFiles.length ? `${sourceFiles.length} source${sourceFiles.length === 1 ? '' : 's'}` : 'Add lecture files, then choose which to study.'}</Text><ActionButton label={busy ? 'Reading files…' : 'Add source files'} onPress={() => importFile('module')} /></View>
        {!!notes.trim() && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedSourceIds.includes('__notes__') }} onPress={() => toggleStudySource('__notes__')} testID="torch-block" style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderColor: selectedSourceIds.includes('__notes__') ? 'rgba(90,210,141,0.55)' : palette.line }]}><View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: selectedSourceIds.includes('__notes__') ? '#7fd79a' : palette.line, backgroundColor: selectedSourceIds.includes('__notes__') ? '#21815b' : 'transparent', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontWeight: '900' }}>{selectedSourceIds.includes('__notes__') ? '✓' : ''}</Text></View><View style={{ flex: 1 }}><Text style={{ color: palette.ink, fontWeight: '800' }}>Subject notes</Text></View><Pressable accessibilityRole="button" onPress={(event) => { event.stopPropagation(); setAddTab('notes'); setMaterialsTab('add'); }}><Text style={{ color: '#9fe1b5', fontWeight: '800', padding: 8 }}>Edit</Text></Pressable></Pressable>}
        {!!sourceFiles.length && <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><Text style={styles.label}>SOURCES · {sourceFiles.length}</Text><Pressable accessibilityRole="button" onPress={selectAllSourceFiles} style={{ minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 }}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>{sourceFiles.every((file) => selectedSourceIds.includes(file.id)) ? 'Clear file selection' : 'Select all files'}</Text></Pressable></View>
          {sourceFiles.map((file, index) => <View key={file.id} style={[styles.card, { flexDirection: compact ? 'column' : 'row', flexWrap: 'wrap', alignItems: compact ? 'stretch' : 'center', gap: 10, padding: compact ? 13 : 15 }]}>
            <View style={{ flex: 1, minWidth: compact ? 0 : 220, flexDirection: 'row', alignItems: 'center', gap: 10 }}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedSourceIds.includes(file.id) }} accessibilityLabel={`Select ${file.name} for study`} onPress={() => toggleStudySource(file.id)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: selectedSourceIds.includes(file.id) ? '#7fd79a' : palette.line, backgroundColor: selectedSourceIds.includes(file.id) ? '#21815b' : 'transparent', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontWeight: '900' }}>{selectedSourceIds.includes(file.id) ? '✓' : ''}</Text></View></Pressable><View style={{ flex: 1, minWidth: 0 }}><Text style={styles.label}>MATERIAL {index + 1} OF {sourceFiles.length}</Text><Text numberOfLines={2} style={{ color: palette.ink, fontWeight: '800', fontSize: 15 }}>{file.name}</Text><Text style={styles.small}>{selectedSourceIds.includes(file.id) ? 'Selected for study' : 'Not selected'} · {file.name.match(/\.pdf$/i) ? `${fileSegments(file).length} pages` : file.name.match(/\.pptx?$/i) ? `${fileSegments(file).length} slides` : `${file.text.trim().split(/\s+/).filter(Boolean).length} words`}</Text></View></View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}><Pressable accessibilityRole="button" accessibilityLabel={`Move ${file.name} earlier`} disabled={index === 0} onPress={() => moveSourceFile(file.id, -1)} style={{ minWidth: 42, minHeight: 42, alignItems: 'center', justifyContent: 'center', opacity: index === 0 ? 0.4 : 1 }}><Text style={{ color: '#b8e8c7', fontWeight: '800' }}>↑</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Move ${file.name} later`} disabled={index === sourceFiles.length - 1} onPress={() => moveSourceFile(file.id, 1)} style={{ minWidth: 42, minHeight: 42, alignItems: 'center', justifyContent: 'center', opacity: index === sourceFiles.length - 1 ? 0.4 : 1 }}><Text style={{ color: '#b8e8c7', fontWeight: '800' }}>↓</Text></Pressable><ActionButton compact secondary label="Preview" onPress={() => openSourceViewer(file)} /><ActionButton compact secondary label="Delete" onPress={() => removeSubjectFile(file.id)} /></View>
          </View>)}
        </View>}
        {activeSubject.files.filter((file) => file.role === 'questions').map((file) => <View key={file.id} style={[styles.card, { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 15 }]}><View style={{ flex: 1, minWidth: 180 }}><Text style={{ color: palette.ink, fontWeight: '800' }}>{file.name}</Text><Text style={styles.small}>Question file · {file.text.trim().split(/\s+/).length} words</Text></View><ActionButton compact secondary label="Load questions" onPress={() => activateSubjectFile(file)} /><Pressable accessibilityRole="button" accessibilityLabel={`Delete ${file.name}`} onPress={() => removeSubjectFile(file.id)} style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }}><Text style={{ color: palette.muted, fontWeight: '700' }}>Delete</Text></Pressable></View>)}
        {!notes.trim() && !activeSubject.files.some((file) => file.role === 'source' || file.role === 'questions') && <View style={[styles.card, { alignItems: 'center', paddingVertical: 35, gap: 8 }]}><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>No sources yet</Text><Text style={[styles.body, { textAlign: 'center' }]}>Upload lecture material or add subject notes to get started.</Text></View>}
        {(!!notes.trim() || activeSubject.files.some((file) => file.role === 'source') || !!allFlashcards.length || !!importedMultipleChoice.length) && <View testID="torch-block" style={[styles.card, { gap: 12 }]}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}><View><Text style={styles.label}>{notes.trim() || sourceFiles.length ? 'STUDY SOURCES' : 'QUESTION BANK'}</Text><Text style={{ color: palette.ink, fontSize: 19, fontWeight: '800', marginTop: 4 }}>{notes.trim() || sourceFiles.length ? 'Study selected sources' : `${allFlashcards.length} cards · ${importedMultipleChoice.length} quiz questions`}</Text></View>{(notes.trim() || sourceFiles.length > 0) && <Pressable accessibilityRole="button" onPress={selectAllStudySources} style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>{selectedSourceIds.length === (activeSubject.files.filter((file) => file.role === 'source').length + (notes.trim() ? 1 : 0)) ? 'Clear selection' : 'Select all sources'}</Text></Pressable>}</View>
          {!!selectedSourceIds.length && <Text style={styles.small}>{selectedSourceIds.length} selected</Text>}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton label="Flashcard review" disabled={!selectedSourceIds.length && !allFlashcards.length} onPress={() => beginStudyFormat('flashcards')} /><ActionButton secondary label="Q&A practice" disabled={!selectedSourceIds.length && !questionList.length} onPress={() => beginStudyFormat('qa')} /><ActionButton secondary label="Read sources" disabled={!selectedSourceIds.length} onPress={() => beginStudyFormat('read')} />{!!selectedRagSources.length && <ActionButton compact secondary disabled={ragBusy} label={ragBusy ? 'Preparing…' : 'Prepare source lookup'} onPress={() => { if (!apiKey) { setShowApiKeyModal(true); return; } setRagBusy(true); void indexSelectedSources().then((records) => notify(`Source lookup ready · ${records.length} passages indexed.`)).catch((error) => notify(error instanceof Error ? error.message : 'Could not prepare source lookup.')).finally(() => { setRagBusy(false); setRagProgress(''); }); }} />}</View>
          {!!ragProgress && <Text style={styles.small}>{ragProgress}</Text>}
        </View>}
        {!!questionList.length && <View style={{ gap: 9 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}><Pressable accessibilityRole="button" accessibilityState={{ expanded: showMatchReview }} onPress={() => { if (!matches.length) matchQuestions(); else setShowMatchReview((open) => !open); }} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 8 }}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>Question-to-source review</Text><Text style={styles.small}>{matches.length || questionList.length} questions</Text><Text style={{ color: palette.muted }}>{showMatchReview ? '⌃' : '⌄'}</Text></Pressable><ActionButton compact secondary label="Refresh matches" onPress={matchQuestions} /></View>
          {showMatchReview && !!matches.length && <View style={[styles.card, { gap: 10, padding: compact ? 13 : 18 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><View><Text style={styles.label}>SUGGESTED LINKS</Text><Text style={{ color: palette.ink, fontSize: 17, fontWeight: '800', marginTop: 3 }}>Check each source before studying</Text></View><Text style={styles.small}>{matches.filter((match) => match.overlap > 0 || match.manual).length} linked · {matches.filter((match) => !match.overlap && !match.manual).length} need review</Text></View>
            {matches.map((match, index) => { const expanded = expandedMatchIndex === index; const status = match.manual ? (match.passageIndex ? 'Manual link' : 'Needs review') : match.overlap ? `Suggested · ${match.overlap} shared terms` : 'Needs review'; const sourceFile = findMatchSourceFile(match); return <View key={`${index}-${match.question}`} style={{ borderWidth: 1, borderColor: expanded ? 'rgba(90,210,141,0.34)' : palette.line, borderRadius: 12, padding: 12, gap: 8, backgroundColor: expanded ? 'rgba(18,43,30,0.58)' : 'rgba(5,14,11,0.22)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}><View style={{ width: 25, height: 25, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(245,216,94,0.13)' }}><Text style={{ color: palette.yellow, fontSize: 11, fontWeight: '900' }}>{index + 1}</Text></View><View style={{ flex: 1, minWidth: 0, gap: 5 }}><Text numberOfLines={expanded ? undefined : 2} style={{ color: palette.ink, fontWeight: '700', fontSize: 14, lineHeight: 20 }}>{match.question}</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 }}><Text style={{ color: match.overlap || match.manual ? '#a9e6ba' : '#ffe49a', fontSize: 11, fontWeight: '800' }}>{status}</Text><Text style={styles.small}>· {match.sourceLabel || 'No source selected'}</Text></View></View></View>
              {expanded && <><View style={{ borderRadius: 9, padding: 10, backgroundColor: 'rgba(255,255,255,0.035)' }}><Text numberOfLines={5} style={{ color: palette.ink, fontSize: 13, lineHeight: 20 }}>{match.passage}</Text></View><View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>{sourceFile && <ActionButton compact secondary label="Open source" onPress={() => void openSourceLocation(match)} />}{sourceOptions.length > 0 && <><ActionButton compact secondary label="Previous passage" onPress={() => stepMatchSource(match.question, -1)} /><ActionButton compact secondary label="Next passage" onPress={() => stepMatchSource(match.question, 1)} /></>}{(match.passageIndex !== null || match.manual) && <Pressable accessibilityRole="button" onPress={() => clearMatchSource(match.question)} style={{ minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 }}><Text style={{ color: palette.muted, fontWeight: '700', fontSize: 12 }}>Clear link</Text></Pressable>}</View></>}
              <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpandedMatchIndex(expanded ? null : index)} style={{ minHeight: 36, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: 10 }}><Text style={{ color: '#9fe1b5', fontWeight: '800', fontSize: 12 }}>{expanded ? 'Hide passage' : 'View suggested passage'}</Text></Pressable>
            </View>; })}
          </View>}
        </View>}
      </View>}
    </View> : null}
  </View>;

  const activeOverview = aiSummary?.subjectId === (activeSubjectId || '') && aiSummary.sourceHash === aiSourceHash ? aiSummary.result : null;
  const overviewPanel = <View style={[styles.card, { gap: 16 }]}>
    <View><Text style={styles.label}>AI MODULE OVERVIEW</Text><Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800', marginTop: 5 }}>Your module, at a glance</Text><Text style={[styles.small, { marginTop: 4 }]}>{displayModuleTitle}</Text></View>
    {activeOverview ? <><Text style={[styles.body, { color: '#e0ebe4' }]}>{activeOverview.summary}</Text>{!!activeOverview.keyPoints.length && <View style={{ gap: 7 }}><Text style={styles.label}>KEY IDEAS</Text>{activeOverview.keyPoints.map((point, index) => <Text key={`${index}-${point}`} style={[styles.body, { color: '#d7e2dc' }]}>• {point}</Text>)}</View>}{!!activeOverview.vocabulary.length && <View style={{ gap: 6 }}><Text style={styles.label}>IMPORTANT TERMS</Text>{activeOverview.vocabulary.slice(0, 4).map(({ term, definition }) => <Text key={term} style={styles.small}><Text style={{ color: palette.ink, fontWeight: '800' }}>{term}: </Text>{definition}</Text>)}</View>}</> : <View style={{ gap: 8, borderRadius: 12, padding: 13, borderWidth: 1, borderColor: palette.line, backgroundColor: 'rgba(255,255,255,0.035)' }}><Text style={[styles.body, { color: '#d7e2dc' }]}>{aiBusy ? 'Reading your selected sources and preparing an overview…' : apiKey ? 'Generate a concise overview from the selected material.' : 'Connect your AI key to get a source-grounded overview.'}</Text>{!aiBusy && <ActionButton compact secondary label={apiKey ? 'Generate overview' : `Connect ${aiProviderName}`} onPress={() => void generateSummary()} />}</View>}
    {!!questionList.length && <View style={{ gap: 7, borderTopWidth: 1, borderColor: palette.line, paddingTop: 12 }}><Text style={styles.label}>{questionList.length} PROVIDED QUESTION{questionList.length === 1 ? '' : 'S'}</Text>{questionList.slice(0, 3).map((question, index) => <Text key={`${index}-${question}`} numberOfLines={2} style={styles.small}>{index + 1}. {question}</Text>)}{questionList.length > 3 && <Text style={styles.small}>+ {questionList.length - 3} more</Text>}</View>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9, borderTopWidth: 1, borderColor: palette.line, paddingTop: 12 }}>
      {studyFormat === 'flashcards' ? <ActionButton label="Start flashcards →" disabled={aiBusy} onPress={() => { setQuestionIndex(0); setFlashcardRevealed(false); setPhase('diagnostic'); }} /> : questionList.length ? <ActionButton label="Start diagnostic →" disabled={aiBusy} onPress={startDiagnostic} /> : <ActionButton label="Read the module →" disabled={aiBusy} onPress={startModuleReading} />}
      {studyFormat === 'flashcards' && questionList.length > 0 && <ActionButton secondary label="Start with the questions" disabled={aiBusy} onPress={startDiagnostic} />}
      {studyFormat !== 'flashcards' && questionList.length > 0 && <ActionButton secondary label="Read module first" disabled={aiBusy} onPress={startModuleReading} />}
      {studyFormat !== 'flashcards' && !questionList.length && <ActionButton secondary label={aiBusy ? 'Preparing quiz…' : 'Take quiz now'} disabled={aiBusy} onPress={() => void startQuiz()} />}
      {questionList.length > 0 && studyFormat !== 'flashcards' && <ActionButton secondary label="Skip to reading" disabled={aiBusy} onPress={startModuleReading} />}
    </View>
  </View>;
  const phaseStep = phase === 'overview' ? 1 : phase === 'diagnostic' ? 2 : phase === 'module' ? 3 : phase === 'review' ? 3 : 4;
  const phaseTotal = 4;
  const phaseDescription = phase === 'overview' ? 'get the big picture' : phase === 'module' ? 'review question-linked material' : phase === 'diagnostic' ? `question ${questionIndex + 1} · first recall` : phase === 'review' ? 'revisit the linked source' : `question ${questionIndex + 1} · quiz`;
  const studyScreen = <View style={styles.content}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}><View><Text style={styles.label}>{mode.toUpperCase()} MODE · {displayModuleTitle.toUpperCase()}</Text><Text style={[styles.title, { marginTop: 7 }]}>{phase === 'overview' ? 'Start with the big picture' : phase === 'module' ? 'Review the module' : phase === 'diagnostic' ? 'Quick diagnostic' : phase === 'review' ? 'Review this part' : 'Take the quiz'}</Text></View><ActionButton label="Exit session" secondary onPress={() => setPage('home')} /></View>
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>{Array.from({ length: phaseTotal }, (_, index) => <View key={index} style={{ height: 6, flex: 1, backgroundColor: index < phaseStep ? (index + 1 === phaseStep ? palette.yellow : palette.green) : palette.line, borderRadius: 5 }} />)}<Text style={styles.small}>{phaseStep} of {phaseTotal} · {phaseDescription}</Text></View>
    {phase === 'overview' ? overviewPanel : phase === 'review' ? reviewPanel : phase === 'flashcardsDone' ? flashcardsDonePanel : phase === 'module' && studyFormat === 'read' ? <View style={{ gap: 14 }}>{selectedSourceIds.includes('__notes__') && !!notes.trim() && <View testID="torch-block" style={[styles.card, { gap: 8 }]}><Text style={styles.label}>SUBJECT NOTES</Text><Text style={{ color: palette.ink, fontSize: 15, lineHeight: 25 }}>{notes}</Text></View>}{selectedStudyFiles.map((file, fileIndex) => fileIndex === readMaterialIndex ? <View key={file.id} testID="torch-block" style={[styles.card, { gap: 10 }]}><View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', justifyContent: 'space-between', gap: 8 }}><View><Text style={styles.label}>MATERIAL {fileIndex + 1} OF {selectedStudyFiles.length}</Text><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800', marginTop: 3 }}>{file.name}</Text></View><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}><ActionButton compact secondary disabled={fileIndex <= 0} label="← Previous material" onPress={() => navigateReadMaterial(-1)} /><ActionButton compact secondary disabled={fileIndex >= selectedStudyFiles.length - 1} label="Next material →" onPress={() => navigateReadMaterial(1)} /></View></View>{lecturePreview(file, undefined, true)}<View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}><Pressable accessibilityRole="button" accessibilityState={{ expanded: showExtractedText }} onPress={() => setShowExtractedText((shown) => !shown)} style={{ minHeight: 40, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 7 }}><Text style={{ color: '#b8e8c7', fontWeight: '800' }}>{showExtractedText ? 'Hide extracted text' : 'View extracted text'}</Text></Pressable><ActionButton compact label="Take quiz now →" onPress={() => void startQuiz()} /></View>{showExtractedText && <Text style={{ color: palette.ink, fontSize: 14, lineHeight: 23 }}>{file.text || 'No selectable text was found.'}</Text>}</View> : null)}{!selectedStudyFiles.length && <ActionButton label="Take quiz now →" onPress={() => void startQuiz()} />}</View> : studyFormat === 'flashcards' ? <View style={{ gap: 14 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={flashcardRevealed ? 'Flashcard answer. Tap to show the question.' : 'Flashcard question. Tap to reveal the answer.'}
        accessibilityState={{ expanded: flashcardRevealed }}
        onPress={() => {
          if (!flashcardRevealed) setSourceCheckPageIndex(Math.max(0, flashcardPageFromMatch));
          setFlashcardRevealed((revealed) => !revealed);
        }}
        style={{ height: compact ? 300 : 340, position: 'relative' }}
      >
        <Animated.View
          testID="torch-block"
          style={[
            styles.card,
            {
              position: 'absolute', inset: 0, justifyContent: 'center', gap: 16,
              backfaceVisibility: 'hidden', opacity: flashcardFrontOpacity,
              transform: [{ perspective: 1000 }, { rotateY: flashcardFrontRotation }],
              borderColor: 'rgba(184,232,199,0.32)',
              backgroundColor: 'rgba(17,39,31,0.94)',
            },
          ]}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <Text style={styles.label}>{currentFlashcardRating === 'known' ? 'KNOWN' : currentFlashcardRating === 'unknown' ? 'REVISIT' : 'QUESTION'}</Text>
            <Text style={styles.small}>{questionIndex + 1} / {Math.max(1, flashcardDeck.length)}</Text>
          </View>
          <Text style={{ color: palette.ink, fontSize: compact ? 22 : 28, lineHeight: compact ? 31 : 38, fontWeight: '800' }}>
            {currentFlashcardCard?.front || 'What is the most important idea in this source?'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <Text style={{ color: '#b8e8c7', fontWeight: '800' }}>↻</Text>
            <Text style={styles.small}>Tap card to reveal answer</Text>
          </View>
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.card,
            {
              position: 'absolute', inset: 0, justifyContent: 'center', gap: 14,
              backfaceVisibility: 'hidden', opacity: flashcardBackOpacity,
              transform: [{ perspective: 1000 }, { rotateY: flashcardBackRotation }],
              borderColor: 'rgba(245,216,94,0.34)',
              backgroundColor: 'rgba(37,39,21,0.96)',
            },
          ]}
        >
          <Text style={styles.label}>{currentFlashcardCard?.back ? 'ANSWER' : 'THINK IT THROUGH'}</Text>
          <Text style={{ color: palette.ink, fontSize: compact ? 18 : 22, lineHeight: compact ? 27 : 32, fontWeight: '700' }}>
            {currentFlashcardCard?.back || flashcardEvidence || 'Review the selected source and write the answer in your own words.'}
          </Text>
          {(currentFlashcardCard?.source || currentFlashcardMatch?.sourceLabel) && (
            <Text style={[styles.small, { marginTop: 6 }]}>
              {currentFlashcardCard?.source || currentFlashcardMatch?.sourceLabel}
            </Text>
          )}
          <Text style={[styles.small, { marginTop: 8 }]}>Tap card to show question</Text>
        </Animated.View>
      </Pressable>
      {flashcardRevealed && (currentFlashcardFile || flashcardEvidence) && (
        <View testID="torch-block" style={[styles.card, { gap: 12, borderColor: 'rgba(245,216,94,0.3)' }]}>
          <View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', justifyContent: 'space-between', gap: 6 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{currentFlashcardFile && /\.(?:pdf|pptx?)$/i.test(currentFlashcardFile.name) ? 'SOURCE PAGE' : 'SOURCE CONTEXT'}</Text>
              <Text numberOfLines={1} style={{ color: palette.ink, fontWeight: '800', marginTop: 3 }}>
                {currentFlashcardFile?.name || currentFlashcardMatch?.sourceLabel || 'Selected study material'}
              </Text>
            </View>
            {currentFlashcardMatch?.sourceLabel && <Text style={styles.small}>{currentFlashcardMatch.sourceLabel.split(' · ').slice(-1)[0]}</Text>}
          </View>
          {currentFlashcardFile && /\.(?:pdf|pptx?)$/i.test(currentFlashcardFile.name) && (
            <>
              <RenderedPagePreview fileId={currentFlashcardFile.id} fileName={currentFlashcardFile.name} pageIndex={sourceCheckPageIndex} highlightPhrases={[flashcardEvidence]} fallbackText={flashcardPageSegment?.text || flashcardEvidence} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <ActionButton compact secondary disabled={sourceCheckPageIndex <= 0} label="← Page" onPress={() => setSourceCheckPageIndex((index) => Math.max(0, index - 1))} />
                <Text style={styles.small}>Page {sourceCheckPageIndex + 1} of {flashcardPageCount} · ← / →</Text>
                <ActionButton compact secondary disabled={sourceCheckPageIndex >= flashcardPageCount - 1} label="Page →" onPress={() => setSourceCheckPageIndex((index) => Math.min(flashcardPageCount - 1, index + 1))} />
              </View>
            </>
          )}
          {!!flashcardEvidence && (
            <View style={{ borderLeftWidth: 3, borderColor: palette.yellow, paddingLeft: 10, paddingVertical: 4 }}>
              <Text style={styles.label}>RELEVANT CONTEXT</Text>
              <Text style={{ color: palette.ink, fontSize: 14, lineHeight: 21, marginTop: 4 }}>{flashcardEvidence}</Text>
            </View>
          )}
        </View>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>
        <ActionButton compact secondary disabled={questionIndex <= 0} label="← Previous" onPress={() => navigateFlashcard(-1)} />
        {!flashcardRevealed && <ActionButton label="Reveal answer" onPress={() => { setSourceCheckPageIndex(Math.max(0, flashcardPageFromMatch)); setFlashcardRevealed(true); }} />}
        {flashcardRevealed && <>
          <ActionButton compact secondary label={ragBusy ? 'Searching…' : 'Find in sources'} disabled={ragBusy} onPress={() => void findFlashcardSource()} />
          <ActionButton compact secondary label="I don’t know" onPress={() => rateFlashcard('unknown')} />
          <ActionButton compact label="Know" onPress={() => rateFlashcard('known')} />
        </>}
      </View>
    </View> : phase === 'module' ? reviewPanel : quizPanel}
  </View>;

  const readyCount = history.filter((attempt) => attempt.outcome === 'correct' || attempt.outcome === 'self-rated-ready').length;
  const reviewCount = history.filter((attempt) => attempt.outcome === 'missed' || attempt.outcome === 'needs-review').length;
  const insightsScreen = <View style={styles.content}>
    <View style={styles.row}>{[
      { label: 'ATTEMPTS', value: String(attempted), tone: palette.blueSoft },
      { label: 'READY', value: String(readyCount), tone: palette.greenSoft },
      { label: 'REVIEW', value: String(reviewCount), tone: palette.yellowSoft },
    ].map((card) => <View key={card.label} testID="torch-block" style={[styles.card, { flex: 1, minWidth: 150, gap: 7 }]}><Text style={styles.label}>{card.label}</Text><Text style={{ color: palette.ink, fontSize: 36, fontWeight: '900' }}>{card.value}</Text><View style={{ height: 5, backgroundColor: card.tone, borderRadius: 4, marginTop: 5 }} /></View>)}</View>
    <View testID="torch-block" style={[styles.card, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }]}><Text style={{ color: palette.ink, fontSize: 17, fontWeight: '800' }}>{reviewCount ? `${reviewCount} question${reviewCount === 1 ? '' : 's'} to revisit` : hasStudyContent ? 'Ready for another session' : 'Add study materials'}</Text><ActionButton label={hasStudyContent ? 'Choose study mode' : 'Add materials'} onPress={() => setPage(hasStudyContent ? 'modes' : 'import')} /></View>
    {!!history.length && <View testID="torch-block" style={[styles.card, { gap: 10 }]}><Text style={styles.label}>RECENT ANSWERS</Text>{history.slice(0, 8).map((attempt) => { const positive = attempt.outcome === 'correct' || attempt.outcome === 'self-rated-ready'; const status = attempt.outcome === 'correct' ? 'Correct' : attempt.outcome === 'missed' ? 'Review' : attempt.outcome === 'self-rated-ready' ? 'Ready' : 'Needs review'; return <View key={attempt.id} style={{ borderTopWidth: 1, borderColor: palette.line, paddingTop: 10, gap: 4 }}><Text numberOfLines={2} style={{ color: palette.ink, fontSize: 13, fontWeight: '700' }}>{attempt.question}</Text><Text style={[styles.small, { color: positive ? '#9fe1b5' : '#ffe49a' }]}>{status} · {attempt.mode}</Text></View>; })}</View>}
    <View testID="torch-block" style={[styles.card, { gap: 10 }]}><Text style={styles.label}>BACKUP</Text><View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap' }}><ActionButton compact label={backupBusy ? 'Preparing…' : 'Download backup'} onPress={() => void exportWorkspaceBackup()} /><ActionButton compact secondary label="Restore backup" onPress={() => setConfirmRestoreBackup(true)} /></View>{confirmRestoreBackup && <View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(245,216,94,0.4)', borderRadius: 12, padding: 12, backgroundColor: 'rgba(245,216,94,0.06)' }}><Text style={[styles.small, { flex: 1, minWidth: 220, color: '#fff2ad' }]}>Restoring replaces this workspace. Select a Recall Loop backup ZIP.</Text><ActionButton compact secondary label="Cancel" onPress={() => setConfirmRestoreBackup(false)} /><ActionButton compact label="Choose file" onPress={() => void restoreWorkspaceBackup()} /></View>}</View>
    <View testID="torch-block" style={[styles.card, { gap: 10 }]}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><Text style={styles.label}>WORKSPACE</Text><ActionButton compact secondary label="Clear workspace…" onPress={() => setConfirmClear(true)} /></View>{confirmClear && <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: 'rgba(245,216,94,0.4)', borderRadius: 13, padding: 13, backgroundColor: 'rgba(245,216,94,0.06)' }}><Text style={[styles.small, { flex: 1, minWidth: 180, color: '#fff2ad' }]}>Clear all saved data?</Text><ActionButton compact secondary label="Cancel" onPress={() => setConfirmClear(false)} /><ActionButton compact label="Clear everything" onPress={() => { clearWorkspace(); setConfirmClear(false); }} /></View>}</View>
  </View>;

  const body = page === 'import' ? importScreen : page === 'modes' ? lockInScreen : page === 'study' ? studyScreen : page === 'insights' ? insightsScreen : home;

  return <View style={styles.page}>
    <StatusBar style="light" />
    <View style={styles.shell}>
      <View style={styles.main}>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, backgroundColor: 'rgba(5,16,12,0.96)' }}><View style={[styles.inner, compact && { paddingHorizontal: 16 }]}>{fixedHeader}</View></View>
        <ScrollView ref={scrollRef} style={{ flex: 1, minWidth: 0, minHeight: 0, width: '100%' }} contentContainerStyle={{ flexGrow: 1, width: '100%', maxWidth: '100%', paddingTop: compact ? 124 : 78, paddingBottom: 48, position: 'relative' }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator nestedScrollEnabled>
          <View testID="scroll-backdrop" pointerEvents="none" style={styles.scrollBackdrop}>
            <BlurTargetView ref={ambientRef} pointerEvents="none" style={styles.ambience}><View testID="ambient-glow-a" style={styles.glowA} /><View testID="ambient-glow-b" style={styles.glowB} /><View testID="ambient-glow-c" style={styles.glowC} /></BlurTargetView>
            <BlurView pointerEvents="none" blurTarget={ambientRef} intensity={62} tint="dark" blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : 'none'} style={styles.backgroundBlur} />
          </View>
          {!!notice && <View style={[styles.inner, compact && { paddingHorizontal: 16 }]}><View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 10, padding: 12, marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(143,203,166,0.28)', backgroundColor: 'rgba(24,70,44,0.72)' }}><Text style={[styles.small, { flex: 1, color: '#dcf5e5' }]}>{notice}</Text><Pressable accessibilityRole="button" onPress={() => setNotice('')} style={{ minHeight: 40, justifyContent: 'center', alignSelf: compact ? 'flex-end' : 'auto' }}><Text style={{ color: '#b8e8c7', fontSize: 12, fontWeight: '800' }}>Dismiss</Text></Pressable></View></View>}
          <View style={[styles.inner, compact && { paddingHorizontal: 16 }]}>{body}</View>
        </ScrollView>
      </View>
    </View>
    <Modal visible={sourceViewerOpen && !!visibleSourceFile} transparent animationType="fade" onRequestClose={() => setSourceViewerOpen(false)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.82)', justifyContent: 'center', alignItems: 'center', padding: compact ? 10 : 22 }}>
        {visibleSourceFile && <View style={[styles.card, { width: '100%', maxWidth: 1120, maxHeight: '94%', gap: 12, backgroundColor: '#0b1913', borderColor: 'rgba(143,203,166,0.35)', padding: compact ? 13 : 20 }]}>
          <View style={{ flexDirection: compact ? 'column' : 'row', justifyContent: 'space-between', alignItems: compact ? 'stretch' : 'flex-start', gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9 }}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedSourceIds.includes(visibleSourceFile.id) }} accessibilityLabel={`Select ${visibleSourceFile.name} for study`} onPress={() => toggleStudySource(visibleSourceFile.id)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: selectedSourceIds.includes(visibleSourceFile.id) ? '#7fd79a' : palette.line, backgroundColor: selectedSourceIds.includes(visibleSourceFile.id) ? '#21815b' : 'transparent', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontWeight: '900' }}>{selectedSourceIds.includes(visibleSourceFile.id) ? '✓' : ''}</Text></View></Pressable><View style={{ flex: 1, minWidth: 0 }}><Text style={styles.label}>MATERIAL {visibleSourceIndex + 1} OF {sourceFiles.length} · {selectedSourceIds.includes(visibleSourceFile.id) ? 'SELECTED' : 'NOT SELECTED'}</Text><Text numberOfLines={2} style={{ color: palette.ink, fontWeight: '800', fontSize: compact ? 16 : 18 }}>{visibleSourceFile.name}</Text></View></View>
            <ActionButton compact secondary label="Close viewer" onPress={() => setSourceViewerOpen(false)} />
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderTopWidth: 1, borderColor: palette.line, paddingTop: 10 }}><ActionButton compact secondary disabled={visibleSourceIndex <= 0} label="← Previous material" onPress={() => navigateSourceFile(-1)} /><Text style={styles.small}>Selection stays as you browse</Text><ActionButton compact secondary disabled={visibleSourceIndex >= sourceFiles.length - 1} label="Next material →" onPress={() => navigateSourceFile(1)} /></View>
          <ScrollView style={{ flexShrink: 1, minHeight: 0 }} contentContainerStyle={{ gap: 10, paddingBottom: 5 }} keyboardShouldPersistTaps="handled">{lecturePreview(visibleSourceFile)}</ScrollView>
        </View>}
      </View>
    </Modal>
    <Modal visible={showApiKeyModal} transparent animationType="fade" onRequestClose={() => setShowApiKeyModal(false)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', justifyContent: 'center', alignItems: 'center', padding: compact ? 12 : 20 }}>
        <View style={[styles.card, { width: '100%', maxWidth: 520, gap: 14, backgroundColor: '#0b1913', borderColor: 'rgba(143,203,166,0.35)', padding: compact ? 16 : 22 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><Text style={styles.label}>BRING YOUR OWN KEY</Text><Text style={{ color: palette.ink, fontSize: 21, fontWeight: '800', marginTop: 4 }}>Connect {aiProviderName}</Text></View><ActionButton compact secondary label="Close" onPress={() => setShowApiKeyModal(false)} /></View>
          <Text style={styles.body}>Your key stays in this tab and is sent directly to {aiProviderName} with the selected study text. It isn’t saved by Recall Loop.</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {([['gemini', 'Google Gemini'], ['openai', 'OpenAI']] as const).map(([provider, label]) => { const locked = !!apiKey && apiKeyProvider !== provider; return <Pressable key={provider} accessibilityRole="radio" accessibilityState={{ checked: aiProvider === provider, disabled: locked }} disabled={locked} onPress={() => setAiProvider(provider)} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, borderColor: aiProvider === provider ? 'rgba(90,210,141,0.48)' : palette.line, backgroundColor: aiProvider === provider ? 'rgba(33,129,91,0.3)' : 'rgba(255,255,255,0.04)', opacity: locked ? 0.45 : 1 }}><Text style={{ color: aiProvider === provider ? palette.ink : palette.muted, fontWeight: '800' }}>{label}</Text></Pressable>; })}
          </View>
          <TextInput value={apiKeyDraft} onChangeText={setApiKeyDraft} secureTextEntry placeholder={`Paste your ${aiProviderName} API key`} placeholderTextColor="#9ba6ad" autoCapitalize="none" autoCorrect={false} textContentType="none" accessibilityLabel={`${aiProviderName} API key`} style={[styles.input, { minHeight: 48, textAlignVertical: 'center' }]} />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
            {!!apiKey && <ActionButton compact secondary label="Disconnect key" onPress={() => { setApiKey(''); setApiKeyProvider(null); setApiKeyDraft(''); setShowApiKeyModal(false); setAiSummary(null); setAiFeedback(null); }} />}
            <ActionButton compact disabled={!apiKeyDraft.trim()} label="Use for this session" onPress={() => { setApiKey(apiKeyDraft.trim()); setApiKeyProvider(aiProvider); setApiKeyDraft(''); setAiSummary(null); setAiFeedback(null); setShowApiKeyModal(false); }} />
          </View>
          <Text style={styles.small}>A browser key can be inspected by software running in this page. Use a key you control and revoke it when you’re done.</Text>
        </View>
      </View>
    </Modal>
    <Modal visible={!!sourceReader} transparent animationType="fade" onRequestClose={() => setSourceReader(null)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', justifyContent: 'center', alignItems: 'center', padding: compact ? 12 : 20 }}>
        <View style={[styles.card, { width: '100%', maxWidth: 820, maxHeight: '88%', gap: 14, backgroundColor: '#0b1913', borderColor: 'rgba(143,203,166,0.35)', padding: compact ? 16 : 22 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 5 }}><Text style={styles.label}>SOURCE READER</Text><Text style={{ color: palette.ink, fontSize: compact ? 18 : 20, fontWeight: '800', flexShrink: 1 }}>{sourceReader?.title}</Text><Text style={{ color: '#b8e8c7', fontSize: 13, fontWeight: '700', flexShrink: 1 }}>{sourceReader?.location}</Text></View>
            <ActionButton compact secondary label="Close" onPress={() => setSourceReader(null)} />
          </View>
          <ScrollView style={{ flexShrink: 1 }}><Text selectable style={{ color: palette.ink, fontSize: 15, lineHeight: 25 }}>{sourceReader?.text}</Text></ScrollView>
          <Text style={styles.small}>This view shows extracted text from the uploaded file. Check the original document if layout or diagrams matter.</Text>
        </View>
      </View>
    </Modal>
  </View>;
}

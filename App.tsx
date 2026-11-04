import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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

type Match = { question: string; passage: string; overlap: number; passageIndex: number | null; sourceLabel?: string; sourceFileId?: string; manual?: boolean };
type StudyAttempt = { id: string; question: string; mode: Pace; outcome: 'correct' | 'missed' | 'self-rated-ready' | 'needs-review'; createdAt: string };
type StudySegment = { label: string; text: string; sourceFileId?: string };
type StudyFile = { id: string; name: string; text: string; segments?: StudySegment[]; role: 'source' | 'questions' };
type OriginalDocument = { id: string; name: string; type: string; blob: Blob };
type SourceReader = { title: string; location: string; text: string };
type Subject = { id: string; name: string; notes: string; questionsText: string; files: StudyFile[] };
type SavedWorkspace = { version: 1 | 2; notes: string; questionsText: string; demoMaterial: boolean; matches: Match[]; attempted: number; correct: number; history: StudyAttempt[]; subjects: Subject[]; activeSubjectId: string | null; selectedSourceId: string | null; selectedSourceIds?: string[]; sourceScope: 'subject' | 'file' | 'notes' | 'selected' };
type Pace = 'cram' | 'steady' | 'deep';
type Phase = 'module' | 'diagnostic' | 'review' | 'check';

const storageKey = 'recall-loop.workspace.v2';
const legacyStorageKey = 'recall-loop.workspace.v1';
const originalDbName = 'recall-loop.originals.v1';

function openOriginalsDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(originalDbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('documents', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open browser file storage.'));
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
  db.close();
}

async function getOriginalDocument(id: string): Promise<OriginalDocument | null> {
  const db = await openOriginalsDatabase();
  const result = await new Promise<OriginalDocument | null>((resolve, reject) => {
    const request = db.transaction('documents').objectStore('documents').get(id);
    request.onsuccess = () => resolve((request.result as OriginalDocument | undefined) || null);
    request.onerror = () => reject(request.error || new Error('Could not read the original file.'));
  });
  db.close();
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
  db.close();
}

async function clearOriginalDocuments() {
  const db = await openOriginalsDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('documents', 'readwrite');
    transaction.objectStore('documents').clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not clear original files.'));
  });
  db.close();
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
  db.close();
}
const demoQuiz = [
  { question: 'Where does glycolysis take place, and what is its net ATP yield?', options: ['In the cytoplasm; net gain of 2 ATP', 'In the mitochondrial matrix; net gain of 30 ATP', 'At the inner mitochondrial membrane; no ATP made'], correct: 0, feedback: ['Glycolysis happens in the cytoplasm and produces a net gain of two ATP.', 'The mitochondrial matrix is where the citric acid cycle takes place. Glycolysis happens in the cytoplasm and has a net yield of 2 ATP.', 'The inner mitochondrial membrane is where oxidative phosphorylation happens. Glycolysis instead occurs in the cytoplasm and yields 2 ATP net.'] },
  { question: 'Which stage produces most of the ATP during cellular respiration?', options: ['Glycolysis', 'The citric acid cycle', 'Oxidative phosphorylation'], correct: 2, feedback: ['Glycolysis makes a small net gain of two ATP. Most ATP is made during oxidative phosphorylation.', 'The citric acid cycle produces some ATP, but oxidative phosphorylation produces most of it.', 'Oxidative phosphorylation produces most of the ATP as hydrogen ions flow through ATP synthase.'] },
  { question: 'What is the final electron acceptor in the electron transport chain?', options: ['Oxygen', 'NADH', 'ATP synthase'], correct: 0, feedback: ['Oxygen accepts the electrons at the end of the chain and combines with hydrogen to form water.', 'NADH donates electrons to the chain; oxygen is the final electron acceptor.', 'ATP synthase uses the hydrogen ion flow to make ATP; oxygen accepts the final electrons.'] },
];

const palette = {
  ink: '#f3f6f4', muted: '#aab8b5', soft: '#07120f', paper: 'rgba(17,31,26,0.70)',
  line: 'rgba(220,245,230,0.15)', navy: '#10261c', navy2: '#193b2a', yellow: '#f5d85e',
  yellowSoft: '#fff3b5', green: '#21815b', greenSoft: '#e5f4ea', blueSoft: '#e8f1f5',
  coral: '#d9785b',
};

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: palette.soft },
  shell: { flex: 1, minHeight: 0, flexDirection: 'row' },
  sidebar: { width: 236, backgroundColor: 'rgba(5,17,12,0.76)', paddingHorizontal: 18, paddingTop: 26, paddingBottom: 22, justifyContent: 'space-between', borderRightWidth: 1, borderColor: 'rgba(255,255,255,0.10)' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 38 },
  navLabel: { color: '#91a1aa', fontSize: 11, fontWeight: '700', letterSpacing: 1.4, marginLeft: 12, marginBottom: 10, marginTop: 10 },
  navItem: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, marginBottom: 4, flexDirection: 'row', gap: 11, alignItems: 'center' },
  main: { flex: 1, minHeight: 0, width: '100%' },
  inner: { width: '100%', maxWidth: 1320, alignSelf: 'center', paddingHorizontal: 30 },
  header: { minHeight: 78, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', position: 'relative' },
  content: { paddingTop: 28, paddingBottom: 56, gap: 20 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  card: { backgroundColor: palette.paper, borderRadius: 22, borderWidth: 1, borderColor: palette.line, padding: 22, overflow: 'hidden', shadowColor: '#000000', shadowOpacity: 0.28, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 5 },
  ambience: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'hidden' },
  scrollBackdrop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'hidden', backgroundColor: palette.soft },
  backgroundBlur: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  glowA: { position: 'absolute', width: 480, height: 480, borderRadius: 240, backgroundColor: 'rgba(19,104,62,0.34)', top: -190, right: '12%' },
  glowB: { position: 'absolute', width: 360, height: 360, borderRadius: 180, backgroundColor: 'rgba(8,68,43,0.42)', bottom: -170, right: '8%' },
  glowC: { position: 'absolute', width: 280, height: 280, borderRadius: 140, backgroundColor: 'rgba(180,142,31,0.12)', bottom: '18%', left: '18%' },
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
    const ranked = passages.map(({ passage, passageIndex }) => {
      const pTerms = new Set(terms(passage));
      const overlap = qTerms.filter((t) => pTerms.has(t)).length;
      let answerCue = 0;
      if (/\bfinal electron acceptor\b/i.test(question) && /\bfinal electron acceptor\b/i.test(passage)) answerCue += 5;
      if (/\bmost\b|\bmajority\b/i.test(question) && /\bmost of the (?:ATP|energy)\b/i.test(passage)) answerCue += 4;
      if (/\bwhere\b|\blocation\b|\bplace\b/i.test(question) && /\b(?:happens|occurs|takes place)\s+(?:in|at|within)\b/i.test(passage)) answerCue += 2;
      if (/\byield\b|\bhow many\b|\bnet\b/i.test(question) && /\bnet\s+(?:gain|yield)\b/i.test(passage)) answerCue += 2;
      return { passage, passageIndex, overlap, score: overlap + answerCue };
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

function ActionButton({ label, onPress, secondary = false, compact = false }: { label: string; onPress: () => void; secondary?: boolean; compact?: boolean }) {
  return <Pressable accessibilityRole="button" testID="torch-block" onPress={onPress} style={({ pressed }) => [secondary ? styles.secondaryButton : styles.button, { overflow: 'hidden' }, compact && { paddingVertical: 9, paddingHorizontal: 12 }, pressed && { transform: [{ scale: 0.975 }], opacity: 0.96, backgroundColor: secondary ? 'rgba(190,255,216,0.17)' : 'rgba(188,255,218,0.28)', borderWidth: 1, borderColor: 'rgba(210,255,226,0.56)', shadowColor: '#b9ffd3', shadowOpacity: 0.22, shadowRadius: 16 }]}><Text style={{ color: secondary ? palette.ink : '#fff', fontWeight: '700', fontSize: compact ? 12 : 14, textAlign: 'center', flexShrink: 1 }}>{label}</Text></Pressable>;
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

function RenderedPagePreview({ fileId, fileName, pageIndex, highlightTerms, fallbackText }: { fileId: string; fileName: string; pageIndex: number; highlightTerms: string[]; fallbackText: string }) {
  const hostRef = useRef<React.ComponentRef<typeof View> | null>(null);
  const [error, setError] = useState('');
  const normalizedTerms = highlightTerms.join('|');

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
    const termsForPage = normalizedTerms ? normalizedTerms.split('|').filter(Boolean) : [];
    setError('');
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
          const foreignObjects = [...svg.querySelectorAll('foreignObject')];
          foreignObjects.forEach((foreignObject) => wrapMatchedWords(foreignObject, termsForPage, 'slide'));
          underlineVectorMatches(svg, termsForPage);
          svg.setAttribute('width', '100%');
          svg.setAttribute('height', '100%');
          svg.style.display = 'block';
          svg.style.width = '100%';
          svg.style.height = 'auto';
          svg.style.background = '#ffffff';
          host.style.aspectRatio = `${presentation.width} / ${presentation.height}`;
          host.style.height = 'auto';
          host.replaceChildren(document.importNode(svg, true));
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
            wrapMatchedWords(textContainer, termsForPage, 'pdf');
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
  }, [fileId, fileName, pageIndex, normalizedTerms]);

  return <View style={{ gap: 8 }}><View ref={hostRef} accessibilityLabel={`Original page preview for ${fileName}, page ${pageIndex + 1}`} style={{ width: '100%', aspectRatio: 1.45, minHeight: 180, borderWidth: 1, borderColor: 'rgba(20,50,35,0.24)', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' }} />{!!error && <View style={{ gap: 7 }}><Text style={{ color: '#ffe9a0', fontSize: 12, lineHeight: 18 }}>{error} Showing the extracted text below instead.</Text><Text style={{ color: '#20372c', fontSize: 14, lineHeight: 21, backgroundColor: '#fffdf3', padding: 12, borderRadius: 8 }}>{fallbackText || 'No selectable text was found on this page. You can still view the original page above.'}</Text></View>}</View>;
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
  const [studyFormat, setStudyFormat] = useState<'flashcards' | 'qa' | 'read'>('qa');
  const [flashcardRevealed, setFlashcardRevealed] = useState(false);
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null);
  const [previewSlideIndex, setPreviewSlideIndex] = useState(0);
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
  const [backupBusy, setBackupBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRestoreBackup, setConfirmRestoreBackup] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageReady, setStorageReady] = useState(Platform.OS !== 'web');

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [page, folderOpen, activeSubjectId]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    try {
      const raw = window.localStorage.getItem(storageKey) || window.localStorage.getItem(legacyStorageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<SavedWorkspace>;
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
    } catch {
      // Keep the in-memory demo usable if browser storage is disabled or unreadable.
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || !storageReady) return;
    try {
      const savedSubjects = subjects.map((subject) => subject.id === activeSubjectId ? { ...subject, notes, questionsText } : subject);
      const saved: SavedWorkspace = { version: 2, notes, questionsText, demoMaterial, matches, attempted, correct, history, subjects: savedSubjects, activeSubjectId, selectedSourceId, selectedSourceIds, sourceScope };
      window.localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch {
      setNotice('Browser storage is full or unavailable. Remove a large file or shorten your materials, then try again.');
    }
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
      [data-testid="register-glass"] { border: 1px solid rgba(190,255,216,.28); background: linear-gradient(135deg, rgba(202,255,222,.13), rgba(112,180,139,.07) 54%, rgba(255,255,255,.035)); box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 0 rgba(130,231,168,.08), 0 6px 20px rgba(0,0,0,.14); -webkit-backdrop-filter: blur(14px) saturate(150%); backdrop-filter: blur(14px) saturate(150%); }
      [data-testid="brand-wordmark"] { font-family: "Segoe UI Variable", "Inter", system-ui, sans-serif; font-weight: 600; letter-spacing: -.65px; color: transparent !important; background: linear-gradient(180deg, #f5fff8 8%, #d5f2df 54%, #91c7a2 100%); -webkit-background-clip: text; background-clip: text; text-shadow: 0 0 13px rgba(177,255,202,.28); filter: drop-shadow(0 1px 0 rgba(255,255,255,.16)); }
      @media (prefers-reduced-motion: reduce) { [data-testid="torch-block"], [data-testid="nav-glass-indicator"] { transition: none !important; } [data-testid="nav-track"].nav-liquid-morph [data-testid="nav-glass-indicator"] { animation: none !important; } }
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
  const selectedSource = activeSubject?.files.find((file) => file.id === selectedSourceId && file.role === 'source') || null;
  const fileSegments = (file: StudyFile) => (file.segments?.length ? file.segments : asStudySegments(file.text, file.name)).map((segment) => ({ ...segment, sourceFileId: file.id }));
  const selectedStudyFiles = activeSubject?.files.filter((file) => file.role === 'source' && selectedSourceIds.includes(file.id)) || [];
  const lecturePreview = (file: StudyFile) => {
    const slides = fileSegments(file);
    const slideIndex = Math.min(previewSlideIndex, Math.max(0, slides.length - 1));
    const slide = slides[slideIndex];
    if (!slide) return null;
    const linkedQuestions = questionList.map((question) => ({ question, match: buildMatches([slide], [question])[0] })).filter(({ match }) => match.overlap > 0).sort((a, b) => b.match.overlap - a.match.overlap);
    const slideSuggestion = draftPracticeQuestions(slide.text)[0];
    const highlightBasis = linkedQuestions[0]?.question || questionList[0] || slideSuggestion || '';
    const slideTerms = new Set(terms(slide.text));
    const focusedTerms = terms(highlightBasis).filter((term) => slideTerms.has(term)).sort((a, b) => b.length - a.length).slice(0, 3);
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
      <RenderedPagePreview fileId={file.id} fileName={file.name} pageIndex={renderedPageIndex} highlightTerms={focusedTerms} fallbackText={slide.text ? `${slide.label}\n${slide.text}` : ''} />
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}><View style={{ backgroundColor: palette.yellow, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 }}><Text style={{ color: '#193326', fontSize: 11, fontWeight: '900' }}>HIGHLIGHTED</Text></View><Text style={styles.small}>{focusedTerms.length ? `Words linked to ${linkedQuestions[0]?.question || 'your first question'}.` : 'No matching words to highlight on this page yet.'}</Text></View>
      {!!slide.text && <View style={{ borderLeftWidth: 3, borderColor: palette.yellow, backgroundColor: 'rgba(245,216,94,0.07)', padding: 12, borderRadius: 8 }}><Text style={styles.label}>EXTRACTED TEXT · {linkedQuestions.length ? 'QUESTION MATCH' : 'PAGE CONTENT'}</Text><View style={{ marginTop: 7 }}>{highlightedPassage(slide.text, highlightBasis)}</View></View>}
      <View style={{ gap: 7 }}><Text style={styles.label}>QUESTION CONNECTIONS</Text>{linkedQuestions.length ? linkedQuestions.slice(0, 3).map(({ question, match }, index) => <View key={`${question}-${index}`} style={{ borderRadius: 9, padding: 10, backgroundColor: 'rgba(33,129,91,0.14)', borderWidth: 1, borderColor: 'rgba(90,210,141,0.22)' }}><Text style={{ color: '#dff8e7', fontSize: 13, fontWeight: '700' }}>{question}</Text><Text style={[styles.small, { marginTop: 3 }]}>{match.overlap} shared key terms · check this slide when answering</Text></View>) : <Text style={styles.body}>No saved question matches this slide yet. The highlight uses a draft recall prompt generated from its text.</Text>}</View>
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
  const sourceParagraphs = studySourceSegments.flatMap((segment) => segment.text.split(/\n\s*\n/).map((text) => ({ text: text.trim(), sourceLabel: segment.label }))).filter((item) => item.text);
  const hasStudyContent = studySourceText.trim().length > 0 || questionList.length > 0;
  const nextStudyMatch = matches.find((match) => history.some((attempt) => attempt.question === match.question && (attempt.outcome === 'missed' || attempt.outcome === 'needs-review')))
    || matches.filter((match) => match.overlap > 0).sort((a, b) => b.overlap - a.overlap)[0]
    || matches[0];
  const nextStudyReason = nextStudyMatch && history.some((attempt) => attempt.question === nextStudyMatch.question && (attempt.outcome === 'missed' || attempt.outcome === 'needs-review'))
    ? 'You marked this question for another review.'
    : nextStudyMatch?.overlap ? 'This question has the clearest evidence link in your source.' : 'This question needs a source link checked before you rely on it.';
  const currentQuestion = demoMaterial ? (demoQuiz[questionIndex % demoQuiz.length]?.question || 'What is the main idea of this module?') : (questionList[questionIndex] || 'What is the main idea of this module?');
  const currentDemoQuiz = demoQuiz[questionIndex % demoQuiz.length];
  const correctAnswer = currentDemoQuiz.correct;
  const hasNextQuestion = mode !== 'cram' && questionIndex < questionList.length - 1;
  const sourceOptions = studySourceSegments.flatMap((segment) => segment.text.split(/\n\s*\n/).map((passage) => ({ passage: passage.trim(), sourceLabel: segment.label, sourceFileId: segment.sourceFileId }))).filter(({ passage }) => passage.length > 45 && !/^[A-Z\s]+$/.test(passage)).map((item, index) => ({ ...item, passageIndex: index + 1 }));
  const moduleTitle = sourceScope === 'file' && selectedSource ? selectedSource.name.replace(/\.[^.]+$/, '') : activeSubject?.name || notes.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || 'Untitled module';
  const displayModuleTitle = demoMaterial ? 'Cellular respiration' : !hasStudyContent ? 'No study set yet' : moduleTitle.length > 52 ? `${moduleTitle.slice(0, 49)}…` : moduleTitle;
  const currentMatch = matches.find((match) => match.question === currentQuestion && (match.overlap > 0 || (match.manual && match.passageIndex !== null)));
  const linkedCount = matches.filter((match) => match.overlap > 0 || (match.manual && match.passageIndex !== null)).length;
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
      picker.type = 'file'; picker.accept = '.pdf,.docx,.ppt,.pptx,.txt,.md,.markdown,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown';
      const file = await new Promise<File | null>((resolve) => {
        picker.onchange = () => resolve(picker.files?.[0] || null);
        picker.click();
      });
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) throw new Error('Files must be 20 MB or smaller.');
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const extracted = (await extractDocumentText(file)).map((segment) => ({ ...segment, sourceFileId: fileId }));
      const content = extracted.map((segment) => segment.text).join('\n\n').trim();
      const canStudyVisually = kind === 'module' && /\.(?:pdf|pptx?)$/i.test(file.name);
      if (!content && !canStudyVisually) throw new Error('No selectable text was found. Scanned PDFs can still be previewed, but need OCR before automatic question matching.');
      const savedCharacters = subjects.reduce((total, subject) => total + subject.notes.length + subject.questionsText.length + subject.files.reduce((sum, savedFile) => sum + savedFile.text.length, 0), 0) + notes.length + questionsText.length;
      if (content.length > 350_000 || savedCharacters + content.length > 450_000) throw new Error('This file has too much extracted text for browser storage. Split it into shorter files or remove older files first.');
      const added: StudyFile = { id: fileId, name: file.name, text: content, segments: extracted, role: kind === 'module' ? 'source' : 'questions' };
      try { await saveOriginalDocument({ id: fileId, name: file.name, type: file.type || 'application/octet-stream', blob: file.slice(0, file.size, file.type || 'application/octet-stream') }); }
      catch { notify('The extracted text was saved, but the original file could not be kept by this browser. You can still study its text.'); }
      setSubjects((previous) => previous.map((subject) => subject.id === activeSubject.id ? { ...subject, files: [...subject.files, added] } : subject));
      if (kind === 'module') {
        setSelectedSourceId(added.id);
        setSourceScope('file');
        setMatches(buildMatches(extracted, questionList));
      } else setQuestionsText(content);
      setDemoMaterial(false);
      notify(content ? `${file.name} was added to ${activeSubject.name}. The text was extracted in this browser.` : `${file.name} was added to ${activeSubject.name}. Its pages are ready to preview; OCR is needed for text matching.`);
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
      const validSubjects = incoming.subjects.every((subject) => !!subject && typeof subject.id === 'string' && typeof subject.name === 'string' && typeof subject.notes === 'string' && typeof subject.questionsText === 'string' && Array.isArray(subject.files) && subject.files.every((studyFile) => !!studyFile && typeof studyFile.id === 'string' && typeof studyFile.name === 'string' && typeof studyFile.text === 'string' && (studyFile.role === 'source' || studyFile.role === 'questions') && (studyFile.segments === undefined || (Array.isArray(studyFile.segments) && studyFile.segments.every((segment) => !!segment && typeof segment.label === 'string' && typeof segment.text === 'string')))));
      if (!validSubjects) throw new Error('The backup contains incomplete folder or file data. Nothing was restored.');
      const textSize = incoming.subjects.reduce((total, subject) => total + subject.notes.length + subject.questionsText.length + subject.files.reduce((sum, studyFile) => sum + studyFile.text.length, 0), 0);
      if (textSize > 450_000) throw new Error('This backup exceeds the current browser workspace text limit. Nothing was restored.');
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
      const restoredSubjects = incoming.subjects as Subject[];
      const restoredActiveId = restoredSubjects.some((subject) => subject.id === incoming.activeSubjectId) ? incoming.activeSubjectId! : restoredSubjects[0]?.id || null;
      const active = restoredSubjects.find((subject) => subject.id === restoredActiveId);
      setSubjects(restoredSubjects); setActiveSubjectId(restoredActiveId); setNotes(active?.notes || incoming.notes || ''); setQuestionsText(active?.questionsText || incoming.questionsText || '');
      setDemoMaterial(incoming.demoMaterial === true); setMatches(Array.isArray(incoming.matches) ? incoming.matches as Match[] : []);
      setAttempted(Number.isFinite(incoming.attempted) ? Number(incoming.attempted) : 0); setCorrect(Number.isFinite(incoming.correct) ? Number(incoming.correct) : 0);
      setHistory(Array.isArray(incoming.history) ? incoming.history as StudyAttempt[] : []); setSelectedSourceId(typeof incoming.selectedSourceId === 'string' ? incoming.selectedSourceId : null);
      setSelectedSourceIds(Array.isArray(incoming.selectedSourceIds) ? incoming.selectedSourceIds.filter((id): id is string => typeof id === 'string') : []);
      setSourceScope(incoming.sourceScope === 'file' || incoming.sourceScope === 'notes' || incoming.sourceScope === 'selected' ? incoming.sourceScope : 'subject');
      setFolderOpen(false); setPreviewSourceId(null); setSourceReader(null); setConfirmRestoreBackup(false); setPage('home'); setQuestionIndex(0); setAnswer(null); setAnswerDraft('');
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
    setActiveSubjectId(created.id); setNotes(''); setQuestionsText(''); setMatches([]); setSelectedSourceId(null); setSelectedSourceIds([]); setPreviewSourceId(null); setSourceScope('subject'); setMaterialsTab('sources'); setDemoMaterial(false); setNewSubjectName('');
    notify(`${name} is ready. Add notes or upload source files to this subject.`);
  };

  const selectSubject = (id: string) => {
    const next = subjects.find((subject) => subject.id === id);
    if (!next) return;
    setSubjects((previous) => previous.map((subject) => subject.id === activeSubjectId ? { ...subject, notes, questionsText } : subject));
    setActiveSubjectId(next.id); setNotes(next.notes); setQuestionsText(next.questionsText); setMatches(buildMatches([...asStudySegments(next.notes), ...next.files.filter((file) => file.role === 'source').flatMap(fileSegments)], splitQuestions(next.questionsText)));
    setSelectedSourceId(null); setSelectedSourceIds([]); setPreviewSourceId(null); setSourceScope('subject'); setMaterialsTab('sources'); setDemoMaterial(false);
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

  const beginStudyFormat = (format: 'flashcards' | 'qa' | 'read') => {
    if (!selectedSourceIds.length) { notify('Select at least one source to study.'); return; }
    setSourceScope('selected'); setStudyFormat(format); setFlashcardRevealed(false);
    const sourceSegments = [...(selectedSourceIds.includes('__notes__') ? asStudySegments(notes) : []), ...(activeSubject?.files.filter((file) => file.role === 'source' && selectedSourceIds.includes(file.id)).flatMap(fileSegments) || [])];
    const sessionQuestions = questionList.length ? questionList : format === 'read' ? [] : draftPracticeQuestions(sourceSegments.map((segment) => segment.text).join('\n\n'));
    if (!questionList.length && format !== 'read' && sessionQuestions.length) setQuestionsText(sessionQuestions.map((question, index) => `${index + 1}. ${question}`).join('\n'));
    setMatches(buildMatches(sourceSegments, sessionQuestions));
    if (format !== 'read' && !sessionQuestions.length) { notify('Add some questions or clearer source notes before starting practice.'); return; }
    if (format === 'qa') { startStudy(selectedPace); return; }
    setMode(selectedPace); setQuestionIndex(0); setPhase(format === 'read' ? 'module' : 'diagnostic'); setAnswer(null); setAnswerDraft(''); setPage('study');
  };

  const activateSubjectFile = (file: StudyFile) => {
    if (file.role === 'questions') {
      setQuestionsText(file.text);
      notify(`${file.name} loaded into the questions editor.`);
      return;
    }
    setSourceToFile(file);
    setPreviewSlideIndex(0);
    setPreviewSourceId((previous) => previous === file.id ? null : file.id);
  };

  const removeSubjectFile = (fileId: string) => {
    const updatedFiles = activeSubject?.files.filter((file) => file.id !== fileId) || [];
    if (Platform.OS === 'web') void deleteOriginalDocument(fileId).catch(() => undefined);
    setSubjects((previous) => previous.map((subject) => subject.id === activeSubjectId ? { ...subject, files: updatedFiles } : subject));
    if (previewSourceId === fileId) setPreviewSourceId(null);
    setSelectedSourceIds((previous) => previous.filter((id) => id !== fileId));
    if (selectedSourceId === fileId) { setSelectedSourceId(null); setSourceScope('subject'); setMatches(buildMatches([...asStudySegments(notes), ...updatedFiles.filter((file) => file.role === 'source').flatMap(fileSegments)], questionList)); }
  };

  const matchQuestions = () => {
    const next = buildMatches(studySourceSegments, questionList);
    setMatches(next);
    setPage('import');
  };

  const generateQuestions = () => {
    const drafts = draftPracticeQuestions(studySourceText);
    if (!drafts.length) {
      notify('No question patterns were detected. Add complete explanatory sentences or write questions manually.');
      return;
    }
    const numbered = drafts.map((question, index) => `${index + 1}. ${question}`).join('\n');
    setQuestionsText(numbered);
    setDemoMaterial(false);
    setMatches(buildMatches(studySourceSegments, drafts));
    notify(`${drafts.length} practice question drafts added. They were generated locally from text patterns, so review and edit them before studying.`);
  };

  const clearWorkspace = () => {
    setNotes(''); setQuestionsText(''); setMatches([]); setAttempted(0); setCorrect(0); setHistory([]); setSelectedSourceIds([]);
    setDemoMaterial(false); setSubjects([]); setActiveSubjectId(null); setFolderOpen(false); setSelectedSourceId(null); setPreviewSourceId(null); setSourceReader(null); setSourceScope('subject'); setNotice('Your workspace is empty. Create a subject and add notes whenever you’re ready.');
    if (Platform.OS === 'web') void clearOriginalDocuments().catch(() => undefined);
    setPage('home'); setQuestionIndex(0); setAnswer(null); setAnswerDraft('');
  };

  const startStudy = (pace: Pace = mode, firstQuestionIndex = 0) => {
    setMode(pace); setSelectedPace(pace); setQuestionIndex(Math.max(0, firstQuestionIndex)); setPhase(pace === 'deep' ? 'module' : 'diagnostic'); setAnswer(null); setAnswerDraft(''); setPage('study');
  };

  const submitAnswer = (value: number) => {
    if (answer !== null) return;
    const outcome: StudyAttempt['outcome'] = demoMaterial ? (value === correctAnswer ? 'correct' : 'missed') : (value === 1 ? 'self-rated-ready' : 'needs-review');
    setAnswer(value);
    setAttempted((n) => n + 1);
    if (demoMaterial && value === correctAnswer) setCorrect((n) => n + 1);
    setHistory((previous) => [{ id: `${Date.now()}-${previous.length}`, question: currentQuestion, mode, outcome, createdAt: new Date().toISOString() }, ...previous].slice(0, 200));
  };

  const continueSession = () => {
    if (phase === 'diagnostic') { setPhase('review'); setAnswer(null); setAnswerDraft(''); }
    else if (phase === 'check' && hasNextQuestion) { setQuestionIndex((index) => index + 1); setPhase('diagnostic'); setAnswer(null); setAnswerDraft(''); }
    else { setPhase('diagnostic'); setAnswer(null); setAnswerDraft(''); setPage('insights'); }
  };

  const quizPanel = demoMaterial ? <View style={[styles.card, { gap: 16 }]}><Text style={styles.label}>{phase === 'diagnostic' ? `QUESTION ${questionIndex + 1} · ${phase === 'diagnostic' && questionIndex === 0 ? 'START WITH RECALL' : 'RECALL CHECK'}` : 'AFTER REVIEW · RETRIEVAL CHECK'}</Text><Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800', lineHeight: 28 }}>{currentQuestion}</Text><Text style={styles.body}>Choose your best answer. This is practice, not a grade.</Text>
    {currentDemoQuiz.options.map((option, i) => <Pressable key={i} onPress={() => submitAnswer(i)} style={{ borderWidth: 1, borderColor: answer === i ? (i === correctAnswer ? '#43c982' : '#db785b') : palette.line, backgroundColor: answer === i ? (i === correctAnswer ? 'rgba(33,129,91,0.28)' : 'rgba(217,120,91,0.20)') : 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 14 }}><Text style={{ color: palette.ink, fontWeight: '600', fontSize: 14 }}>{String.fromCharCode(65 + i)}. {option}</Text></Pressable>)}
    {answer !== null && <View style={{ padding: 13, borderRadius: 11, backgroundColor: answer === correctAnswer ? 'rgba(33,129,91,0.20)' : 'rgba(217,120,91,0.16)', borderWidth: 1, borderColor: answer === correctAnswer ? 'rgba(67,201,130,0.48)' : 'rgba(217,120,91,0.45)' }}><Text style={{ color: answer === correctAnswer ? '#8ce0ae' : '#f0a38d', fontWeight: '800' }}>{answer === correctAnswer ? 'Correct.' : 'Not quite — check the source passage.'}</Text><Text style={[styles.small, { marginTop: 4, color: '#c3cfca' }]}>{currentDemoQuiz.feedback[answer]}</Text></View>}
    {answer !== null && (answer !== correctAnswer ? <ActionButton label={currentMatch ? `Open source · ${currentMatch.sourceLabel || `passage ${currentMatch.passageIndex}`} →` : 'Review notes manually →'} onPress={() => currentMatch ? void openSourceLocation(currentMatch) : openSourcePassage()} /> : <ActionButton label={phase === 'diagnostic' ? 'Review the key passage →' : hasNextQuestion ? 'Next question →' : 'Finish session →'} onPress={continueSession} />)}
  </View> : <View style={[styles.card, { gap: 16 }]}><Text style={styles.label}>{phase === 'diagnostic' ? 'BEFORE REVIEW · YOUR QUESTION' : 'AFTER REVIEW · YOUR QUESTION'}</Text><Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800', lineHeight: 28 }}>{currentQuestion}</Text><Text style={styles.body}>Try answering from memory. This prototype records your self-rating; it does not claim to grade custom answers yet.</Text>
    <TextInput value={answerDraft} onChangeText={setAnswerDraft} multiline placeholder="Type a short answer or key points…" placeholderTextColor="#9ba6ad" style={[styles.input, { minHeight: 90 }]} />
    <Text style={styles.label}>HOW DID THAT FEEL?</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton compact label="I could explain it" onPress={() => submitAnswer(1)} /><ActionButton compact secondary label="Not sure yet" onPress={() => submitAnswer(0)} /></View>
    {answer !== null && <View style={{ padding: 13, borderRadius: 11, backgroundColor: answer === 1 ? 'rgba(33,129,91,0.20)' : 'rgba(245,216,94,0.12)', borderWidth: 1, borderColor: answer === 1 ? 'rgba(67,201,130,0.42)' : 'rgba(245,216,94,0.32)' }}><Text style={{ color: answer === 1 ? '#8ce0ae' : '#fff2ad', fontWeight: '800' }}>{answer === 1 ? 'Self-rated: ready to move on.' : 'Self-rated: prioritize this for review.'}</Text><Text style={[styles.small, { marginTop: 4 }]}>{answer === 1 ? 'Your answer is recorded as ready based on your self-rating.' : 'You marked this as uncertain. Revisit the matched source, then try recalling it again.'}</Text></View>}
    {answer !== null && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton label={answer === 0 ? (currentMatch?.passageIndex ? `Open source · ${currentMatch.sourceLabel || `passage ${currentMatch.passageIndex}`} →` : 'Review notes manually →') : phase === 'diagnostic' ? 'Review the linked passage →' : hasNextQuestion ? 'Next question →' : 'Finish session →'} onPress={answer === 0 ? (currentMatch ? () => void openSourceLocation(currentMatch) : openSourcePassage) : phase === 'diagnostic' ? openSourcePassage : continueSession} />{answer === 0 && phase === 'check' && <ActionButton secondary label={hasNextQuestion ? 'Next question' : 'Finish session'} onPress={continueSession} />}</View>}
  </View>;

  const reviewPanel = <View style={[styles.card, { gap: 16 }]}><View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><View><Text style={styles.label}>{phase === 'module' ? 'DEEP MODE · FULL MODULE' : currentMatch?.manual ? 'MANUAL SOURCE · VERIFY THIS LINK' : currentMatch ? 'YELLOW = LINKED TO YOUR FORMATIVE' : 'NO AUTOMATIC QUESTION LINK'}</Text><Text style={{ color: palette.ink, fontWeight: '800', fontSize: 20, marginTop: 6 }}>{phase === 'module' ? 'Read the full module first' : 'Read the relevant part first'}</Text>{currentMatch?.passageIndex && <Text style={[styles.small, { marginTop: 5 }]}>{currentMatch.manual ? 'Manually selected' : phase === 'module' ? 'Linked source' : 'Suggested source'} · {currentMatch.sourceLabel || `passage ${currentMatch.passageIndex}`}</Text>}</View>{phase !== 'module' && <View style={{ backgroundColor: currentMatch ? palette.blueSoft : '#f2f3ef', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' }}><Text style={{ color: currentMatch ? '#386174' : palette.muted, fontSize: 11, fontWeight: '800' }}>{currentMatch?.manual ? 'MANUAL LINK · VERIFY' : currentMatch ? 'EVIDENCE LINK · NOT A PREDICTION' : 'REVIEW SOURCE MANUALLY'}</Text></View>}</View>
    {phase !== 'module' && currentMatch && findMatchSourceFile(currentMatch) && <ActionButton compact secondary label="Open source location →" onPress={() => void openSourceLocation(currentMatch)} />}
    {phase === 'module' ? <View style={{ gap: 10 }}>{sourceParagraphs.map((paragraph, index) => { const isMatch = currentMatch?.passage === paragraph.text; return <View key={`module-${index}`} style={{ backgroundColor: isMatch ? 'rgba(245,216,94,0.08)' : 'transparent', borderLeftWidth: isMatch ? 3 : 0, borderLeftColor: palette.yellow, borderRadius: 10, padding: isMatch ? 12 : 5, gap: 6 }}>{(index === 0 || sourceParagraphs[index - 1]?.sourceLabel !== paragraph.sourceLabel) && <Text style={{ color: '#b8e8c7', fontSize: 11, fontWeight: '800' }}>{paragraph.sourceLabel}</Text>}{isMatch && <Text style={{ color: '#fff2ad', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 }}>LIKELY SOURCE · {paragraph.sourceLabel}</Text>}{isMatch ? highlightedPassage(paragraph.text, currentQuestion) : <Text style={{ color: palette.ink, fontSize: 15, lineHeight: 25 }}>{paragraph.text}</Text>}</View>; })}</View> : currentMatch ? highlightedPassage(reviewPassage, currentQuestion) : <Text style={{ color: palette.ink, fontSize: 15, lineHeight: 26 }}>{reviewPassage}</Text>}
    {phase !== 'module' && currentMatch && <Text style={[styles.small, { marginBottom: -7 }]}>Stronger gold marks a likely answer phrase when detected · softer gold marks related question terms.</Text>}
    <View style={{ backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 14, gap: 6 }}><Text style={styles.label}>TERMS FROM THE QUESTION</Text><Text style={{ color: palette.ink, fontSize: 14, lineHeight: 22, fontWeight: '700' }}>{terms(currentQuestion).slice(0, 6).join(' · ') || 'No key terms detected'}</Text></View>
    {phase !== 'module' && currentMatch && <View style={{ backgroundColor: 'rgba(245,216,94,0.10)', borderColor: 'rgba(245,216,94,0.28)', borderWidth: 1, borderRadius: 11, padding: 12 }}><Text style={{ color: '#fff2ad', fontSize: 13, fontWeight: '800' }}>Matched formative question</Text><Text style={{ color: palette.ink, fontSize: 13, marginTop: 4 }}>{currentQuestion}</Text><Text style={[styles.small, { marginTop: 5 }]}>Suggested by shared keywords. Verify that this passage really supports the question.</Text></View>}
    {phase === 'module' ? <ActionButton label="Start with a quick diagnostic →" onPress={() => { setPhase('diagnostic'); setAnswer(null); }} /> : <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}><ActionButton label="I get it · quiz me" onPress={() => { setPhase('check'); setAnswer(null); setAnswerDraft(''); }} /><ActionButton label="Still confusing" secondary onPress={() => notify(demoMaterial ? 'Try it in your own words: glucose is split during glycolysis in the cytoplasm, leaving a net gain of two ATP.' : 'Alternate explanations are a planned AI feature. For now, reread the linked source or shorten your notes to one confusing idea.')} /></View>}
  </View>;

  const navItems = [
    { id: 'home' as const, icon: '⌂', label: 'Home' },
    { id: 'modes' as const, icon: '◉', label: 'Review' },
    { id: 'import' as const, icon: '▤', label: 'Materials' },
    { id: 'insights' as const, icon: '◴', label: 'Progress' },
  ];

  const brand = <Pressable accessibilityRole="link" accessibilityLabel="Recall Loop home" onPress={() => setPage('home')} style={[styles.brandRow, { marginBottom: 0, marginRight: wide || compact ? 0 : 'auto', paddingVertical: 7 }]}>
    <Svg accessibilityElementsHidden width={34} height={30} viewBox="0 0 36 32" fill="none">
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

  const paceOptions: { id: Pace; icon: string; title: string; time: string; description: string; steps: string }[] = [
    { id: 'cram', icon: '⚡︎', title: 'Cram', time: '10 min', description: 'Find gaps fast. Review one source, then retry.', steps: 'Recall · One source · Retry' },
    { id: 'steady', icon: '↗', title: 'Steady', time: '20 min', description: 'Recall first, then review all questions.', steps: 'Recall · Focused review' },
    { id: 'deep', icon: '◎', title: 'Deep', time: '35 min', description: 'Read the module, then test your recall.', steps: 'Full module · Recall · Follow-up' },
  ];
  const selectedOption = paceOptions.find((option) => option.id === selectedPace)!;
  const flowSteps = [
    { tag: 'A · RECALL', title: 'Try from memory first', text: 'Answer a question before opening your notes. This shows what you already know.' },
    { tag: 'B · REVIEW', title: 'Follow the source', text: 'If you miss a question, open its matched passage and check the evidence.' },
    { tag: 'C · RETRY', title: 'Check what stuck', text: 'Answer again, then use Progress to see what needs another review.' },
  ];
  const materialsSection = <View testID="scroll-reveal" style={{ paddingVertical: 64, borderTopWidth: 1, borderColor: palette.line, gap: 18 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
      <View style={{ gap: 7 }}><Text style={[styles.label, { color: '#8fcba6' }]}>YOUR STUDY SET</Text><Text style={[styles.title, { fontSize: 30 }]}>{hasStudyContent ? 'Review your study set.' : 'Add your study materials.'}</Text></View>
      <Pressable onPress={() => setPage('import')}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>{hasStudyContent ? 'Edit materials →' : 'Add notes and questions →'}</Text></Pressable>
    </View>
    <View testID="torch-block" style={[styles.card, { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 18, padding: 22 }]}>
      <View style={{ gap: 6, flex: 1, minWidth: 220 }}><Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800' }}>{displayModuleTitle}</Text><Text style={styles.body}>{hasStudyContent ? `${questionList.length} questions · ${linkedCount} suggested or selected passages` : 'Add module notes and formative questions. Then review the suggested source matches before studying.'}</Text></View>
      <ActionButton secondary label={hasStudyContent ? 'Check source matches' : 'Open My materials'} onPress={() => setPage('import')} />
    </View>
  </View>;
  const studyFlowSection = <View testID="scroll-reveal" style={{ paddingVertical: 64, borderTopWidth: 1, borderColor: palette.line, gap: 22 }}>
    <View style={{ maxWidth: 650, gap: 8 }}><Text style={[styles.label, { color: '#8fcba6' }]}>WHAT HAPPENS IN A SESSION</Text><Text style={[styles.title, { fontSize: 32 }]}>Recall. Review. Retry.</Text></View>
    <View style={{ gap: 12 }}>{flowSteps.map((item, index) => <React.Fragment key={item.tag}>
      <View testID="torch-block" style={[styles.card, { width: wide ? '76%' : '100%', alignSelf: wide && index % 2 ? 'flex-end' : 'flex-start', flexDirection: 'row', alignItems: 'flex-start', gap: 16, padding: 20 }]}>
        <View style={{ width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(245,216,94,0.13)' }}><Text style={{ color: palette.yellow, fontSize: 14, fontWeight: '900' }}>{String(index + 1).padStart(2, '0')}</Text></View>
        <View style={{ flex: 1, gap: 6 }}><Text style={[styles.label, { color: '#8fcba6' }]}>{item.tag}</Text><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>{item.title}</Text><Text style={styles.body}>{item.text}</Text></View>
      </View>
      {index < flowSteps.length - 1 && <Text aria-hidden style={{ alignSelf: 'center', color: '#8fcba6', fontSize: 20, lineHeight: 22 }}>↓</Text>}
    </React.Fragment>)}</View>
  </View>;
  const home = <View style={[styles.content, { paddingTop: 10, gap: 0 }]}>
    <View testID="scroll-reveal" style={{ minHeight: compact ? undefined : 520, justifyContent: 'center', alignItems: 'flex-start', paddingVertical: compact ? 38 : 64, gap: 20 }}>
      <View style={{ width: '100%', maxWidth: 800, alignItems: 'flex-start', gap: 13 }}><Text style={[styles.label, { color: '#8fcba6', letterSpacing: 1.8 }]}>LESS REREADING · MORE RECALL</Text><Text style={[styles.title, { fontSize: wide ? 52 : compact ? 34 : 42, lineHeight: wide ? 62 : compact ? 42 : 52 }]}>Study with a loop that sticks.</Text><Text style={[styles.body, { fontSize: 17, lineHeight: 27, maxWidth: 650 }]}>Turn notes and lecture files into focused, question-led practice.</Text></View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 4 }}><ActionButton label={hasStudyContent ? 'Choose a study mode →' : 'Get started →'} onPress={() => setPage(hasStudyContent ? 'modes' : 'import')} /><ActionButton secondary label="See how it works ↓" onPress={() => scrollRef.current?.scrollToEnd({ animated: true })} /></View>
      <Text style={[styles.small, { marginTop: 3 }]}>{hasStudyContent ? `${displayModuleTitle} · ${questionList.length} questions ready` : 'Add a subject and your study materials to begin.'}</Text>
    </View>
    {studyFlowSection}
    {materialsSection}
    <Text style={[styles.small, { textAlign: 'center', paddingVertical: 18 }]}>Recall Loop · v0.1 · {demoMaterial ? 'sample content' : 'local workspace'}</Text>
  </View>;

  const lockInScreen = <View style={[styles.content, { width: '100%', maxWidth: 1120, alignSelf: 'center', alignItems: 'center' }]}>
    <View style={{ width: '100%', maxWidth: 760, alignItems: 'center', gap: 8 }}><Text style={[styles.label, { color: '#8fcba6', textAlign: 'center' }]}>REVIEW MODE</Text><Text style={[styles.title, { marginTop: 2, textAlign: 'center' }]}>Choose a session style</Text><Text style={[styles.body, { textAlign: 'center' }]}>Pick the pace that fits your time and focus.</Text></View>
    <View style={[styles.row, { width: '100%', justifyContent: 'center' }]}>{paceOptions.map((option) => { const active = selectedPace === option.id; return <Pressable key={option.id} onPress={() => setSelectedPace(option.id)} accessibilityRole="button" accessibilityState={{ selected: active }} testID="torch-block" style={[styles.card, { flex: compact ? undefined : 1, flexBasis: compact ? '100%' : width <= 900 ? '48%' : undefined, minWidth: compact ? 0 : 240, maxWidth: compact ? '100%' : width <= 900 ? '48%' : 360, minHeight: compact ? 215 : 255, gap: 13, borderColor: active ? 'rgba(90,210,141,0.55)' : palette.line, backgroundColor: active ? 'rgba(24,70,44,0.78)' : 'rgba(17,31,26,0.70)', padding: compact ? 18 : 20 }]}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={{ fontSize: 22, color: active ? '#9ff0ba' : palette.yellow }}>{option.icon}</Text><Text style={{ color: active ? '#d9ffe2' : palette.muted, fontSize: 11, fontWeight: '800' }}>{option.time.toUpperCase()}</Text></View><Text style={{ color: palette.ink, fontSize: 22, fontWeight: '800' }}>{option.title}</Text><Text style={[styles.body, { flex: 1 }]}>{option.description}</Text><Text style={{ color: active ? '#b8e8c7' : '#85948e', fontSize: 11, lineHeight: 17, fontWeight: '700' }}>{option.steps}</Text></Pressable>; })}</View>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap', marginTop: 2 }}><ActionButton label={hasStudyContent ? `Start ${selectedOption.time} ${selectedOption.title.toLowerCase()} session →` : 'Add materials to begin →'} onPress={() => hasStudyContent ? startStudy(selectedPace) : setPage('import')} /><Pressable onPress={() => setPage('import')} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}><Text style={{ color: '#b9c5c0', fontWeight: '700' }}>{hasStudyContent ? 'Choose materials' : 'Open Materials'}</Text></Pressable></View>
    <Text style={[styles.small, { textAlign: 'center' }]}>{hasStudyContent ? `${displayModuleTitle} · ${questionList.length} questions · ${linkedCount} source links to verify` : 'Add notes and questions in Materials before starting a session.'}</Text>
  </View>;

  const importScreen = <View style={styles.content}>
    <View><Text style={styles.label}>{folderOpen ? 'SUBJECT FOLDER' : 'YOUR MATERIALS'}</Text><Text style={[styles.title, { marginTop: 7 }]}>{folderOpen && activeSubject ? activeSubject.name : 'My materials'}</Text><Text style={[styles.body, { marginTop: 7, maxWidth: 760 }]}>{folderOpen ? 'Add source notes or files, add your questions, then match them to evidence before you start a session.' : 'Create a folder for each class or topic. Open it to add notes, upload files, and choose what you want to study.'}</Text></View>

    {!folderOpen ? <View style={{ gap: 16 }}>
      <View testID="torch-block" style={[styles.card, { gap: 14 }]}>
        <View><Text style={{ color: palette.ink, fontSize: 19, fontWeight: '800' }}>Create a subject folder</Text></View>
        <View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}><TextInput value={newSubjectName} onChangeText={setNewSubjectName} placeholder="e.g. Physics" placeholderTextColor="#9ba6ad" accessibilityLabel="New subject folder name" style={[styles.input, { minHeight: 45, flex: 1, minWidth: 210 }]} onSubmitEditing={createSubject} /><ActionButton label="Create folder" onPress={createSubject} /></View>
      </View>
      {!!subjects.length && <View style={{ gap: 12 }}><Text style={styles.label}>FOLDERS · {subjects.length}</Text><View style={styles.row}>{subjects.map((subject) => <Pressable key={subject.id} accessibilityRole="button" accessibilityLabel={`Open ${subject.name} folder`} onPress={() => openSubject(subject.id)} testID="torch-block" style={[styles.card, { flex: 1, minWidth: 220, maxWidth: 330, minHeight: 144, gap: 10, padding: 17, alignItems: 'flex-start', justifyContent: 'space-between' }]}><View style={{ gap: 8 }}><View style={{ width: 31, height: 23, borderRadius: 5, backgroundColor: 'rgba(245,216,94,0.18)', borderWidth: 1, borderColor: 'rgba(245,216,94,0.38)', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.yellow, fontSize: 12, fontWeight: '900' }}>▰</Text></View><Text style={{ color: palette.ink, fontSize: 17, fontWeight: '800' }}>{subject.name}</Text><Text style={styles.small}>{subject.files.length} {subject.files.length === 1 ? 'file' : 'files'}</Text></View><Text style={{ color: '#9fe1b5', fontSize: 12, fontWeight: '800' }}>Open folder →</Text></Pressable>)}</View></View>}
    </View> : activeSubject ? <View style={{ gap: 16 }}>
      <Pressable onPress={() => { setFolderOpen(false); setConfirmClear(false); }} style={{ alignSelf: 'flex-start', paddingVertical: 5, paddingRight: 10 }}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>← All subject folders</Text></Pressable>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, borderBottomWidth: 1, borderColor: palette.line, paddingBottom: 10 }}>
        {([['sources', 'Sources'], ['add', 'Add'], ['summary', 'AI Summary']] as const).map(([id, label]) => <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: materialsTab === id }} onPress={() => setMaterialsTab(id)} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 20, backgroundColor: materialsTab === id ? 'rgba(33,129,91,0.35)' : 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: materialsTab === id ? 'rgba(90,210,141,0.35)' : 'transparent' }}><Text style={{ color: materialsTab === id ? '#eaffef' : '#b9c5c0', fontWeight: '800' }}>{label}</Text></Pressable>)}
      </View>
      {materialsTab === 'add' ? <View style={{ gap: 14 }}>
        <Text style={[styles.body, { maxWidth: 700 }]}>Add your own notes or questions from class. Both stay in this subject folder.</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{([['notes', 'Subject notes'], ['questions', 'Questions already asked']] as const).map(([id, label]) => <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: addTab === id }} onPress={() => setAddTab(id)} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 18, backgroundColor: addTab === id ? 'rgba(33,129,91,0.3)' : 'rgba(255,255,255,0.04)' }}><Text style={{ color: addTab === id ? '#eaffef' : palette.muted, fontWeight: '700' }}>{label}</Text></Pressable>)}</View>
        {addTab === 'notes' ? <View testID="torch-block" style={[styles.card, { gap: 12 }]}><View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><Text style={{ fontSize: 18, color: palette.ink, fontWeight: '800' }}>Subject notes</Text><ActionButton compact secondary label="Upload PDF / DOCX / PPT / PPTX" onPress={() => importFile('module')} /></View><TextInput value={notes} onChangeText={(value) => { setNotes(value); setDemoMaterial(false); }} multiline placeholder="Paste or write notes for this subject…" placeholderTextColor="#9ba6ad" style={[styles.input, { minHeight: 220 }]} /></View> : <View testID="torch-block" style={[styles.card, { gap: 12 }]}><View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><Text style={{ fontSize: 18, color: palette.ink, fontWeight: '800' }}>Questions already asked</Text><ActionButton compact secondary label="Upload question file" onPress={() => importFile('questions')} /></View><TextInput value={questionsText} onChangeText={(value) => { setQuestionsText(value); setDemoMaterial(false); }} multiline placeholder="Add one question per line…" placeholderTextColor="#9ba6ad" style={[styles.input, { minHeight: 220 }]} /><ActionButton compact secondary label="Draft practice questions from sources" onPress={generateQuestions} /></View>}
      </View> : materialsTab === 'summary' ? <View testID="torch-block" style={[styles.card, { minHeight: 200, gap: 10, justifyContent: 'center' }]}><Text style={styles.label}>COMING NEXT</Text><Text style={{ color: palette.ink, fontSize: 21, fontWeight: '800' }}>AI Summary</Text><Text style={styles.body}>A source-grounded summary will appear here. This preview is intentionally static for now.</Text></View> : <View style={{ gap: 15 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}><Text style={[styles.body, { flex: 1, minWidth: 220 }]}>Add lecture files here, then choose which sources to include in your study session.</Text><ActionButton label={busy ? 'Reading file…' : 'Add source file'} onPress={() => importFile('module')} /></View>
        {!!notes.trim() && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedSourceIds.includes('__notes__') }} onPress={() => toggleStudySource('__notes__')} testID="torch-block" style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderColor: selectedSourceIds.includes('__notes__') ? 'rgba(90,210,141,0.55)' : palette.line }]}><View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: selectedSourceIds.includes('__notes__') ? '#7fd79a' : palette.line, backgroundColor: selectedSourceIds.includes('__notes__') ? '#21815b' : 'transparent', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontWeight: '900' }}>{selectedSourceIds.includes('__notes__') ? '✓' : ''}</Text></View><View style={{ flex: 1 }}><Text style={{ color: palette.ink, fontWeight: '800' }}>Subject notes</Text><Text style={styles.small}>Added notes · {notes.trim().split(/\s+/).length} words</Text></View><Pressable accessibilityRole="button" onPress={(event) => { event.stopPropagation(); setAddTab('notes'); setMaterialsTab('add'); }}><Text style={{ color: '#9fe1b5', fontWeight: '800', padding: 8 }}>Edit</Text></Pressable></Pressable>}
        {activeSubject.files.filter((file) => file.role === 'source').map((file) => <View key={file.id} style={[styles.card, { gap: 10, padding: 15 }]}>
          <View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 10 }}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedSourceIds.includes(file.id) }} onPress={() => toggleStudySource(file.id)} style={{ flex: 1, minWidth: 170, flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 44 }}><View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: selectedSourceIds.includes(file.id) ? '#7fd79a' : palette.line, backgroundColor: selectedSourceIds.includes(file.id) ? '#21815b' : 'transparent', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontWeight: '900' }}>{selectedSourceIds.includes(file.id) ? '✓' : ''}</Text></View><View style={{ flex: 1 }}><Text style={{ color: palette.ink, fontWeight: '800' }}>{file.name}</Text><Text style={styles.small}>Source material · {file.text.trim().split(/\s+/).length} words</Text></View></Pressable><View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}><ActionButton compact secondary label={previewSourceId === file.id ? 'Hide preview' : 'Preview'} onPress={() => { setPreviewSlideIndex(0); setPreviewSourceId((previous) => previous === file.id ? null : file.id); }} /><Pressable accessibilityRole="button" accessibilityLabel={`Delete ${file.name}`} onPress={() => removeSubjectFile(file.id)} style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }}><Text style={{ color: palette.muted, fontWeight: '700' }}>Delete</Text></Pressable></View></View>
          {previewSourceId === file.id && <View style={{ borderTopWidth: 1, borderColor: palette.line, paddingTop: 10, gap: 9 }}><Text style={styles.label}>SOURCE PREVIEW</Text>{lecturePreview(file)}</View>}
        </View>)}
        {activeSubject.files.filter((file) => file.role === 'questions').map((file) => <View key={file.id} style={[styles.card, { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 15 }]}><View style={{ flex: 1, minWidth: 180 }}><Text style={{ color: palette.ink, fontWeight: '800' }}>{file.name}</Text><Text style={styles.small}>Question file · {file.text.trim().split(/\s+/).length} words</Text></View><ActionButton compact secondary label="Load questions" onPress={() => activateSubjectFile(file)} /><Pressable accessibilityRole="button" accessibilityLabel={`Delete ${file.name}`} onPress={() => removeSubjectFile(file.id)} style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }}><Text style={{ color: palette.muted, fontWeight: '700' }}>Delete</Text></Pressable></View>)}
        {!notes.trim() && !activeSubject.files.some((file) => file.role === 'source' || file.role === 'questions') && <View style={[styles.card, { alignItems: 'center', paddingVertical: 35, gap: 8 }]}><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>No sources yet</Text><Text style={[styles.body, { textAlign: 'center' }]}>Upload lecture material or add subject notes to get started.</Text></View>}
        {(!!notes.trim() || activeSubject.files.some((file) => file.role === 'source')) && <View testID="torch-block" style={[styles.card, { gap: 12 }]}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}><View><Text style={styles.label}>STUDY SOURCES</Text><Text style={{ color: palette.ink, fontSize: 19, fontWeight: '800', marginTop: 4 }}>What would you like to do?</Text></View><Pressable accessibilityRole="button" onPress={selectAllStudySources} style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>{selectedSourceIds.length === (activeSubject.files.filter((file) => file.role === 'source').length + (notes.trim() ? 1 : 0)) ? 'Clear selection' : 'Select all sources'}</Text></Pressable></View>
          <Text style={styles.small}>{selectedSourceIds.length ? `${selectedSourceIds.length} source${selectedSourceIds.length === 1 ? '' : 's'} selected` : 'Select one or more sources above.'}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton label="Flashcard review" onPress={() => beginStudyFormat('flashcards')} /><ActionButton secondary label="Q&A practice" onPress={() => beginStudyFormat('qa')} /><ActionButton secondary label="Read sources" onPress={() => beginStudyFormat('read')} /></View>
        </View>}
        <View style={{ gap: 8 }}><Pressable accessibilityRole="button" onPress={matchQuestions} style={{ alignSelf: 'flex-start', minHeight: 42, justifyContent: 'center', paddingHorizontal: 10 }}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>Review question-to-source matches ↓</Text></Pressable>{!!matches.length && <View style={[styles.card, { gap: 10 }]}><Text style={styles.label}>QUESTION LINKS · CHECK BEFORE STUDYING</Text>{nextStudyMatch && <Text style={styles.body}>Suggested next: {nextStudyMatch.question} — {nextStudyReason}</Text>}{matches.slice(0, 4).map((match, index) => <View key={`${index}-${match.question}`} style={{ borderTopWidth: 1, borderColor: palette.line, paddingTop: 8, gap: 4 }}><Text style={{ color: palette.ink, fontWeight: '700' }}>{match.question}</Text><Text style={styles.small}>{match.sourceLabel || 'No automatic source link'}{match.overlap ? ` · ${match.overlap} shared terms · verify this match` : ''}</Text></View>)}</View>}</View>
      </View>}
    </View> : null}
  </View>;

  const phaseStep = mode === 'deep' ? (phase === 'module' ? 1 : phase === 'diagnostic' ? 2 : phase === 'review' ? 3 : 4) : (phase === 'diagnostic' ? 1 : phase === 'review' ? 2 : 3);
  const phaseTotal = mode === 'deep' ? 4 : 3;
  const phaseDescription = phase === 'module' ? 'read the full module' : phase === 'diagnostic' ? (questionIndex === 0 ? 'start with recall' : `question ${questionIndex + 1} · recall check`) : phase === 'review' ? `question ${questionIndex + 1} · read the signal` : hasNextQuestion ? `question ${questionIndex + 1} · retrieve again` : 'retrieve again';
  const studyScreen = <View style={styles.content}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}><View><Text style={styles.label}>{mode.toUpperCase()} MODE · {displayModuleTitle.toUpperCase()}</Text><Text style={[styles.title, { marginTop: 7 }]}>{phase === 'module' ? 'Read the full module' : phase === 'diagnostic' ? 'Quick diagnostic' : phase === 'review' ? 'Targeted review' : 'Check what stuck'}</Text></View><ActionButton label="Exit session" secondary onPress={() => setPage('home')} /></View>
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>{Array.from({ length: phaseTotal }, (_, index) => <View key={index} style={{ height: 6, flex: 1, backgroundColor: index < phaseStep ? (index + 1 === phaseStep ? palette.yellow : palette.green) : palette.line, borderRadius: 5 }} />)}<Text style={styles.small}>{phaseStep} of {phaseTotal} · {phaseDescription}</Text></View>
    {studyFormat === 'read' ? <View style={{ gap: 14 }}>{selectedSourceIds.includes('__notes__') && !!notes.trim() && <View testID="torch-block" style={[styles.card, { gap: 8 }]}><Text style={styles.label}>SUBJECT NOTES</Text><Text style={{ color: palette.ink, fontSize: 15, lineHeight: 25 }}>{notes}</Text></View>}{selectedStudyFiles.map((file) => <View key={file.id} testID="torch-block" style={[styles.card, { gap: 10 }]}><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>{file.name}</Text>{lecturePreview(file)}<Text style={styles.label}>EXTRACTED MATERIAL</Text><Text style={{ color: palette.ink, fontSize: 14, lineHeight: 23 }}>{file.text || 'No selectable text was found. Use the original page preview above.'}</Text></View>)}</View> : studyFormat === 'flashcards' ? <View testID="torch-block" style={[styles.card, { minHeight: 300, justifyContent: 'space-between', gap: 18 }]}><View style={{ gap: 10 }}><Text style={styles.label}>FLASHCARD {questionIndex + 1} OF {Math.max(1, questionList.length)}</Text><Text style={{ color: palette.ink, fontSize: 23, lineHeight: 32, fontWeight: '800' }}>{questionList[questionIndex] || 'What is the most important idea in this source?'}</Text></View>{flashcardRevealed ? <View style={{ borderRadius: 12, borderWidth: 1, borderColor: 'rgba(245,216,94,0.3)', backgroundColor: 'rgba(245,216,94,0.08)', padding: 15, gap: 8 }}><Text style={styles.label}>SOURCE TO CHECK</Text><Text style={{ color: palette.ink, fontSize: 15, lineHeight: 24 }}>{matches.find((match) => match.question === questionList[questionIndex])?.passage || sourceParagraphs[questionIndex % Math.max(sourceParagraphs.length, 1)]?.text || 'Review the selected source and write the answer in your own words.'}</Text></View> : <Text style={styles.body}>Try to answer from memory, then reveal the linked source to check.</Text>}<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton label={flashcardRevealed ? (questionIndex < questionList.length - 1 ? 'Next card →' : 'Review again ↻') : 'Reveal answer'} onPress={() => { if (flashcardRevealed) { setQuestionIndex((index) => index < questionList.length - 1 ? index + 1 : 0); setFlashcardRevealed(false); } else setFlashcardRevealed(true); }} />{flashcardRevealed && <ActionButton secondary label="Finish cards" onPress={() => setPage('import')} />}</View></View> : phase === 'review' || phase === 'module' ? reviewPanel : quizPanel}
  </View>;

  const readyCount = history.filter((attempt) => attempt.outcome === 'correct' || attempt.outcome === 'self-rated-ready').length;
  const reviewCount = history.filter((attempt) => attempt.outcome === 'missed' || attempt.outcome === 'needs-review').length;
  const insightsScreen = <View style={styles.content}>
    <View><Text style={styles.label}>LEARN FROM YOUR SESSIONS</Text><Text style={[styles.title, { marginTop: 7 }]}>Progress, with context</Text><Text style={[styles.body, { marginTop: 7, maxWidth: 700 }]}>Your attempts are stored on this browser. Demo answers are scored against the key; answers to your own materials are tracked by your self-rating.</Text></View>
    <View testID="torch-block" style={[styles.card, { gap: 11 }]}><Text style={styles.label}>WORKSPACE BACKUP</Text><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>Keep a copy of your study space</Text><Text style={styles.body}>Download folders, notes, questions, progress, and saved original files as a private ZIP. Restore it in another browser to move your workspace.</Text><View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap' }}><ActionButton label={backupBusy ? 'Preparing backup…' : 'Download backup'} onPress={() => void exportWorkspaceBackup()} /><ActionButton secondary label="Restore from backup" onPress={() => setConfirmRestoreBackup(true)} /></View>{confirmRestoreBackup && <View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(245,216,94,0.4)', borderRadius: 12, padding: 12, backgroundColor: 'rgba(245,216,94,0.06)' }}><Text style={[styles.small, { flex: 1, minWidth: 220, color: '#fff2ad' }]}>Restoring replaces the folders and progress in this browser. Choose a Recall Loop ZIP backup to continue.</Text><ActionButton compact secondary label="Cancel" onPress={() => setConfirmRestoreBackup(false)} /><ActionButton compact label="Choose backup…" onPress={() => void restoreWorkspaceBackup()} /></View>}</View>
    <View testID="torch-block" style={[styles.card, { gap: 10 }]}><Text style={styles.label}>WORKSPACE SETTINGS</Text><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>Clear workspace</Text><Text style={styles.body}>Delete all folders, source files, questions, and saved progress from this browser.</Text><ActionButton secondary label="Clear workspace…" onPress={() => setConfirmClear(true)} />{confirmClear && <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: 'rgba(245,216,94,0.4)', borderRadius: 13, padding: 13, backgroundColor: 'rgba(245,216,94,0.06)' }}><Text style={[styles.body, { flex: 1, minWidth: 220, color: '#fff2ad' }]}>Are you sure? This cannot be undone.</Text><ActionButton compact secondary label="Cancel" onPress={() => setConfirmClear(false)} /><ActionButton compact label="Yes, clear everything" onPress={() => { clearWorkspace(); setConfirmClear(false); }} /></View>}</View>
    <View style={styles.row}>{[
      { label: 'TOTAL ATTEMPTS', value: String(attempted), note: 'saved in this workspace', tone: palette.blueSoft },
      { label: 'READY / CORRECT', value: String(readyCount), note: 'demo score or your self-rating', tone: palette.greenSoft },
      { label: 'NEEDS REVIEW', value: String(reviewCount), note: 'missed or marked uncertain', tone: palette.yellowSoft },
    ].map((card) => <View key={card.label} testID="torch-block" style={[styles.card, { flex: 1, minWidth: 190 }]}><Text style={styles.label}>{card.label}</Text><Text style={{ color: palette.ink, fontSize: 32, fontWeight: '900', marginTop: 13 }}>{card.value}</Text><Text style={[styles.small, { marginTop: 4 }]}>{card.note}</Text><View style={{ height: 5, backgroundColor: card.tone, borderRadius: 4, marginTop: 14 }} /></View>)}</View>
    <View testID="torch-block" style={[styles.card, { gap: 10 }]}><Text style={styles.label}>WHAT TO REVIEW NEXT</Text><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>{reviewCount ? 'Revisit the questions you marked for review' : 'Keep building your recall history'}</Text><Text style={styles.body}>{reviewCount ? `You have ${reviewCount} item${reviewCount === 1 ? '' : 's'} marked uncertain or missed. Start a session to retrieve them again and open their source passages.` : 'Once you answer a few questions, this page will surface your misses and self-rated uncertain topics here.'}</Text><ActionButton label={hasStudyContent ? 'Choose study mode' : 'Add study materials'} onPress={() => setPage(hasStudyContent ? 'modes' : 'import')} /></View>
    <View testID="torch-block" style={[styles.card, { gap: 10 }]}><Text style={styles.label}>RECENT RECALLS</Text>{history.length ? history.slice(0, 8).map((attempt) => { const positive = attempt.outcome === 'correct' || attempt.outcome === 'self-rated-ready'; const status = attempt.outcome === 'correct' ? 'Correct' : attempt.outcome === 'missed' ? 'Review' : attempt.outcome === 'self-rated-ready' ? 'Self-rated ready' : 'Needs review'; return <View key={attempt.id} style={{ borderTopWidth: 1, borderColor: palette.line, paddingTop: 10, gap: 4 }}><Text style={{ color: palette.ink, fontSize: 13, fontWeight: '700' }}>{attempt.question}</Text><Text style={[styles.small, { color: positive ? '#9fe1b5' : '#ffe49a' }]}>{status} · {attempt.mode} · {new Date(attempt.createdAt).toLocaleString()}</Text></View>; }) : <Text style={styles.body}>No answers yet. Your attempts will appear here after your first session.</Text>}</View>
  </View>;

  const body = page === 'import' ? importScreen : page === 'modes' ? lockInScreen : page === 'study' ? studyScreen : page === 'insights' ? insightsScreen : home;

  return <View style={styles.page}>
    <StatusBar style="light" />
    <View style={styles.shell}>
      <View style={styles.main}>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, backgroundColor: 'rgba(5,16,12,0.96)' }}><View style={[styles.inner, compact && { paddingHorizontal: 16 }]}>{fixedHeader}</View></View>
        <ScrollView ref={scrollRef} style={{ flex: 1, minHeight: 0, width: '100%' }} contentContainerStyle={{ flexGrow: 1, paddingTop: compact ? 124 : 78, paddingBottom: 48, position: 'relative' }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator nestedScrollEnabled>
          <View testID="scroll-backdrop" pointerEvents="none" style={styles.scrollBackdrop}>
            <BlurTargetView ref={ambientRef} pointerEvents="none" style={styles.ambience}><View style={styles.glowA} /><View style={styles.glowB} /><View style={styles.glowC} /></BlurTargetView>
            <BlurView pointerEvents="none" blurTarget={ambientRef} intensity={62} tint="dark" blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : 'none'} style={styles.backgroundBlur} />
          </View>
          {!!notice && <View style={[styles.inner, compact && { paddingHorizontal: 16 }]}><View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: 10, padding: 12, marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(143,203,166,0.28)', backgroundColor: 'rgba(24,70,44,0.72)' }}><Text style={[styles.small, { flex: 1, color: '#dcf5e5' }]}>{notice}</Text><Pressable accessibilityRole="button" onPress={() => setNotice('')} style={{ minHeight: 40, justifyContent: 'center', alignSelf: compact ? 'flex-end' : 'auto' }}><Text style={{ color: '#b8e8c7', fontSize: 12, fontWeight: '800' }}>Dismiss</Text></Pressable></View></View>}
          <View style={[styles.inner, compact && { paddingHorizontal: 16 }]}>{body}</View>
        </ScrollView>
      </View>
    </View>
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

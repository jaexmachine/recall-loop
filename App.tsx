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
import JSZip from 'jszip';
import mammoth from 'mammoth/mammoth.browser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

type Match = { question: string; passage: string; overlap: number; passageIndex: number | null; sourceLabel?: string; sourceFileId?: string; manual?: boolean };
type StudyAttempt = { id: string; question: string; mode: Pace; outcome: 'correct' | 'missed' | 'self-rated-ready' | 'needs-review'; createdAt: string };
type StudySegment = { label: string; text: string; sourceFileId?: string };
type StudyFile = { id: string; name: string; text: string; segments?: StudySegment[]; role: 'source' | 'questions' };
type OriginalDocument = { id: string; name: string; type: string; blob: Blob };
type SourceReader = { title: string; location: string; text: string };
type Subject = { id: string; name: string; notes: string; questionsText: string; files: StudyFile[] };
type SavedWorkspace = { version: 1 | 2; notes: string; questionsText: string; demoMaterial: boolean; matches: Match[]; attempted: number; correct: number; history: StudyAttempt[]; subjects: Subject[]; activeSubjectId: string | null; selectedSourceId: string | null; sourceScope: 'subject' | 'file' | 'notes' };
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
  brandMark: { width: 36, height: 36, borderRadius: 12, backgroundColor: '#153b29', borderWidth: 1, borderColor: 'rgba(143,203,166,0.55)', alignItems: 'center', justifyContent: 'center' },
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
  button: { backgroundColor: '#197447', paddingVertical: 13, paddingHorizontal: 16, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  secondaryButton: { borderWidth: 1, borderColor: palette.line, backgroundColor: 'rgba(255,255,255,0.06)', paddingVertical: 12, paddingHorizontal: 14, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 140, backgroundColor: 'rgba(5,14,11,0.62)', borderWidth: 1, borderColor: palette.line, borderRadius: 12, padding: 13, color: palette.ink, fontSize: 14, lineHeight: 21, textAlignVertical: 'top' },
});

function splitQuestions(raw: string) {
  return raw.split('\n').map((q) => q.trim().replace(/^\s*(?:\d+[.)]|[-*])\s*/, '')).filter(Boolean);
}

function draftPracticeQuestions(notes: string) {
  const sentences = notes.split(/\n\s*\n/).slice(1).join(' ').match(/[^.!?]+[.!?]?/g) || [];
  const drafts: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.length < 35) continue;
    let question = '';
    if (/final electron acceptor/i.test(sentence)) question = /electron transport chain/i.test(sentence) ? 'What is the final electron acceptor in the electron transport chain?' : 'What is the final electron acceptor?';
    else {
      const location = sentence.match(/^(.+?)\s+(happens|occurs|takes place)\s+(in|at|within)\s+(.+?)[.!?]?$/i);
      if (location) {
        const [, subject, verb] = location;
        const baseVerb = verb.toLowerCase() === 'happens' ? 'happen' : verb.toLowerCase() === 'occurs' ? 'occur' : 'take place';
        question = `Where does ${subject.trim().toLowerCase()} ${baseVerb}?`;
      } else if (/most of the (?:ATP|energy)/i.test(sentence)) question = 'Which stage produces most of the ATP during cellular respiration?';
      else if (/net\s+(?:gain|yield)\s+of/i.test(sentence)) question = 'What is the net ATP yield described in this passage?';
      else {
        const releaseAndProduce = sentence.match(/^(.{3,45}?)\s+releases?\s+.+?\s+and\s+produces?\s+.+[.!?]?$/i);
        if (releaseAndProduce) question = `What does ${releaseAndProduce[1].trim().toLowerCase()} release and produce?`;
        else {
          const production = sentence.match(/^(.{3,45}?)\s+(?:produces|produce|makes|make|generates|generate)\s+(.+?)[.!?]?$/i);
          if (production) question = `What does ${production[1].trim().toLowerCase()} produce?`;
        }
      }
    }
    if (question && !drafts.includes(question)) drafts.push(question);
    if (drafts.length >= 15) break;
  }
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
  if (extension === 'pptx') {
    const archive = await JSZip.loadAsync(data);
    const slideNames = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
    const slides: StudySegment[] = [];
    for (const [index, name] of slideNames.entries()) {
      const xml = await archive.file(name)?.async('text');
      if (!xml) continue;
      const document = new DOMParser().parseFromString(xml, 'application/xml');
      const paragraphs = [...document.getElementsByTagName('a:p')].map((paragraph) => [...paragraph.getElementsByTagName('a:t')].map((node) => node.textContent || '').join('').trim()).filter(Boolean);
      if (paragraphs.length) slides.push({ label: `${file.name} · slide ${index + 1}`, text: paragraphs.join('\n\n') });
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
  throw new Error('Choose a PDF, DOCX, PPTX, TXT, or Markdown file.');
}

function ActionButton({ label, onPress, secondary = false, compact = false }: { label: string; onPress: () => void; secondary?: boolean; compact?: boolean }) {
  return <Pressable onPress={onPress} style={[secondary ? styles.secondaryButton : styles.button, compact && { paddingVertical: 9, paddingHorizontal: 12 }]}><Text style={{ color: secondary ? palette.ink : '#fff', fontWeight: '700', fontSize: compact ? 12 : 14 }}>{label}</Text></Pressable>;
}

export default function App() {
  const { width } = useWindowDimensions();
  const wide = width > 900;
  const ambientRef = useRef<React.ComponentRef<typeof View>>(null);
  const [page, setPage] = useState<'home' | 'import' | 'study' | 'insights'>('home');
  const [notes, setNotes] = useState('');
  const [questionsText, setQuestionsText] = useState('');
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [activeSubjectId, setActiveSubjectId] = useState<string | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null);
  const [sourceReader, setSourceReader] = useState<SourceReader | null>(null);
  const [sourceScope, setSourceScope] = useState<'subject' | 'file' | 'notes'>('subject');
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
            setSourceScope(saved.sourceScope === 'file' ? 'file' : saved.sourceScope === 'notes' ? 'notes' : 'subject');
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
      const saved: SavedWorkspace = { version: 2, notes, questionsText, demoMaterial, matches, attempted, correct, history, subjects: savedSubjects, activeSubjectId, selectedSourceId, sourceScope };
      window.localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch {
      setNotice('Browser storage is full or unavailable. Remove a large file or shorten your materials, then try again.');
    }
  }, [storageReady, notes, questionsText, demoMaterial, matches, attempted, correct, history, subjects, activeSubjectId, selectedSourceId, sourceScope]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const style = document.createElement('style');
    style.textContent = `
      @media (hover: hover) and (pointer: fine) {
        [data-testid="torch-block"] { position: relative; isolation: isolate; transition: box-shadow 180ms ease, transform 180ms ease, background-image 180ms ease; }
        [data-testid="torch-block"]::before { content: ''; position: absolute; inset: 0; z-index: 1; padding: 1.5px; border-radius: inherit; pointer-events: none; opacity: 0; background: radial-gradient(120px circle at var(--torch-x, 50%) var(--torch-y, 50%), rgba(220,255,232,1), rgba(126,238,164,.62) 30%, rgba(126,238,164,.14) 58%, transparent 78%); -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask-composite: exclude; transition: opacity 160ms ease; }
        [data-testid="torch-block"].torch-active { background-image: radial-gradient(175px circle at var(--torch-x, 50%) var(--torch-y, 50%), rgba(196,255,216,.23), rgba(106,222,153,.08) 40%, transparent 72%); box-shadow: 0 12px 34px rgba(0,0,0,.28); transform: translateY(-1px); }
        [data-testid="torch-block"].torch-active::before { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) { [data-testid="torch-block"] { transition: none !important; } }
    `;
    document.head.appendChild(style);
    const move = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-testid="torch-block"]') : null;
      document.querySelectorAll<HTMLElement>('[data-testid="torch-block"].torch-active').forEach((card) => { if (card !== target) card.classList.remove('torch-active'); });
      if (!target) return;
      const bounds = target.getBoundingClientRect();
      target.style.setProperty('--torch-x', `${event.clientX - bounds.left}px`);
      target.style.setProperty('--torch-y', `${event.clientY - bounds.top}px`);
      target.classList.add('torch-active');
    };
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) document.querySelectorAll('[data-testid="torch-block"].torch-active').forEach((card) => card.classList.remove('torch-active')); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerout', leave);
    return () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerout', leave); style.remove(); };
  }, []);

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
  const studySourceText = sourceScope === 'file' && selectedSource ? selectedSource.text : sourceScope === 'notes' ? notes : [notes, ...(activeSubject?.files.filter((file) => file.role === 'source').map((file) => file.text) || [])].filter(Boolean).join('\n\n');
  const studySourceSegments = sourceScope === 'file' && selectedSource
    ? fileSegments(selectedSource)
    : sourceScope === 'notes'
      ? asStudySegments(notes)
      : [...asStudySegments(notes), ...(activeSubject?.files.filter((file) => file.role === 'source').flatMap(fileSegments) || [])];
  const questionList = useMemo(() => splitQuestions(questionsText), [questionsText]);
  const sourceParagraphs = studySourceSegments.flatMap((segment) => segment.text.split(/\n\s*\n/).map((text) => ({ text: text.trim(), sourceLabel: segment.label }))).filter((item) => item.text);
  const hasStudyContent = studySourceText.trim().length > 0 || questionList.length > 0;
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
      picker.type = 'file'; picker.accept = '.pdf,.docx,.pptx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown';
      const file = await new Promise<File | null>((resolve) => {
        picker.onchange = () => resolve(picker.files?.[0] || null);
        picker.click();
      });
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) throw new Error('Files must be 20 MB or smaller.');
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const extracted = (await extractDocumentText(file)).map((segment) => ({ ...segment, sourceFileId: fileId }));
      const content = extracted.map((segment) => segment.text).join('\n\n').trim();
      if (!content) throw new Error('No selectable text was found. Scanned PDFs need OCR before they can be used.');
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
      notify(`${file.name} was added to ${activeSubject.name}. The text was extracted in this browser.`);
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
      const workspace: SavedWorkspace = { version: 2, notes, questionsText, demoMaterial, matches, attempted, correct, history, subjects: backupSubjects, activeSubjectId, selectedSourceId, sourceScope };
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
      setSourceScope(incoming.sourceScope === 'file' || incoming.sourceScope === 'notes' ? incoming.sourceScope : 'subject');
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
    setActiveSubjectId(created.id); setNotes(''); setQuestionsText(''); setMatches([]); setSelectedSourceId(null); setPreviewSourceId(null); setSourceScope('subject'); setDemoMaterial(false); setNewSubjectName('');
    notify(`${name} is ready. Add notes or upload source files to this subject.`);
  };

  const selectSubject = (id: string) => {
    const next = subjects.find((subject) => subject.id === id);
    if (!next) return;
    setSubjects((previous) => previous.map((subject) => subject.id === activeSubjectId ? { ...subject, notes, questionsText } : subject));
    setActiveSubjectId(next.id); setNotes(next.notes); setQuestionsText(next.questionsText); setMatches(buildMatches([...asStudySegments(next.notes), ...next.files.filter((file) => file.role === 'source').flatMap(fileSegments)], splitQuestions(next.questionsText)));
    setSelectedSourceId(null); setPreviewSourceId(null); setSourceScope('subject'); setDemoMaterial(false);
  };

  const openSubject = (id: string) => {
    if (id !== activeSubjectId) selectSubject(id);
    setFolderOpen(true);
  };

  const setSourceToFile = (file: StudyFile) => {
    setSelectedSourceId(file.id); setSourceScope('file'); setMatches(buildMatches(fileSegments(file), questionList));
  };

  const activateSubjectFile = (file: StudyFile) => {
    if (file.role === 'questions') {
      setQuestionsText(file.text);
      notify(`${file.name} loaded into the questions editor.`);
      return;
    }
    setSourceToFile(file);
    setPreviewSourceId((previous) => previous === file.id ? null : file.id);
  };

  const removeSubjectFile = (fileId: string) => {
    const updatedFiles = activeSubject?.files.filter((file) => file.id !== fileId) || [];
    if (Platform.OS === 'web') void deleteOriginalDocument(fileId).catch(() => undefined);
    setSubjects((previous) => previous.map((subject) => subject.id === activeSubjectId ? { ...subject, files: updatedFiles } : subject));
    if (previewSourceId === fileId) setPreviewSourceId(null);
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
    setNotes(''); setQuestionsText(''); setMatches([]); setAttempted(0); setCorrect(0); setHistory([]);
    setDemoMaterial(false); setSubjects([]); setActiveSubjectId(null); setFolderOpen(false); setSelectedSourceId(null); setPreviewSourceId(null); setSourceReader(null); setSourceScope('subject'); setNotice('Your workspace is empty. Create a subject and add notes whenever you’re ready.');
    if (Platform.OS === 'web') void clearOriginalDocuments().catch(() => undefined);
    setPage('home'); setQuestionIndex(0); setAnswer(null); setAnswerDraft('');
  };

  const startStudy = (pace: Pace = mode) => {
    setMode(pace); setSelectedPace(pace); setQuestionIndex(0); setPhase(pace === 'deep' ? 'module' : 'diagnostic'); setAnswer(null); setAnswerDraft(''); setPage('study');
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
    { id: 'import' as const, icon: '▤', label: 'Materials' },
    { id: 'insights' as const, icon: '◴', label: 'Progress' },
  ];

  const brand = <Pressable onPress={() => setPage('home')} style={[styles.brandRow, { marginBottom: 0, marginRight: wide ? 0 : 'auto', transform: [{ translateY: 22 }] }]}><View style={styles.brandMark}>
      <View style={{ width: 18, height: 22, borderRadius: 4, backgroundColor: '#f4f3df', alignItems: 'center', paddingTop: 5, gap: 3 }}>
        <View style={{ width: 11, height: 3, borderRadius: 2, backgroundColor: palette.yellow }} />
        <View style={{ width: 11, height: 2, borderRadius: 2, backgroundColor: '#80ae8d' }} />
        <View style={{ width: 8, height: 2, borderRadius: 2, backgroundColor: '#80ae8d', alignSelf: 'flex-start', marginLeft: 3 }} />
      </View>
      <Text style={{ position: 'absolute', right: 0, bottom: -1, color: '#94dfa9', fontSize: 16, lineHeight: 18, fontWeight: '900' }}>↶</Text>
    </View><Text style={{ color: '#fff', fontSize: 20, fontWeight: '800' }}>Recall Loop</Text></Pressable>
  const registerButton = <Pressable accessibilityRole="button" style={{ paddingVertical: 10, paddingHorizontal: 20, borderRadius: 22, borderWidth: 1, borderColor: 'rgba(210,235,227,0.20)', backgroundColor: 'rgba(5,16,12,0.94)', transform: [{ translateY: 22 }] }}><Text style={{ color: palette.ink, fontWeight: '700', fontSize: 13 }}>Register</Text></Pressable>;
  const pinnedNav = <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
    {navItems.map((item) => <Pressable key={item.id} onPress={() => setPage(item.id)} style={{ paddingVertical: 9, paddingHorizontal: 11, borderRadius: 18, backgroundColor: page === item.id ? 'rgba(33,129,91,0.40)' : 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: page === item.id ? 'rgba(90,210,141,0.28)' : 'transparent' }}><Text style={{ color: page === item.id ? '#eaffef' : '#b9c5c0', fontWeight: '700', fontSize: 12 }}>{item.label}</Text></Pressable>)}
  </View>;
  const fixedHeader = <View style={[styles.header, { flexWrap: 'wrap', gap: 12 }]}>
    {brand}
    {wide && <View style={{ position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', pointerEvents: 'box-none' }}>{pinnedNav}</View>}
    {!wide && pinnedNav}
    <View style={{ marginLeft: 'auto' }}>{registerButton}</View>
  </View>;

  const paceOptions: { id: Pace; icon: string; title: string; time: string; description: string; steps: string }[] = [
    { id: 'cram', icon: '⚡︎', title: 'Cram', time: '10 min', description: 'Find the gap fast. Test first, jump straight to the source, and retry what you missed.', steps: 'Quick recall · One key source · Retry' },
    { id: 'steady', icon: '↗', title: 'Steady', time: '20 min', description: 'Work through your questions in a repeatable recall → review → retry loop.', steps: 'Recall · Focused reading · All questions' },
    { id: 'deep', icon: '◎', title: 'Deep', time: '35 min', description: 'Read the full module first, then check recall and work through every question.', steps: 'Full module · Recall · Follow-up' },
  ];
  const selectedOption = paceOptions.find((option) => option.id === selectedPace)!;
  const flowSteps = [
    { tag: 'A · RECALL', title: 'Try from memory first', text: 'Answer a question before opening your notes. This shows what you already know.' },
    { tag: 'B · REVIEW', title: 'Follow the source', text: 'If you miss a question, open its matched passage and check the evidence.' },
    { tag: 'C · RETRY', title: 'Check what stuck', text: 'Answer again, then use Progress to see what needs another review.' },
  ];
  const materialsSection = <View testID="scroll-reveal" style={{ paddingVertical: 64, borderTopWidth: 1, borderColor: palette.line, gap: 18 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
      <View style={{ gap: 7 }}><Text style={[styles.label, { color: '#8fcba6' }]}>STEP 02 · YOUR MATERIALS</Text><Text style={[styles.title, { fontSize: 30 }]}>{hasStudyContent ? 'Review your study set.' : 'Add your study materials.'}</Text></View>
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
    <View testID="scroll-reveal" style={{ minHeight: 590, justifyContent: 'center', alignItems: 'center', paddingVertical: 56, gap: 20 }}>
      <View style={{ maxWidth: 780, alignItems: 'center', gap: 13 }}><Text style={[styles.label, { color: '#8fcba6', letterSpacing: 1.8 }]}>STEP 01 · CHOOSE YOUR PACE</Text><Text style={[styles.title, { fontSize: wide ? 48 : 36, lineHeight: wide ? 58 : 44, textAlign: 'center' }]}>What do you want to do?</Text><Text style={[styles.body, { fontSize: 16, lineHeight: 25, textAlign: 'center', maxWidth: 610 }]}>Choose a study pace below, then add your notes and practice questions to begin.</Text></View>
      <View style={[styles.row, { width: '100%', maxWidth: 1000, marginTop: 16, justifyContent: 'center' }]}>{paceOptions.map((option) => { const active = selectedPace === option.id; return <Pressable key={option.id} onPress={() => setSelectedPace(option.id)} testID="torch-block" style={[styles.card, { flex: 1, minWidth: 240, maxWidth: 320, minHeight: 255, gap: 13, borderColor: palette.line, backgroundColor: active ? 'rgba(24,70,44,0.78)' : 'rgba(17,31,26,0.70)', padding: 20 }]}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={{ fontSize: 22, color: active ? '#9ff0ba' : palette.yellow }}>{option.icon}</Text><Text style={{ color: active ? '#d9ffe2' : palette.muted, fontSize: 11, fontWeight: '800' }}>{option.time.toUpperCase()}</Text></View><Text style={{ color: palette.ink, fontSize: 22, fontWeight: '800' }}>{option.title}</Text><Text style={[styles.body, { flex: 1 }]}>{option.description}</Text><Text style={{ color: active ? '#b8e8c7' : '#85948e', fontSize: 11, lineHeight: 17, fontWeight: '700' }}>{option.steps}</Text></Pressable>; })}</View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}><ActionButton label={hasStudyContent ? `Start ${selectedOption.time} ${selectedOption.title.toLowerCase()} session →` : 'Add materials to begin →'} onPress={() => hasStudyContent ? startStudy(selectedPace) : setPage('import')} /><Pressable onPress={() => setPage('import')} style={{ padding: 11 }}><Text style={{ color: '#b9c5c0', fontWeight: '700' }}>{hasStudyContent ? 'Choose materials' : 'Open My materials'}</Text></Pressable></View>
      <Text style={[styles.small, { textAlign: 'center' }]}>{hasStudyContent ? `${displayModuleTitle} · ${questionList.length} questions · ${linkedCount} source links to verify` : 'No notes or questions saved yet'}</Text>
    </View>

    {materialsSection}
    {studyFlowSection}
    <Text style={[styles.small, { textAlign: 'center', paddingVertical: 18 }]}>Recall Loop · v0.1 · {demoMaterial ? 'sample content' : 'local workspace'}</Text>
  </View>;

  const importScreen = <View style={styles.content}>
    <View><Text style={styles.label}>{folderOpen ? 'SUBJECT FOLDER' : 'YOUR MATERIALS'}</Text><Text style={[styles.title, { marginTop: 7 }]}>{folderOpen && activeSubject ? activeSubject.name : 'My materials'}</Text><Text style={[styles.body, { marginTop: 7, maxWidth: 760 }]}>{folderOpen ? 'Add source notes or files, add your questions, then match them to evidence before you start a session.' : 'Create a folder for each class or topic. Open it to add notes, upload files, and choose what you want to study.'}</Text></View>

    {!folderOpen ? <View style={{ gap: 16 }}>
      <View testID="torch-block" style={[styles.card, { gap: 14 }]}>
        <View><Text style={styles.label}>STEP 01 · SUBJECT FOLDERS</Text><Text style={{ color: palette.ink, fontSize: 19, fontWeight: '800', marginTop: 5 }}>Create a subject folder</Text></View>
        <View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}><TextInput value={newSubjectName} onChangeText={setNewSubjectName} placeholder="e.g. Physics" placeholderTextColor="#9ba6ad" accessibilityLabel="New subject folder name" style={[styles.input, { minHeight: 45, flex: 1, minWidth: 210 }]} onSubmitEditing={createSubject} /><ActionButton label="Create folder" onPress={createSubject} /></View>
      </View>
      {!!subjects.length && <View style={{ gap: 12 }}><Text style={styles.label}>FOLDERS · {subjects.length}</Text><View style={styles.row}>{subjects.map((subject) => <Pressable key={subject.id} accessibilityRole="button" accessibilityLabel={`Open ${subject.name} folder`} onPress={() => openSubject(subject.id)} testID="torch-block" style={[styles.card, { flex: 1, minWidth: 220, maxWidth: 330, minHeight: 144, gap: 10, padding: 17, alignItems: 'flex-start', justifyContent: 'space-between' }]}><View style={{ gap: 8 }}><View style={{ width: 31, height: 23, borderRadius: 5, backgroundColor: 'rgba(245,216,94,0.18)', borderWidth: 1, borderColor: 'rgba(245,216,94,0.38)', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.yellow, fontSize: 12, fontWeight: '900' }}>▰</Text></View><Text style={{ color: palette.ink, fontSize: 17, fontWeight: '800' }}>{subject.name}</Text><Text style={styles.small}>{subject.files.length} {subject.files.length === 1 ? 'file' : 'files'}</Text></View><Text style={{ color: '#9fe1b5', fontSize: 12, fontWeight: '800' }}>Open folder →</Text></Pressable>)}</View></View>}
    </View> : activeSubject ? <View style={{ gap: 16 }}>
      <Pressable onPress={() => { setFolderOpen(false); setConfirmClear(false); }} style={{ alignSelf: 'flex-start', paddingVertical: 5, paddingRight: 10 }}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>← All subject folders</Text></Pressable>
      <View style={styles.row}>
        <View testID="torch-block" style={[styles.card, { flex: 1, minWidth: 290, gap: 12 }]}>
          <View style={{ flexDirection: 'column', gap: 10, alignItems: 'flex-start', width: '100%' }}><View><Text style={styles.label}>STEP 02 · SOURCE NOTES & FILES</Text><Text style={{ fontSize: 17, color: palette.ink, fontWeight: '800', marginTop: 5 }}>Subject notes</Text></View><ActionButton compact secondary label="Upload PDF / DOCX / PPTX" onPress={() => importFile('module')} /></View>
          <TextInput value={notes} onChangeText={(value) => { setNotes(value); setDemoMaterial(false); }} multiline placeholder="Paste notes for this subject…" placeholderTextColor="#9ba6ad" style={styles.input} />
        </View>
        <View testID="torch-block" style={[styles.card, { flex: 1, minWidth: 290, gap: 12 }]}>
          <View style={{ flexDirection: 'column', gap: 10, alignItems: 'flex-start', width: '100%' }}><View><Text style={styles.label}>STEP 03 · FORMATIVE QUESTIONS</Text><Text style={{ fontSize: 17, color: palette.ink, fontWeight: '800', marginTop: 5 }}>What you were asked</Text></View><ActionButton compact secondary label="Upload question file" onPress={() => importFile('questions')} /></View>
          <TextInput value={questionsText} onChangeText={(value) => { setQuestionsText(value); setDemoMaterial(false); }} multiline placeholder="One question per line…" placeholderTextColor="#9ba6ad" style={styles.input} />
        </View>
      </View>
      <View testID="torch-block" style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}><View><Text style={styles.label}>STEP 04 · STUDY SCOPE · {activeSubject.name.toUpperCase()}</Text><Text style={{ color: palette.ink, fontSize: 17, fontWeight: '800', marginTop: 4 }}>Choose what to study</Text></View><View style={{ flexDirection: 'row', gap: 7, flexWrap: 'wrap' }}><ActionButton compact secondary label="Whole subject" onPress={() => { setSourceScope('subject'); setSelectedSourceId(null); setMatches(buildMatches([...asStudySegments(notes), ...activeSubject.files.filter((file) => file.role === 'source').flatMap(fileSegments)], questionList)); }} />{!!notes.trim() && <ActionButton compact secondary label="Notes only" onPress={() => { setSourceScope('notes'); setSelectedSourceId(null); setMatches(buildMatches(asStudySegments(notes), questionList)); }} />}{selectedSource && <ActionButton compact secondary label="Selected file" onPress={() => setSourceToFile(selectedSource)} />}</View></View>
        {!!activeSubject.files.length ? activeSubject.files.map((file) => <View key={file.id} style={{ borderTopWidth: 1, borderColor: palette.line, paddingTop: 9, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}><View style={{ flex: 1, minWidth: 120, paddingVertical: 5 }}><Text style={{ color: file.id === selectedSourceId ? '#d9ffe2' : palette.ink, fontWeight: '700' }}>{file.id === selectedSourceId ? '● ' : ''}{file.name}</Text><Text style={styles.small}>{file.role === 'source' ? 'Source material' : 'Formative questions'}</Text></View><ActionButton compact secondary label={file.role === 'source' ? (previewSourceId === file.id ? 'Hide preview' : 'Preview & select') : 'Load questions'} onPress={() => activateSubjectFile(file)} /><Pressable accessibilityRole="button" onPress={() => removeSubjectFile(file.id)}><Text style={{ color: palette.muted, fontWeight: '800', padding: 8 }}>Remove</Text></Pressable></View>
          {file.role === 'source' && previewSourceId === file.id && <View style={{ borderRadius: 10, borderWidth: 1, borderColor: palette.line, padding: 12, backgroundColor: 'rgba(5,14,11,0.42)', gap: 9 }}><Text style={styles.label}>EXTRACTED TEXT PREVIEW</Text>{fileSegments(file).slice(0, 5).map((segment, index) => <View key={`${segment.label}-${index}`} style={{ gap: 4 }}><Text style={{ color: '#b8e8c7', fontSize: 12, fontWeight: '800' }}>{segment.label}</Text><Text selectable numberOfLines={3} style={{ color: palette.ink, fontSize: 13, lineHeight: 20 }}>{segment.text}</Text></View>)}<Text style={styles.small}>This file is selected as the current study source.</Text></View>}
        </View>) : <Text style={styles.small}>No files in this folder yet.</Text>}
      </View>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}><ActionButton label={busy ? 'Reading file…' : 'STEP 05 · Match questions to source'} onPress={matchQuestions} /><ActionButton label="Draft questions from source" secondary onPress={generateQuestions} /><ActionButton label="Clear workspace" secondary onPress={() => setConfirmClear(true)} /></View>
      {confirmClear && <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: 'rgba(245,216,94,0.4)', borderRadius: 13, padding: 13, backgroundColor: 'rgba(245,216,94,0.06)' }}><Text style={[styles.body, { flex: 1, minWidth: 220, color: '#fff2ad' }]}>Are you sure? This deletes all subject folders, uploaded text, questions, and progress saved in this browser.</Text><ActionButton compact secondary label="Cancel" onPress={() => setConfirmClear(false)} /><ActionButton compact label="Yes, clear everything" onPress={() => { clearWorkspace(); setConfirmClear(false); }} /></View>}
      <Text style={styles.small}>PDF, DOCX, PPTX, TXT, and Markdown text is extracted locally in your browser. Scanned PDFs need OCR. Matching and question drafts use transparent local rules, not a connected AI service.</Text>
      <View testID="torch-block" style={[styles.card, { gap: 14 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}><View><Text style={styles.label}>STEP 06 · MATCH AND VERIFY</Text><Text style={{ color: palette.ink, fontSize: 19, fontWeight: '800', marginTop: 5 }}>Check the evidence before studying</Text></View><View style={{ backgroundColor: palette.yellowSoft, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6 }}><Text style={{ color: '#705d00', fontSize: 11, fontWeight: '800' }}>KEYWORD BASELINE</Text></View></View>
        {matches.map((match, i) => <View key={`${i}-${match.question}`} style={{ borderTopWidth: 1, borderColor: palette.line, paddingTop: 12, gap: 7 }}><Text style={{ color: palette.ink, fontWeight: '800', fontSize: 14 }}>Q{i + 1}. {match.question}</Text><View style={{ backgroundColor: match.overlap ? 'rgba(245,216,94,0.10)' : 'rgba(255,255,255,0.04)', borderLeftWidth: match.overlap ? 3 : 1, borderLeftColor: match.overlap ? 'rgba(245,216,94,0.76)' : palette.line, borderRadius: 9, padding: 11 }}><Text style={{ color: palette.ink, fontSize: 13, lineHeight: 19 }}>{match.passage}</Text></View><Text style={styles.small}>{match.sourceLabel ? `${match.sourceLabel} · ` : ''}{match.manual ? (match.passageIndex ? 'Manual source · verify this passage' : 'Source link cleared · choose a passage or review manually') : match.overlap ? `Suggested source · ${match.overlap} shared key term${match.overlap === 1 ? '' : 's'} · please verify` : 'No automatic link · manual review needed'}</Text>{findMatchSourceFile(match) && <ActionButton compact secondary label="Open source location →" onPress={() => void openSourceLocation(match)} />}{sourceOptions.length > 0 && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}><ActionButton compact secondary label="Previous source" onPress={() => stepMatchSource(match.question, -1)} /><ActionButton compact secondary label="Next source" onPress={() => stepMatchSource(match.question, 1)} />{match.passageIndex !== null && <ActionButton compact secondary label="Clear link" onPress={() => clearMatchSource(match.question)} />}</View>}</View>)}
        {!matches.length && <Text style={styles.body}>Add a few questions, then match them to see suggested passages.</Text>}
      </View>
    </View> : null}
  </View>;

  const phaseStep = mode === 'deep' ? (phase === 'module' ? 1 : phase === 'diagnostic' ? 2 : phase === 'review' ? 3 : 4) : (phase === 'diagnostic' ? 1 : phase === 'review' ? 2 : 3);
  const phaseTotal = mode === 'deep' ? 4 : 3;
  const phaseDescription = phase === 'module' ? 'read the full module' : phase === 'diagnostic' ? (questionIndex === 0 ? 'start with recall' : `question ${questionIndex + 1} · recall check`) : phase === 'review' ? `question ${questionIndex + 1} · read the signal` : hasNextQuestion ? `question ${questionIndex + 1} · retrieve again` : 'retrieve again';
  const studyScreen = <View style={styles.content}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}><View><Text style={styles.label}>{mode.toUpperCase()} MODE · {displayModuleTitle.toUpperCase()}</Text><Text style={[styles.title, { marginTop: 7 }]}>{phase === 'module' ? 'Read the full module' : phase === 'diagnostic' ? 'Quick diagnostic' : phase === 'review' ? 'Targeted review' : 'Check what stuck'}</Text></View><ActionButton label="Exit session" secondary onPress={() => setPage('home')} /></View>
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>{Array.from({ length: phaseTotal }, (_, index) => <View key={index} style={{ height: 6, flex: 1, backgroundColor: index < phaseStep ? (index + 1 === phaseStep ? palette.yellow : palette.green) : palette.line, borderRadius: 5 }} />)}<Text style={styles.small}>{phaseStep} of {phaseTotal} · {phaseDescription}</Text></View>
    {phase === 'review' || phase === 'module' ? reviewPanel : quizPanel}
  </View>;

  const readyCount = history.filter((attempt) => attempt.outcome === 'correct' || attempt.outcome === 'self-rated-ready').length;
  const reviewCount = history.filter((attempt) => attempt.outcome === 'missed' || attempt.outcome === 'needs-review').length;
  const insightsScreen = <View style={styles.content}>
    <View><Text style={styles.label}>LEARN FROM YOUR SESSIONS</Text><Text style={[styles.title, { marginTop: 7 }]}>Progress, with context</Text><Text style={[styles.body, { marginTop: 7, maxWidth: 700 }]}>Your attempts are stored on this browser. Demo answers are scored against the key; answers to your own materials are tracked by your self-rating.</Text></View>
    <View testID="torch-block" style={[styles.card, { gap: 11 }]}><Text style={styles.label}>WORKSPACE BACKUP</Text><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>Keep a copy of your study space</Text><Text style={styles.body}>Download folders, notes, questions, progress, and saved original files as a private ZIP. Restore it in another browser to move your workspace.</Text><View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap' }}><ActionButton label={backupBusy ? 'Preparing backup…' : 'Download backup'} onPress={() => void exportWorkspaceBackup()} /><ActionButton secondary label="Restore from backup" onPress={() => setConfirmRestoreBackup(true)} /></View>{confirmRestoreBackup && <View style={{ flexDirection: 'row', gap: 9, flexWrap: 'wrap', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(245,216,94,0.4)', borderRadius: 12, padding: 12, backgroundColor: 'rgba(245,216,94,0.06)' }}><Text style={[styles.small, { flex: 1, minWidth: 220, color: '#fff2ad' }]}>Restoring replaces the folders and progress in this browser. Choose a Recall Loop ZIP backup to continue.</Text><ActionButton compact secondary label="Cancel" onPress={() => setConfirmRestoreBackup(false)} /><ActionButton compact label="Choose backup…" onPress={() => void restoreWorkspaceBackup()} /></View>}</View>
    <View style={styles.row}>{[
      { label: 'TOTAL ATTEMPTS', value: String(attempted), note: 'saved in this workspace', tone: palette.blueSoft },
      { label: 'READY / CORRECT', value: String(readyCount), note: 'demo score or your self-rating', tone: palette.greenSoft },
      { label: 'NEEDS REVIEW', value: String(reviewCount), note: 'missed or marked uncertain', tone: palette.yellowSoft },
    ].map((card) => <View key={card.label} testID="torch-block" style={[styles.card, { flex: 1, minWidth: 190 }]}><Text style={styles.label}>{card.label}</Text><Text style={{ color: palette.ink, fontSize: 32, fontWeight: '900', marginTop: 13 }}>{card.value}</Text><Text style={[styles.small, { marginTop: 4 }]}>{card.note}</Text><View style={{ height: 5, backgroundColor: card.tone, borderRadius: 4, marginTop: 14 }} /></View>)}</View>
    <View testID="torch-block" style={[styles.card, { gap: 10 }]}><Text style={styles.label}>WHAT TO REVIEW NEXT</Text><Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>{reviewCount ? 'Revisit the questions you marked for review' : 'Keep building your recall history'}</Text><Text style={styles.body}>{reviewCount ? `You have ${reviewCount} item${reviewCount === 1 ? '' : 's'} marked uncertain or missed. Start a session to retrieve them again and open their source passages.` : 'Once you answer a few questions, this page will surface your misses and self-rated uncertain topics here.'}</Text><ActionButton label="Return to study" onPress={startStudy} /></View>
    <View testID="torch-block" style={[styles.card, { gap: 10 }]}><Text style={styles.label}>RECENT RECALLS</Text>{history.length ? history.slice(0, 8).map((attempt) => { const positive = attempt.outcome === 'correct' || attempt.outcome === 'self-rated-ready'; const status = attempt.outcome === 'correct' ? 'Correct' : attempt.outcome === 'missed' ? 'Review' : attempt.outcome === 'self-rated-ready' ? 'Self-rated ready' : 'Needs review'; return <View key={attempt.id} style={{ borderTopWidth: 1, borderColor: palette.line, paddingTop: 10, gap: 4 }}><Text style={{ color: palette.ink, fontSize: 13, fontWeight: '700' }}>{attempt.question}</Text><Text style={[styles.small, { color: positive ? '#9fe1b5' : '#ffe49a' }]}>{status} · {attempt.mode} · {new Date(attempt.createdAt).toLocaleString()}</Text></View>; }) : <Text style={styles.body}>No answers yet. Your attempts will appear here after your first session.</Text>}</View>
  </View>;

  const body = page === 'import' ? importScreen : page === 'study' ? studyScreen : page === 'insights' ? insightsScreen : home;

  return <View style={styles.page}>
    <StatusBar style="light" />
    <View style={styles.shell}>
      <View style={styles.main}>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, backgroundColor: 'rgba(5,16,12,0.96)' }}><View style={styles.inner}>{fixedHeader}</View></View>
        <ScrollView style={{ flex: 1, minHeight: 0, width: '100%' }} contentContainerStyle={{ flexGrow: 1, paddingTop: 78, paddingBottom: 48, position: 'relative' }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator nestedScrollEnabled>
          <View testID="scroll-backdrop" pointerEvents="none" style={styles.scrollBackdrop}>
            <BlurTargetView ref={ambientRef} pointerEvents="none" style={styles.ambience}><View style={styles.glowA} /><View style={styles.glowB} /><View style={styles.glowC} /></BlurTargetView>
            <BlurView pointerEvents="none" blurTarget={ambientRef} intensity={62} tint="dark" blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : 'none'} style={styles.backgroundBlur} />
          </View>
          {!!notice && <View style={styles.inner}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(143,203,166,0.28)', backgroundColor: 'rgba(24,70,44,0.72)' }}><Text style={[styles.small, { flex: 1, color: '#dcf5e5' }]}>{notice}</Text><Pressable accessibilityRole="button" onPress={() => setNotice('')}><Text style={{ color: '#b8e8c7', fontSize: 12, fontWeight: '800' }}>Dismiss</Text></Pressable></View></View>}
          <View style={styles.inner}>{body}</View>
        </ScrollView>
      </View>
    </View>
    <Modal visible={!!sourceReader} transparent animationType="fade" onRequestClose={() => setSourceReader(null)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <View style={[styles.card, { width: '100%', maxWidth: 820, maxHeight: '88%', gap: 14, backgroundColor: '#0b1913', borderColor: 'rgba(143,203,166,0.35)' }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ flex: 1, gap: 5 }}><Text style={styles.label}>SOURCE READER</Text><Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800' }}>{sourceReader?.title}</Text><Text style={{ color: '#b8e8c7', fontSize: 13, fontWeight: '700' }}>{sourceReader?.location}</Text></View>
            <ActionButton compact secondary label="Close" onPress={() => setSourceReader(null)} />
          </View>
          <ScrollView style={{ flexShrink: 1 }}><Text selectable style={{ color: palette.ink, fontSize: 15, lineHeight: 25 }}>{sourceReader?.text}</Text></ScrollView>
          <Text style={styles.small}>This view shows extracted text from the uploaded file. Check the original document if layout or diagrams matter.</Text>
        </View>
      </View>
    </Modal>
  </View>;
}

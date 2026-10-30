import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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

type Match = { question: string; passage: string; overlap: number; passageIndex: number | null; manual?: boolean };
type StudyAttempt = { id: string; question: string; mode: Pace; outcome: 'correct' | 'missed' | 'self-rated-ready' | 'needs-review'; createdAt: string };
type SavedWorkspace = { version: 1; notes: string; questionsText: string; demoMaterial: boolean; matches: Match[]; attempted: number; correct: number; history: StudyAttempt[] };
type Pace = 'cram' | 'steady' | 'deep';
type Phase = 'module' | 'diagnostic' | 'review' | 'check';

const demoNotes = `CELLULAR RESPIRATION\n\nCells convert the chemical energy in glucose into ATP, the main energy currency used for cellular work. Cellular respiration has three major stages: glycolysis, the citric acid cycle, and oxidative phosphorylation.\n\nGlycolysis happens in the cytoplasm. One glucose molecule is split into two pyruvate molecules, producing a net gain of two ATP and two NADH. Oxygen is not required for glycolysis.\n\nWhen oxygen is available, pyruvate enters the mitochondrion and is converted to acetyl-CoA. The citric acid cycle takes place in the mitochondrial matrix. Each turn releases carbon dioxide and produces NADH, FADH2, and a small amount of ATP.\n\nOxidative phosphorylation occurs at the inner mitochondrial membrane. Electrons from NADH and FADH2 move through the electron transport chain. The energy pumps hydrogen ions across the membrane. As hydrogen ions flow through ATP synthase, the enzyme makes most of the ATP from one glucose molecule. Oxygen is the final electron acceptor and combines with hydrogen to form water.`;

const demoQuestions = `1. Where does glycolysis take place, and what is its net ATP yield?\n2. Which stage produces most of the ATP during cellular respiration?\n3. What is the final electron acceptor in the electron transport chain?`;
const storageKey = 'recall-loop.workspace.v1';
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

function buildMatches(notes: string, questions: string[]): Match[] {
  const passages = notes.split(/\n\s*\n/).map((s, index) => ({ passage: s.trim(), passageIndex: index + 1 })).filter(({ passage }) => passage.length > 45 && !/^[A-Z\s]+$/.test(passage));
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
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageReady, setStorageReady] = useState(Platform.OS !== 'web');

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<SavedWorkspace>;
        if (saved.version === 1 && typeof saved.notes === 'string' && typeof saved.questionsText === 'string') {
          setNotes(saved.notes);
          setQuestionsText(saved.questionsText);
          setDemoMaterial(saved.demoMaterial === true);
          setMatches(Array.isArray(saved.matches) ? saved.matches : buildMatches(saved.notes, splitQuestions(saved.questionsText)));
          setAttempted(Number.isFinite(saved.attempted) ? Number(saved.attempted) : 0);
          setCorrect(Number.isFinite(saved.correct) ? Number(saved.correct) : 0);
          setHistory(Array.isArray(saved.history) ? saved.history.filter((item): item is StudyAttempt => !!item && typeof item.id === 'string' && typeof item.question === 'string') : []);
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
      const saved: SavedWorkspace = { version: 1, notes, questionsText, demoMaterial, matches, attempted, correct, history };
      window.localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch {
      // Storage quota or browser privacy settings should not interrupt a study session.
    }
  }, [storageReady, notes, questionsText, demoMaterial, matches, attempted, correct, history]);

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

  const questionList = useMemo(() => splitQuestions(questionsText), [questionsText]);
  const hasStudyContent = notes.trim().length > 0 || questionList.length > 0;
  const currentQuestion = demoMaterial ? (demoQuiz[questionIndex % demoQuiz.length]?.question || 'What is the main idea of this module?') : (questionList[questionIndex] || 'What is the main idea of this module?');
  const currentDemoQuiz = demoQuiz[questionIndex % demoQuiz.length];
  const correctAnswer = currentDemoQuiz.correct;
  const hasNextQuestion = mode !== 'cram' && questionIndex < questionList.length - 1;
  const sourceParagraphs = notes.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean);
  const sourceOptions = sourceParagraphs.map((passage, index) => ({ passage, passageIndex: index + 1 })).filter(({ passage }) => passage.length > 45 && !/^[A-Z\s]+$/.test(passage));
  const moduleTitle = notes.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || 'Untitled module';
  const displayModuleTitle = demoMaterial ? 'Cellular respiration' : !hasStudyContent ? 'No study set yet' : moduleTitle.length > 52 ? `${moduleTitle.slice(0, 49)}…` : moduleTitle;
  const currentMatch = matches.find((match) => match.question === currentQuestion && (match.overlap > 0 || (match.manual && match.passageIndex !== null)));
  const linkedCount = matches.filter((match) => match.overlap > 0 || (match.manual && match.passageIndex !== null)).length;
  const reviewPassage = currentMatch?.passage || notes.split(/\n+/).map((part) => part.trim()).find((part) => part.length > 30) || 'Add notes to see the source passage here.';
  const openSourcePassage = () => {
    setPhase('review');
  };
  const stepMatchSource = (question: string, direction: number) => setMatches((previous) => previous.map((match) => {
    if (match.question !== question || !sourceOptions.length) return match;
    const current = sourceOptions.findIndex((option) => option.passageIndex === match.passageIndex);
    const next = current === -1 ? 0 : (current + direction + sourceOptions.length) % sourceOptions.length;
    return { ...match, passage: sourceOptions[next].passage, passageIndex: sourceOptions[next].passageIndex, overlap: 0, manual: true };
  }));
  const clearMatchSource = (question: string) => setMatches((previous) => previous.map((match) => match.question === question ? { ...match, passage: 'No source link selected. Review manually or choose a paragraph.', passageIndex: null, overlap: 0, manual: true } : match));

  const notify = (message: string) => {
    if (Platform.OS === 'web') setNotice(message);
    else Alert.alert('StudyLoop', message);
  };

function GlassCard({ children, style, dark = false }: { children: React.ReactNode; style?: any; dark?: boolean }) {
  return <BlurView tint={dark ? 'dark' : 'light'} intensity={dark ? 40 : 48} blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : 'none'} testID="torch-block" style={[styles.card, dark && { backgroundColor: 'rgba(22,42,53,0.68)', borderColor: 'rgba(255,255,255,0.28)' }, style]}>{children}</BlurView>;
}

  const importFile = async (kind: 'module' | 'questions') => {
    try {
      setBusy(true);
      if (Platform.OS !== 'web') {
        notify('Browser file upload is in this prototype. Native Android file picking will be added when we package the app.');
        return;
      }
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = '.txt,.md,.markdown,text/plain,text/markdown';
      const file = await new Promise<File | null>((resolve) => {
        picker.onchange = () => resolve(picker.files?.[0] || null);
        picker.click();
      });
      if (!file) return;
      const content = await file.text();
      if (kind === 'module') setNotes(content); else setQuestionsText(content);
      setDemoMaterial(false);
      setFileName(file.name);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read that file. Try pasting the text instead.');
    } finally {
      setBusy(false);
    }
  };

  const matchQuestions = () => {
    const next = buildMatches(notes, questionList);
    setMatches(next);
    setPage('import');
  };

  const generateQuestions = () => {
    const drafts = draftPracticeQuestions(notes);
    if (!drafts.length) {
      notify('No question patterns were detected. Add complete explanatory sentences or write questions manually.');
      return;
    }
    const numbered = drafts.map((question, index) => `${index + 1}. ${question}`).join('\n');
    setQuestionsText(numbered);
    setDemoMaterial(false);
    setMatches(buildMatches(notes, drafts));
    notify(`${drafts.length} practice question drafts added. They were generated locally from text patterns, so review and edit them before studying.`);
  };

  const clearWorkspace = () => {
    setNotes(''); setQuestionsText(''); setMatches([]); setAttempted(0); setCorrect(0); setHistory([]);
    setDemoMaterial(false); setFileName(''); setNotice('Your workspace is empty. Add notes and questions whenever you’re ready.');
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
    {answer !== null && (answer !== correctAnswer ? <ActionButton label={currentMatch ? `Open source · paragraph ${currentMatch.passageIndex} →` : 'Review notes manually →'} onPress={openSourcePassage} /> : <ActionButton label={phase === 'diagnostic' ? 'Review the key passage →' : hasNextQuestion ? 'Next question →' : 'Finish session →'} onPress={continueSession} />)}
  </View> : <View style={[styles.card, { gap: 16 }]}><Text style={styles.label}>{phase === 'diagnostic' ? 'BEFORE REVIEW · YOUR QUESTION' : 'AFTER REVIEW · YOUR QUESTION'}</Text><Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800', lineHeight: 28 }}>{currentQuestion}</Text><Text style={styles.body}>Try answering from memory. This prototype records your self-rating; it does not claim to grade custom answers yet.</Text>
    <TextInput value={answerDraft} onChangeText={setAnswerDraft} multiline placeholder="Type a short answer or key points…" placeholderTextColor="#9ba6ad" style={[styles.input, { minHeight: 90 }]} />
    <Text style={styles.label}>HOW DID THAT FEEL?</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton compact label="I could explain it" onPress={() => submitAnswer(1)} /><ActionButton compact secondary label="Not sure yet" onPress={() => submitAnswer(0)} /></View>
    {answer !== null && <View style={{ padding: 13, borderRadius: 11, backgroundColor: answer === 1 ? 'rgba(33,129,91,0.20)' : 'rgba(245,216,94,0.12)', borderWidth: 1, borderColor: answer === 1 ? 'rgba(67,201,130,0.42)' : 'rgba(245,216,94,0.32)' }}><Text style={{ color: answer === 1 ? '#8ce0ae' : '#fff2ad', fontWeight: '800' }}>{answer === 1 ? 'Self-rated: ready to move on.' : 'Self-rated: prioritize this for review.'}</Text><Text style={[styles.small, { marginTop: 4 }]}>{answer === 1 ? 'Your answer is recorded as ready based on your self-rating.' : 'You marked this as uncertain. Revisit the matched source, then try recalling it again.'}</Text></View>}
    {answer !== null && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}><ActionButton label={answer === 0 ? (currentMatch?.passageIndex ? `Open source · paragraph ${currentMatch.passageIndex} →` : 'Review notes manually →') : phase === 'diagnostic' ? 'Review the linked passage →' : hasNextQuestion ? 'Next question →' : 'Finish session →'} onPress={answer === 0 || phase === 'diagnostic' ? openSourcePassage : continueSession} />{answer === 0 && phase === 'check' && <ActionButton secondary label={hasNextQuestion ? 'Next question' : 'Finish session'} onPress={continueSession} />}</View>}
  </View>;

  const reviewPanel = <View style={[styles.card, { gap: 16 }]}><View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><View><Text style={styles.label}>{phase === 'module' ? 'DEEP MODE · FULL MODULE' : currentMatch?.manual ? 'MANUAL SOURCE · VERIFY THIS LINK' : currentMatch ? 'YELLOW = LINKED TO YOUR FORMATIVE' : 'NO AUTOMATIC QUESTION LINK'}</Text><Text style={{ color: palette.ink, fontWeight: '800', fontSize: 20, marginTop: 6 }}>{phase === 'module' ? 'Read the full module first' : 'Read the relevant part first'}</Text>{currentMatch?.passageIndex && <Text style={[styles.small, { marginTop: 5 }]}>{currentMatch.manual ? 'Manually selected' : phase === 'module' ? 'Linked source' : 'Suggested source'} · paragraph {currentMatch.passageIndex}</Text>}</View>{phase !== 'module' && <View style={{ backgroundColor: currentMatch ? palette.blueSoft : '#f2f3ef', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' }}><Text style={{ color: currentMatch ? '#386174' : palette.muted, fontSize: 11, fontWeight: '800' }}>{currentMatch?.manual ? 'MANUAL LINK · VERIFY' : currentMatch ? 'EVIDENCE LINK · NOT A PREDICTION' : 'REVIEW SOURCE MANUALLY'}</Text></View>}</View>
    {phase === 'module' ? <View style={{ gap: 10 }}>{sourceParagraphs.map((paragraph, index) => { const isMatch = currentMatch?.passageIndex === index + 1; return <View key={`module-${index}`} style={{ backgroundColor: isMatch ? 'rgba(245,216,94,0.08)' : 'transparent', borderLeftWidth: isMatch ? 3 : 0, borderLeftColor: palette.yellow, borderRadius: 10, padding: isMatch ? 12 : 5, gap: 6 }}>{isMatch && <Text style={{ color: '#fff2ad', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 }}>LIKELY SOURCE · PARAGRAPH {index + 1}</Text>}{isMatch ? highlightedPassage(paragraph, currentQuestion) : <Text style={{ color: palette.ink, fontSize: 15, lineHeight: 25 }}>{paragraph}</Text>}</View>; })}</View> : currentMatch ? highlightedPassage(reviewPassage, currentQuestion) : <Text style={{ color: palette.ink, fontSize: 15, lineHeight: 26 }}>{reviewPassage}</Text>}
    {phase !== 'module' && currentMatch && <Text style={[styles.small, { marginBottom: -7 }]}>Stronger gold marks a likely answer phrase when detected · softer gold marks related question terms.</Text>}
    <View style={{ backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 14, gap: 6 }}><Text style={styles.label}>TERMS FROM THE QUESTION</Text><Text style={{ color: palette.ink, fontSize: 14, lineHeight: 22, fontWeight: '700' }}>{terms(currentQuestion).slice(0, 6).join(' · ') || 'No key terms detected'}</Text></View>
    {phase !== 'module' && currentMatch && <View style={{ backgroundColor: 'rgba(245,216,94,0.10)', borderColor: 'rgba(245,216,94,0.28)', borderWidth: 1, borderRadius: 11, padding: 12 }}><Text style={{ color: '#fff2ad', fontSize: 13, fontWeight: '800' }}>Matched formative question</Text><Text style={{ color: palette.ink, fontSize: 13, marginTop: 4 }}>{currentQuestion}</Text><Text style={[styles.small, { marginTop: 5 }]}>Suggested by shared keywords. Verify that this passage really supports the question.</Text></View>}
    {phase === 'module' ? <ActionButton label="Start with a quick diagnostic →" onPress={() => { setPhase('diagnostic'); setAnswer(null); }} /> : <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}><ActionButton label="I get it · quiz me" onPress={() => { setPhase('check'); setAnswer(null); setAnswerDraft(''); }} /><ActionButton label="Still confusing" secondary onPress={() => notify(demoMaterial ? 'Try it in your own words: glucose is split during glycolysis in the cytoplasm, leaving a net gain of two ATP.' : 'Alternate explanations are a planned AI feature. For now, reread the linked source or shorten your notes to one confusing idea.')} /></View>}
  </View>;

  const navItems = [
    { id: 'home' as const, icon: '⌂', label: 'Study home' },
    { id: 'import' as const, icon: '▤', label: 'My materials' },
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
  const home = <View style={[styles.content, { paddingTop: 10, gap: 0 }]}>
    <View testID="scroll-reveal" style={{ minHeight: 590, justifyContent: 'center', alignItems: 'center', paddingVertical: 56, gap: 20 }}>
      <View style={{ maxWidth: 780, alignItems: 'center', gap: 13 }}><Text style={[styles.label, { color: '#8fcba6', letterSpacing: 1.8 }]}>MAKE THIS SESSION YOURS</Text><Text style={[styles.title, { fontSize: wide ? 48 : 36, lineHeight: wide ? 58 : 44, textAlign: 'center' }]}>What do you want to do?</Text><Text style={[styles.body, { fontSize: 16, lineHeight: 25, textAlign: 'center', maxWidth: 610 }]}>Choose a study pace below, then add your notes and practice questions to begin.</Text></View>
      <View style={[styles.row, { width: '100%', maxWidth: 1000, marginTop: 16, justifyContent: 'center' }]}>{paceOptions.map((option) => { const active = selectedPace === option.id; return <Pressable key={option.id} onPress={() => setSelectedPace(option.id)} testID="torch-block" style={[styles.card, { flex: 1, minWidth: 240, maxWidth: 320, minHeight: 255, gap: 13, borderColor: palette.line, backgroundColor: active ? 'rgba(24,70,44,0.78)' : 'rgba(17,31,26,0.70)', padding: 20 }]}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={{ fontSize: 22, color: active ? '#9ff0ba' : palette.yellow }}>{option.icon}</Text><Text style={{ color: active ? '#d9ffe2' : palette.muted, fontSize: 11, fontWeight: '800' }}>{option.time.toUpperCase()}</Text></View><Text style={{ color: palette.ink, fontSize: 22, fontWeight: '800' }}>{option.title}</Text><Text style={[styles.body, { flex: 1 }]}>{option.description}</Text><Text style={{ color: active ? '#b8e8c7' : '#85948e', fontSize: 11, lineHeight: 17, fontWeight: '700' }}>{option.steps}</Text></Pressable>; })}</View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}><ActionButton label={hasStudyContent ? `Start ${selectedOption.time} ${selectedOption.title.toLowerCase()} session →` : 'Add materials to begin →'} onPress={() => hasStudyContent ? startStudy(selectedPace) : setPage('import')} /><Pressable onPress={() => setPage('import')} style={{ padding: 11 }}><Text style={{ color: '#b9c5c0', fontWeight: '700' }}>{hasStudyContent ? 'Choose materials' : 'Open My materials'}</Text></Pressable></View>
      <Text style={[styles.small, { textAlign: 'center' }]}>{hasStudyContent ? `${displayModuleTitle} · ${questionList.length} questions · ${linkedCount} source links to verify` : 'No notes or questions saved yet'}</Text>
    </View>

    <View testID="scroll-reveal" style={{ paddingVertical: 72, borderTopWidth: 1, borderColor: palette.line, gap: 22 }}><View style={{ maxWidth: 650, gap: 8 }}><Text style={[styles.label, { color: '#8fcba6' }]}>A STUDY LOOP THAT ADAPTS</Text><Text style={[styles.title, { fontSize: 32 }]}>One goal. A different path for each session.</Text></View><View style={styles.row}>{[{ n: '01', title: 'Choose your pace', text: 'Cram, steady, or deep. Your time sets the shape of the session.' }, { n: '02', title: 'Recall before rereading', text: 'See what you already know, then focus on what needs work.' }, { n: '03', title: 'Open the source', text: 'Missed a question? Jump to its matched paragraph and read the evidence.' }].map((item) => <View key={item.n} testID="torch-block" style={[styles.card, { flex: 1, minWidth: 210, gap: 10, padding: 20 }]}><Text style={{ color: palette.yellow, fontSize: 13, fontWeight: '900' }}>{item.n}</Text><Text style={{ color: palette.ink, fontSize: 17, fontWeight: '800' }}>{item.title}</Text><Text style={styles.body}>{item.text}</Text></View>)}</View></View>

    <View testID="scroll-reveal" style={{ paddingVertical: 64, borderTopWidth: 1, borderColor: palette.line, gap: 18 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}><View style={{ gap: 7 }}><Text style={[styles.label, { color: '#8fcba6' }]}>{hasStudyContent ? 'YOUR STUDY SET' : 'GET STARTED'}</Text><Text style={[styles.title, { fontSize: 30 }]}>{hasStudyContent ? 'Ready when you are.' : 'Your study space is empty.'}</Text></View><Pressable onPress={() => setPage('import')}><Text style={{ color: '#9fe1b5', fontWeight: '800' }}>{hasStudyContent ? 'Edit materials →' : 'Add materials →'}</Text></Pressable></View><View testID="torch-block" style={[styles.card, { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 18, padding: 22 }]}><View style={{ gap: 6, flex: 1, minWidth: 220 }}><Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800' }}>{displayModuleTitle}</Text><Text style={styles.body}>{hasStudyContent ? `${questionList.length} questions · ${linkedCount} suggested or selected passages` : 'Add notes and formative questions to build your first study set.'}</Text></View><ActionButton secondary label={hasStudyContent ? 'View progress' : 'Add materials'} onPress={() => setPage(hasStudyContent ? 'insights' : 'import')} /></View></View>
    <Text style={[styles.small, { textAlign: 'center', paddingVertical: 18 }]}>Recall Loop · v0.1 · {demoMaterial ? 'sample content' : 'local workspace'}</Text>
  </View>;

  const importScreen = <View style={styles.content}>
    <View><Text style={styles.label}>BUILD YOUR STUDY SET</Text><Text style={[styles.title, { marginTop: 7 }]}>Bring your materials</Text><Text style={[styles.body, { marginTop: 7, maxWidth: 700 }]}>Paste notes and formative questions, or upload plain-text files. Your workspace saves on this browser. Matching and question drafts use transparent local rules, not a connected AI service.</Text></View>
    <View style={styles.row}>
      <View testID="torch-block" style={[styles.card, { flex: 1, minWidth: 290, gap: 12 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}><View><Text style={styles.label}>01 · MODULE / NOTES</Text><Text style={{ fontSize: 17, color: palette.ink, fontWeight: '800', marginTop: 5 }}>Your source material</Text></View><ActionButton compact secondary label="Upload .txt / .md" onPress={() => importFile('module')} /></View>
        <TextInput value={notes} onChangeText={(value) => { setNotes(value); setDemoMaterial(false); }} multiline placeholder="Paste module text here…" placeholderTextColor="#9ba6ad" style={styles.input} />
        {!!fileName && <Text style={styles.small}>Last selected: {fileName}</Text>}
      </View>
      <View testID="torch-block" style={[styles.card, { flex: 1, minWidth: 290, gap: 12 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}><View><Text style={styles.label}>02 · FORMATIVE QUESTIONS</Text><Text style={{ fontSize: 17, color: palette.ink, fontWeight: '800', marginTop: 5 }}>What you were asked</Text></View><ActionButton compact secondary label="Upload .txt / .md" onPress={() => importFile('questions')} /></View>
        <TextInput value={questionsText} onChangeText={(value) => { setQuestionsText(value); setDemoMaterial(false); }} multiline placeholder="One question per line…" placeholderTextColor="#9ba6ad" style={styles.input} />
        <Text style={styles.small}>Use questions and modules you have permission to use. Keep each question on its own line for this prototype.</Text>
      </View>
    </View>
    <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}><ActionButton label={busy ? 'Reading file…' : 'Match questions to module'} onPress={matchQuestions} /><ActionButton label="Draft questions from notes" secondary onPress={generateQuestions} /><ActionButton label="Use demo material" secondary onPress={() => { setNotes(demoNotes); setQuestionsText(demoQuestions); setFileName(''); setDemoMaterial(true); setMatches(buildMatches(demoNotes, splitQuestions(demoQuestions))); }} /><ActionButton label="Clear workspace" secondary onPress={clearWorkspace} /></View>
    <Text style={styles.small}>Drafts are created with local sentence patterns; inspect them before use. Uploaded or pasted text stays in this browser workspace.</Text>
    <View testID="torch-block" style={[styles.card, { gap: 14 }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}><View><Text style={styles.label}>MATCH REVIEW</Text><Text style={{ color: palette.ink, fontSize: 19, fontWeight: '800', marginTop: 5 }}>Check the evidence before studying</Text></View><View style={{ backgroundColor: palette.yellowSoft, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6 }}><Text style={{ color: '#705d00', fontSize: 11, fontWeight: '800' }}>KEYWORD BASELINE</Text></View></View>
      {matches.map((match, i) => <View key={`${i}-${match.question}`} style={{ borderTopWidth: 1, borderColor: palette.line, paddingTop: 12, gap: 7 }}><Text style={{ color: palette.ink, fontWeight: '800', fontSize: 14 }}>Q{i + 1}. {match.question}</Text><View style={{ backgroundColor: match.overlap ? 'rgba(245,216,94,0.10)' : 'rgba(255,255,255,0.04)', borderLeftWidth: match.overlap ? 3 : 1, borderLeftColor: match.overlap ? 'rgba(245,216,94,0.76)' : palette.line, borderRadius: 9, padding: 11 }}><Text style={{ color: palette.ink, fontSize: 13, lineHeight: 19 }}>{match.passage}</Text></View><Text style={styles.small}>{match.manual ? (match.passageIndex ? `Manual source · paragraph ${match.passageIndex}` : 'Source link cleared · choose a paragraph or review manually') : match.overlap ? `Suggested source · ${match.overlap} shared key term${match.overlap === 1 ? '' : 's'} · please verify` : 'No automatic link · manual review needed'}</Text>{sourceOptions.length > 0 && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}><ActionButton compact secondary label="Previous source" onPress={() => stepMatchSource(match.question, -1)} /><ActionButton compact secondary label="Next source" onPress={() => stepMatchSource(match.question, 1)} />{match.passageIndex !== null && <ActionButton compact secondary label="Clear link" onPress={() => clearMatchSource(match.question)} />}</View>}</View>)}
      {!matches.length && <Text style={styles.body}>Add a few questions, then match them to see suggested passages.</Text>}
    </View>
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
  </View>;
}

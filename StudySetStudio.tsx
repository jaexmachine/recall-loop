import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { AiStudySet } from './ai';
import { flashcardCsv, quizCsv } from './studySetCsv';

type Props = {
  subjectName: string;
  materialCount: number;
  materialText: string;
  sourceHash: string;
  questions: string[];
  apiKeyConnected: boolean;
  providerName: string;
  studySet?: AiStudySet;
  onConnectKey: () => void;
  onGenerate: () => Promise<AiStudySet>;
  onSave: (studySet: AiStudySet) => void;
};

const colors = { ink: '#f3f6f4', muted: '#aab8b5', line: 'rgba(220,245,230,0.15)', green: '#21815b', yellow: '#f5d85e' };

function exportCsv(fileName: string, value: string) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const safeName = fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
  const url = URL.createObjectURL(new Blob([value], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ControlButton({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 11, borderWidth: secondary ? 1 : 0, borderColor: colors.line, backgroundColor: disabled ? 'rgba(255,255,255,0.04)' : secondary ? 'rgba(255,255,255,0.06)' : colors.green, opacity: disabled ? 0.48 : 1 }}><Text style={{ color: disabled ? colors.muted : colors.ink, fontWeight: '800', fontSize: 13 }}>{label}</Text></Pressable>;
}

export function StudySetStudio({ subjectName, materialCount, materialText, sourceHash, questions, apiKeyConnected, providerName, studySet, onConnectKey, onGenerate, onSave }: Props) {
  const currentSet = studySet?.sourceHash === sourceHash ? studySet : undefined;
  const [mode, setMode] = useState<'cards' | 'quiz'>('cards');
  const [cardIndex, setCardIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [quizIndex, setQuizIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setCardIndex(0); setShowAnswer(false); setQuizIndex(0); setSelectedOption(null); setChecked(false);
  }, [studySet]);

  const generate = async () => {
    if (!apiKeyConnected) { onConnectKey(); return; }
    setError(''); setBusy(true);
    try { onSave(await onGenerate()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create this study set. Try again.'); }
    finally { setBusy(false); }
  };

  const activeCard = currentSet?.cards[cardIndex];
  const activeQuestion = currentSet?.quiz[quizIndex];
  const panel = { borderRadius: 15, borderWidth: 1, borderColor: colors.line, backgroundColor: 'rgba(5,14,11,0.38)', padding: 16, gap: 11 } as const;

  return <View testID="torch-block" style={{ borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: 'rgba(17,31,26,0.70)', padding: 20, gap: 16 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
      <View style={{ flex: 1, minWidth: 210, gap: 5 }}><Text style={{ color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1.1 }}>AI STUDY STUDIO</Text><Text style={{ color: colors.ink, fontSize: 21, fontWeight: '800' }}>Build a study set</Text><Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>{materialCount ? `${materialCount} selected · ${questions.length ? `${questions.length} questions to prioritize` : 'questions made from your material'}` : 'Select sources to begin.'}</Text></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><ControlButton secondary label={apiKeyConnected ? `${providerName} connected` : 'Connect AI'} onPress={onConnectKey} /><ControlButton disabled={busy || materialCount === 0 || materialText.trim().length < 40} label={busy ? 'Building…' : currentSet ? 'Refresh set' : apiKeyConnected ? 'Generate set' : 'Connect AI & generate'} onPress={() => void generate()} /></View>
    </View>
    {!materialCount && <Text style={{ color: '#ffe49a', fontSize: 13 }}>Choose sources in the Sources tab. Only selected notes and files are sent for this set.</Text>}
    {!!error && <Text accessibilityRole="alert" style={{ color: '#ffc2aa', fontSize: 13, lineHeight: 19 }}>{error}</Text>}
    {currentSet ? <View style={{ gap: 14 }}>
      <View style={panel}><Text style={{ color: colors.yellow, fontSize: 11, fontWeight: '900', letterSpacing: 1 }}>STUDY REPORT · {subjectName.toUpperCase()}</Text><Text style={{ color: colors.ink, fontSize: 18, fontWeight: '800' }}>{currentSet.title}</Text><Text style={{ color: '#d7e1dc', fontSize: 14, lineHeight: 21 }}>{currentSet.report}</Text></View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 7 }}><ControlButton secondary={mode !== 'cards'} label={`Flashcards · ${currentSet.cards.length}`} onPress={() => { setMode('cards'); setShowAnswer(false); }} /><ControlButton secondary={mode !== 'quiz'} label={`Quiz · ${currentSet.quiz.length}`} onPress={() => setMode('quiz')} /></View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{mode === 'cards' ? <ControlButton secondary label="Export flashcards CSV" onPress={() => exportCsv(`${subjectName}-flashcards.csv`, flashcardCsv(currentSet))} /> : <ControlButton secondary label="Export quiz CSV" onPress={() => exportCsv(`${subjectName}-quiz.csv`, quizCsv(currentSet))} />}</View>
      </View>
      {mode === 'cards' && activeCard && <View style={[panel, { minHeight: 250, justifyContent: 'space-between' }]}>
        <View style={{ gap: 10 }}><Text style={{ color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 }}>CARD {cardIndex + 1} OF {currentSet.cards.length} · FRONT</Text><Text style={{ color: colors.ink, fontSize: 20, lineHeight: 29, fontWeight: '700' }}>{activeCard.front}</Text></View>
        {showAnswer ? <View style={{ borderTopWidth: 1, borderColor: colors.line, paddingTop: 12, gap: 8 }}><Text style={{ color: '#d7e1dc', fontSize: 15, lineHeight: 23 }}>{activeCard.back}</Text>{activeCard.evidence ? <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>“{activeCard.evidence}”</Text> : <Text style={{ color: '#ffe49a', fontSize: 12, lineHeight: 18 }}>Check the original source for supporting evidence.</Text>}<Text style={{ color: '#9fe1b5', fontSize: 12, fontWeight: '800' }}>{activeCard.source}</Text></View> : <Text style={{ color: colors.muted, fontSize: 13 }}>Recall the answer, then reveal it.</Text>}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><ControlButton secondary disabled={cardIndex === 0} label="← Previous" onPress={() => { setCardIndex((index) => Math.max(0, index - 1)); setShowAnswer(false); }} /><ControlButton label={showAnswer ? (cardIndex === currentSet.cards.length - 1 ? 'Start again' : 'Next card →') : 'Reveal answer'} onPress={() => { if (!showAnswer) setShowAnswer(true); else { setCardIndex((index) => index === currentSet.cards.length - 1 ? 0 : index + 1); setShowAnswer(false); } }} /></View>
      </View>}
      {mode === 'quiz' && activeQuestion && <View style={[panel, { gap: 13 }]}>
        <View style={{ gap: 7 }}><Text style={{ color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 }}>QUESTION {quizIndex + 1} OF {currentSet.quiz.length}</Text><Text style={{ color: colors.ink, fontSize: 18, lineHeight: 26, fontWeight: '700' }}>{activeQuestion.question}</Text></View>
        <View style={{ gap: 8 }}>{activeQuestion.options.map((option, index) => {
          const isSelected = selectedOption === index;
          const isCorrect = option === activeQuestion.answer;
          const borderColor = checked && isCorrect ? 'rgba(90,210,141,0.65)' : checked && isSelected ? 'rgba(217,120,91,0.65)' : isSelected ? 'rgba(90,210,141,0.55)' : colors.line;
          return <Pressable key={`${index}-${option}`} accessibilityRole="radio" accessibilityState={{ checked: isSelected }} disabled={checked} onPress={() => setSelectedOption(index)} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 11, borderWidth: 1, borderColor, backgroundColor: isSelected || (checked && isCorrect) ? 'rgba(33,129,91,0.18)' : 'rgba(255,255,255,0.025)', padding: 11 }}><Text style={{ width: 24, height: 24, textAlign: 'center', textAlignVertical: 'center', borderRadius: 8, color: isSelected ? colors.ink : colors.muted, backgroundColor: isSelected ? colors.green : 'rgba(255,255,255,0.06)', fontSize: 12, fontWeight: '900' }}>{String.fromCharCode(65 + index)}</Text><Text style={{ flex: 1, color: '#e4ece7', fontSize: 14, lineHeight: 20 }}>{option}</Text>{checked && isCorrect && <Text style={{ color: '#9fe1b5', fontWeight: '900' }}>✓</Text>}</Pressable>;
        })}</View>
        {checked && <View style={{ borderLeftWidth: 2, borderColor: '#9fe1b5', paddingLeft: 11, gap: 5 }}><Text style={{ color: selectedOption !== null && activeQuestion.options[selectedOption] === activeQuestion.answer ? '#9fe1b5' : '#ffe49a', fontSize: 13, fontWeight: '900' }}>{selectedOption !== null && activeQuestion.options[selectedOption] === activeQuestion.answer ? 'Correct' : `Answer: ${activeQuestion.answer}`}</Text><Text style={{ color: '#d7e1dc', fontSize: 13, lineHeight: 19 }}>{activeQuestion.explanation}</Text><Text style={{ color: colors.muted, fontSize: 12 }}>{activeQuestion.source}</Text></View>}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>{checked ? <ControlButton label={quizIndex === currentSet.quiz.length - 1 ? 'Restart quiz' : 'Next question →'} onPress={() => { setQuizIndex((index) => index === currentSet.quiz.length - 1 ? 0 : index + 1); setSelectedOption(null); setChecked(false); }} /> : <ControlButton disabled={selectedOption === null} label="Check answer" onPress={() => setChecked(true)} />}</View>
      </View>}
    </View> : <View style={panel}><Text style={{ color: colors.ink, fontSize: 15, fontWeight: '700' }}>One source-grounded set, ready to study or export.</Text><Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>Generate flashcards with answers and evidence, plus a playable multiple-choice quiz. Quiz questions you have already added help guide what gets covered.</Text></View>}
    <Text style={{ color: colors.muted, fontSize: 11, lineHeight: 16 }}>Selected text goes to {providerName} when you generate. Your key stays in this tab.</Text>
  </View>;
}

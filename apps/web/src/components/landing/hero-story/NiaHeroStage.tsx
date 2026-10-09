import type { RefObject } from 'react';
import NiaGlobe from './NiaGlobe';
import ExtractScene from './scenes/ExtractScene';
import TransformScene from './scenes/TransformScene';
import LoadScene from './scenes/LoadScene';
import MoveScene from './scenes/MoveScene';
import TransitionLight from './scenes/TransitionLight';
import TheRow from './scenes/TheRow';
import HeroHeadline from './HeroHeadline';
import StageWords from './StageWords';
import ChapterCards from './ChapterCards';
import NiaHeroJourneyBar from './NiaHeroJourneyBar';

type NiaHeroStageProps = {
  trackRef: RefObject<HTMLDivElement>;
  stageRef: RefObject<HTMLDivElement>;
  windowRef: RefObject<HTMLSpanElement>;
  chapter: number;
  status: string;
};

// The scroll-jacked story stage: #nx-track (tall scroll runway) wrapping a
// sticky #nx-stage that holds all 4 chapter scenes plus hero copy. Order of
// scene layers/z-index matches designs/nia-hero/index.html lines 104-428.
export default function NiaHeroStage({ trackRef, stageRef, windowRef, chapter, status }: NiaHeroStageProps) {
  return (
    <div ref={trackRef} id="nx-track" style={{ position: 'relative', height: 8400 }}>
      <div ref={stageRef} id="nx-stage" style={{ position: 'sticky', top: 0, height: '100vh', minHeight: 600, overflow: 'hidden', background: '#000000' }}>
        <NiaGlobe />
        <ExtractScene />
        <TransformScene />
        <LoadScene />
        <MoveScene />
        <TransitionLight />
        <TheRow />
        <HeroHeadline windowRef={windowRef} />
        <StageWords />
        <ChapterCards />
        <NiaHeroJourneyBar chapter={chapter} status={status} />
      </div>
    </div>
  );
}

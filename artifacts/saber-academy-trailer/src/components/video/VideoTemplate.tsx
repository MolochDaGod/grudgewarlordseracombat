import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';

export const SCENE_DURATIONS = {
  intro: 4000,
  champion: 4500,
  skills: 4000,
  modes: 4500,
  outro: 4500
};

const SCENE_COMPONENTS: Record<string, React.ComponentType> = {
  intro: Scene1,
  champion: Scene2,
  skills: Scene3,
  modes: Scene4,
  outro: Scene5,
};

const SCENE_START_SEC: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  let cumulativeMs = 0;
  for (const [key, ms] of Object.entries(SCENE_DURATIONS)) {
    out[key] = cumulativeMs / 1000;
    cumulativeMs += ms;
  }
  return out;
})();

const AUDIO_SEEK_EPSILON_SEC = 0.18;

export default function VideoTemplate({
  durations = SCENE_DURATIONS,
  loop = true,
  muted = false,
  onSceneChange,
}: {
  durations?: Record<string, number>;
  loop?: boolean;
  muted?: boolean;
  onSceneChange?: (sceneKey: string) => void;
} = {}) {
  const { currentSceneKey } = useVideoPlayer({ durations, loop });

  useEffect(() => {
    onSceneChange?.(currentSceneKey);
  }, [currentSceneKey, onSceneChange]);

  const baseSceneKey = currentSceneKey.replace(/_r[12]$/, '') as keyof typeof SCENE_DURATIONS;
  const sceneIndex = Object.keys(SCENE_DURATIONS).indexOf(baseSceneKey);
  const SceneComponent = SCENE_COMPONENTS[baseSceneKey];

  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = 0.45;
    const targetTime = SCENE_START_SEC[baseSceneKey] ?? 0;
    if (Math.abs(audio.currentTime - targetTime) > AUDIO_SEEK_EPSILON_SEC) {
      audio.currentTime = targetTime;
    }
    audio.play().catch(() => {});
  }, [currentSceneKey, baseSceneKey, muted]);

  return (
    <div className="w-full h-screen overflow-hidden relative bg-black text-white">
      {/* Persistent Background Layer */}
      <div className="absolute inset-0 z-0">
        <video 
          className="absolute inset-0 w-full h-full object-cover opacity-30 mix-blend-screen"
          src={`${import.meta.env.BASE_URL}videos/temple.mp4`}
          autoPlay
          muted
          loop
          playsInline
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-[#020617]/50" />
      </div>

      {/* Persistent Midground Accent */}
      <motion.div 
        className="absolute top-0 right-0 w-[80vw] h-[80vw] rounded-full blur-[120px] mix-blend-screen pointer-events-none z-0"
        style={{ background: 'radial-gradient(circle, rgba(70, 215, 255, 0.2), transparent)' }}
        animate={{
          x: ['20vw', '10vw', '-20vw', '-10vw', '30vw'][sceneIndex] || '0vw',
          y: ['-20vh', '10vh', '-10vh', '30vh', '-20vh'][sceneIndex] || '0vh',
          scale: [1, 1.2, 0.8, 1.4, 1][sceneIndex] || 1,
        }}
        transition={{ duration: 2, ease: [0.16, 1, 0.3, 1] }}
      />
      
      {/* Persistent Technical Grid */}
      <div className="absolute inset-0 z-0 opacity-10 pointer-events-none"
           style={{ backgroundImage: 'linear-gradient(rgba(70, 215, 255, 0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(70, 215, 255, 0.5) 1px, transparent 1px)', backgroundSize: '100px 100px' }} />

      {/* Scene Content */}
      <div className="relative z-10 w-full h-full">
        <AnimatePresence mode="popLayout">
          {SceneComponent && <SceneComponent key={currentSceneKey} />}
        </AnimatePresence>
      </div>

      <audio
        ref={audioRef}
        src={`${import.meta.env.BASE_URL}audio/bg_music.mp3`}
        preload="auto"
        autoPlay
        muted={muted}
      />
    </div>
  );
}
